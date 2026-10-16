import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:https";
import { resolve } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { WebSocket } from "ws";
import { encodeMessage, decodeMessage } from "@soldat-web/protocol";
import type { Message, LobbyState } from "@soldat-web/protocol";
import { SPRITE_FLAGS } from "@soldat-web/sim-host";
import type { SimHost } from "@soldat-web/sim-host";
import { createPlatformServer } from "../src/platform.ts";
import { AuthoritativeMatch } from "../src/match.ts";
import { qualificationConfig, RawPeer, delay } from "./support.ts";

const maps = [{ name: "Arena", mode: "dm", botCapable: true }, { name: "ctf_Ash", mode: "ctf", botCapable: true }] as const;
const config = await qualificationConfig(resolve("build-out/platform-tests"));
interface ApiResponse extends LobbyState { matchId: string; wsUrl: string; hostToken: string; bots: number }
interface ClientSample { type: string; player: number; error?: string; metrics?: { snapshotTick: number; snapshotHash: string; hashMismatches: number; hashMatches: number; snapshots: number; lastConsumedInputSeq: number } }
async function api<T = ApiResponse>(origin: string, path: string, data?: unknown, raw?: string, requestOrigin?: string): Promise<{ status: number; value: T; cors: string | undefined }> {
  const result = Promise.withResolvers<{ status: number; value: T; cors: string | undefined }>();
  const req = request(`${origin}${path}`, { rejectUnauthorized: false, method: data === undefined && raw === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(requestOrigin ? { Origin: requestOrigin } : {}) } }, response => {
    const chunks: Buffer[] = [];
    response.on("data", chunk => chunks.push(chunk));
    // The service under test owns these DTOs; assertions below verify their relevant fields.
    response.on("end", () => result.resolve({ status: response.statusCode!, value: JSON.parse(Buffer.concat(chunks).toString()) as T, cors: response.headers["access-control-allow-origin"]?.toString() }));
  });
  req.on("error", result.reject); req.end(raw ?? (data === undefined ? undefined : JSON.stringify(data)));
  return result.promise;
}
async function platform(extra: Partial<Parameters<typeof createPlatformServer>[0]> = {}) {
  const errors: string[] = [];
  const server = await createPlatformServer({ match: { ...config.match, rules: { mode: "dm", rng: "keyed", world: "original" } }, tls: config.tls, maps: [...maps], targetPlayers: 3, maxMatches: 2, port: 0, onError: error => errors.push(error.message), ...extra });
  const address = server.httpsServer.address(); assert.ok(address && typeof address !== "string");
  return { ...server, origin: `https://127.0.0.1:${address.port}`, errors };
}
class LobbyPeer {
  socket: WebSocket;
  messages: Message[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url, { rejectUnauthorized: false });
    this.socket.on("message", bytes => this.messages.push(decodeMessage(bytes as Buffer)));
    this.socket.on("error", () => {});
  }
  async join(nickname: string, hostToken?: string) {
    await once(this.socket, "open"); this.send({ type: "lobby-join", nickname, ...(hostToken ? { hostToken } : {}) });
    return this.state(state => state.players.some(player => player.nickname === nickname));
  }
  send(message: Message) { this.socket.send(encodeMessage(message)); }
  async state(predicate: (state: LobbyState) => boolean, start = 0): Promise<Extract<Message, { type: "lobby-state" }>> {
    for (let n = 0; n < 1000; n++) {
      const message = this.messages.slice(start).find((item): item is Extract<Message, { type: "lobby-state" }> => item.type === "lobby-state" && predicate(item.state));
      if (message) return message; await delay(5);
    }
    throw new Error("Lobby state timed out");
  }
  async error(start: number) {
    for (let n = 0; n < 1000; n++) { const message = this.messages.slice(start).find(item => item.type === "lobby-error"); if (message) return message; await delay(5); }
    throw new Error("Lobby rejection timed out");
  }
  async close() { if (this.socket.readyState === WebSocket.CLOSED) return; const closed = once(this.socket, "close"); this.socket.close(); await closed; }
}

test("quickplay leases fill lowest-load matches, create at capacity, and expire idle workers", { timeout: 60_000 }, async () => {
  const server = await platform({ targetPlayers: 2, idleMs: 1000, reservationMs: 2000 });
  try {
    const first = await api(server.origin, "/api/quickplay", { nickname: "One" });
    const second = await api(server.origin, "/api/quickplay", { nickname: "Two" });
    assert.equal(first.status, 201); assert.equal(second.value.matchId, first.value.matchId); assert.equal(second.value.bots, 0);
    const third = await api(server.origin, "/api/quickplay", { nickname: "Three" });
    assert.notEqual(third.value.matchId, first.value.matchId);
    const fourth = await api(server.origin, "/api/quickplay", { nickname: "Four" }); assert.equal(fourth.value.matchId, third.value.matchId);
    assert.equal((await api(server.origin, "/api/quickplay", { nickname: "Full" })).status, 503);
    await delay(4200);
    const fresh = await api(server.origin, "/api/quickplay", { nickname: "Fresh" }); assert.equal(fresh.status, 201); assert.notEqual(fresh.value.matchId, first.value.matchId);
    assert.deepEqual(server.errors, []);
  } finally { await server.close(); }
});

test("friend lobby host authority, ready, start, late join and leave use real WSS and WASM", { timeout: 60_000 }, async () => {
  const server = await platform(); const lobbyPeers: LobbyPeer[] = [], gamePeers: RawPeer[] = [];
  try {
    const created = await api(server.origin, "/api/lobbies", { mode: "dm", map: "Arena" }); assert.equal(created.status, 201);
    assert.match(created.value.code, /^[A-Z0-9]{6}$/);
    const host = new LobbyPeer(created.value.wsUrl); lobbyPeers.push(host); const initial = await host.join("Host", created.value.hostToken);
    assert.ok(initial.state.players.find(player => player.id === initial.selfId)?.host);
    const guest = new LobbyPeer(created.value.wsUrl); lobbyPeers.push(guest); await guest.join("Guest");
    let start = guest.messages.length; guest.send({ type: "lobby-update", map: "ctf_Ash", mode: "ctf" }); await guest.error(start);
    start = guest.messages.length; guest.send({ type: "lobby-start" }); await guest.error(start);
    start = host.messages.length; host.send({ type: "lobby-start" }); await host.error(start);
    host.send({ type: "lobby-update", mode: "ctf", map: "ctf_Ash", targetPlayers: 3 }); await guest.state(state => state.mode === "ctf");
    guest.send({ type: "lobby-ready", ready: true });
    await host.state(state => state.players.every(player => player.ready));
    start = guest.messages.length;
    host.send({ type: "lobby-update", targetPlayers: 3 });
    await guest.state(state => state.players.some(player => !player.host && !player.ready), start);
    start = host.messages.length;
    guest.send({ type: "lobby-ready", ready: true }); await host.state(state => state.players.every(player => player.ready), start);
    host.send({ type: "lobby-start" }); const started = await host.state(state => state.started); const guestStarted = await guest.state(state => state.started);
    for (const [nickname, state] of [["Host", started.state], ["Guest", guestStarted.state]] as const) { const peer = new RawPeer(state.matchWsUrl!); gamePeers.push(peer); await peer.connect(config.match.contentSetHash, nickname); }
    const late = new LobbyPeer(created.value.wsUrl); lobbyPeers.push(late); const lateState = await late.join("Late"); assert.ok(lateState.state.started);
    const lateGame = new RawPeer(lateState.state.matchWsUrl!); gamePeers.push(lateGame); await lateGame.connect(config.match.contentSetHash, "Late");
    assert.equal(new Set(gamePeers.flatMap(peer => peer.messages.filter(message => message.type === "welcome").map(message => message.slot))).size, 3);
    await lateGame.close(); await late.close(); await host.state(state => state.players.length === 2 && state.started);
    const replacement = new LobbyPeer(created.value.wsUrl); lobbyPeers.push(replacement); const rejoined = await replacement.join("Replacement");
    const replacementGame = new RawPeer(rejoined.state.matchWsUrl!); gamePeers.push(replacementGame); await replacementGame.connect(config.match.contentSetHash, "Replacement");
    await replacementGame.waitFor((message): message is Extract<Message, { type: "snapshot" }> => message.type === "snapshot");
    const fetched = await api(server.origin, `/api/lobbies/${created.value.code}`); assert.equal(fetched.value.started, true); assert.equal(fetched.value.hostToken, undefined);
    assert.equal(fetched.value.wsUrl, created.value.wsUrl);
    assert.ok(fetched.value.wsUrl.startsWith("wss://"));
    assert.equal(new URL(fetched.value.wsUrl).search, "");
    assert.deepEqual(server.errors, []);
  } finally { await Promise.all(gamePeers.map(peer => peer.close())); await Promise.all(lobbyPeers.map(peer => peer.close())); await server.close(); }
});

test("host capability, lobby socket validation, host departure and idle cleanup", { timeout: 30_000 }, async () => {
  const server = await platform({ idleMs: 100, maxMatches: 1 });
  const peers: LobbyPeer[] = [];
  try {
    const created = await api(server.origin, "/api/lobbies", { mode: "dm", map: "Arena" });
    const impostor = new LobbyPeer(created.value.wsUrl); peers.push(impostor);
    await once(impostor.socket, "open");
    const rejected = once(impostor.socket, "close");
    impostor.send({ type: "lobby-join", nickname: "Impostor", hostToken: "0".repeat(64) });
    await rejected;
    const host = new LobbyPeer(created.value.wsUrl); peers.push(host); await host.join("Host", created.value.hostToken);
    const guest = new LobbyPeer(created.value.wsUrl); peers.push(guest); await guest.join("Guest");
    const flooded = once(guest.socket, "close");
    for (let index = 0; index < 20; index++) guest.send({ type: "lobby-ready", ready: true });
    await flooded;
    const start = host.messages.length;
    host.socket.send(encodeMessage({ type: "input", frames: [{ seq: 1, tick: 0, viewTick: 0, input: new Uint8Array(12) }] }));
    await host.error(start);
    await host.close();
    assert.equal((await api(server.origin, `/api/lobbies/${created.value.code}`)).status, 404);
    const idle = await api(server.origin, "/api/lobbies", { mode: "dm", map: "Arena" });
    await delay(250);
    assert.equal((await api(server.origin, `/api/lobbies/${idle.value.code}`)).status, 404);
    const canceled = await api(server.origin, "/api/lobbies", { mode: "dm", map: "Arena" });
    const canceledHost = new LobbyPeer(canceled.value.wsUrl); peers.push(canceledHost);
    await canceledHost.join("Cancel", canceled.value.hostToken);
    canceledHost.send({ type: "lobby-start" }); await canceledHost.close();
    assert.equal((await api(server.origin, `/api/lobbies/${canceled.value.code}`)).status, 404);
    const available = await api(server.origin, "/api/quickplay", { nickname: "After cancel" });
    assert.equal(available.status, 201, "canceled worker creation must release the sole match slot");
    assert.deepEqual(server.errors, []);
  } finally { await Promise.all(peers.map(peer => peer.close())); await server.close(); }
});

test("configured private development origins are allowed explicitly, never by wildcard", async () => {
  const allowed = ["http://127.0.0.1:5198", "http://localhost:5199"];
  const server = await platform({ allowedOrigins: allowed });
  try {
    for (const origin of allowed) {
      const result = await api(server.origin, "/api/ping", undefined, undefined, origin);
      assert.equal(result.status, 200); assert.equal(result.cors, origin);
    }
    const denied = await api(server.origin, "/api/ping", undefined, undefined, "http://127.0.0.1:5200");
    assert.equal(denied.status, 403); assert.equal(denied.cors, undefined);
    assert.deepEqual(server.errors, []);
  } finally { await server.close(); }
  await assert.rejects(platform({ allowedOrigins: ["https://example.com/path"] }), /exact HTTP/);
  await assert.rejects(platform({ allowedOrigins: ["*"] }));
});

test("malformed, oversized, incompatible and abusive HTTP requests are rejected", async () => {
  const server = await platform({ maxLobbies: 1 });
  try {
    const ping = await api(server.origin, "/api/ping"); assert.equal(ping.status, 200);
    assert.deepEqual((await api<{ name: string }[]>(server.origin, "/api/regions")).value.map(region => region.name), ["Local"]);
    assert.equal((await api(server.origin, "/api/quickplay", undefined, "[")).status, 400);
    assert.equal((await api(server.origin, "/api/quickplay", { nickname: " bad " })).status, 400);
    assert.equal((await api(server.origin, "/api/quickplay", { nickname: "A", position: 123 })).status, 400);
    assert.equal((await api(server.origin, "/api/quickplay", undefined, " ".repeat(1025))).status, 413);
    assert.equal((await api(server.origin, "/api/lobbies", { mode: "ctf", map: "Arena" })).status, 400);
    assert.equal((await api(server.origin, "/api/lobbies", { mode: "dm", map: "../../Arena" })).status, 400);
    assert.equal((await api(server.origin, "/api/lobbies", { mode: "dm", map: "Arena" })).status, 201);
    assert.equal((await api(server.origin, "/api/lobbies", { mode: "dm", map: "Arena" })).status, 503);
    assert.equal((await api(server.origin, "/api/lobbies", { mode: "dm", map: "Arena" })).status, 429);
    assert.equal((await api(server.origin, "/api/lobbies/ABC123")).status, 404);
    assert.deepEqual(server.errors, []);
  } finally { await server.close(); }
});

for (const mode of ["dm", "ctf"] as const) test(`${mode}: bot replacement/refill keeps 32 slots and balanced teams with original rotating profiles`, { timeout: 30_000 }, async () => {
  const match = await AuthoritativeMatch.start({ ...config.match, map: mode === "ctf" ? "ctf_Ash" : "Arena", targetPlayers: 32, rules: { mode, world: "original", rng: "keyed" } }, () => {});
  const host = Reflect.get(match, "host") as SimHost;
  function population(humans: number) {
    const render = host.renderView(); assert.notEqual(typeof render, "number"); if (typeof render === "number") throw new Error("render failed");
    const sprites = Array.from({ length: 32 }, (_, i) => render.sprite(i)).filter(sprite => sprite.flags & SPRITE_FLAGS.active);
    assert.equal(sprites.length, 32); assert.equal(sprites.filter(sprite => !(sprite.flags & SPRITE_FLAGS.bot)).length, humans);
    if (mode === "ctf") assert.equal(sprites.filter(sprite => sprite.team === 1).length, 16);
    return sprites;
  }
  try {
    population(0);
    for (let slot = 1; slot <= 32; slot++) { match.receive({ type: "join", slot, name: `Human ${slot}`, weapon: 4, secondaryWeapon: 0 }, process.hrtime.bigint()); population(slot); }
    assert.throws(() => match.receive({ type: "join", slot: 33, weapon: 4, secondaryWeapon: 0 }, process.hrtime.bigint()), /slot/);
    for (let slot = 1; slot <= 32; slot++) { match.receive({ type: "leave", slot }, process.hrtime.bigint()); population(32 - slot); }
    assert.ok(population(0).every(sprite => sprite.playerName.length > 0));
    match.receive({ type: "join", slot: 1, weapon: 4, secondaryWeapon: 0 }, process.hrtime.bigint());
    const before = population(1).filter(sprite => sprite.flags & SPRITE_FLAGS.bot).map(sprite => sprite.playerName);
    match.receive({ type: "leave", slot: 1 }, process.hrtime.bigint());
    const after = population(0).map(sprite => sprite.playerName);
    assert.equal(after.filter(name => name === "Admiral").length, before.filter(name => name === "Admiral").length + 1);
  } finally { match.dispose(); }
});

test("three production headless clients share a real worker/WASM authoritative timeline", { timeout: 60_000 }, async context => {
  const server = await platform(); const workers: Worker[] = [], samples: ClientSample[] = [];
  try {
    for (let player = 1; player <= 3; player++) {
      const result = await api(server.origin, "/api/quickplay", { nickname: `Headless ${player}` }); assert.equal(result.status, 201);
      const worker = new Worker(new URL("./headless-worker.ts", import.meta.url), { workerData: { url: result.value.wsUrl, wasmPath: config.match.wasmPath, contentRoot: config.match.contentRoot, manifest: config.manifest, player, combat: false, stackedCombat: false, pickupCombat: false } });
      workers.push(worker); worker.on("message", sample => samples.push(sample));
      while (true) { const [sample] = await once(worker, "message", { signal: context.signal }); if (sample.type === "failure") throw new Error(sample.error); if (sample.type === "ready") break; }
    }
    while (!workers.every((_, index) => samples.filter(sample => sample.type === "snapshot" && sample.player === index + 1).length >= 15)) {
      const [sample] = await once(workers[2]!, "message", { signal: context.signal }); if (sample.type === "failure") throw new Error(sample.error);
    }
    for (let player = 1; player <= 3; player++) {
      const last = samples.filter(sample => sample.type === "snapshot" && sample.player === player).at(-1);
      assert.ok(last?.metrics);
      assert.equal(last.metrics.hashMismatches, 0); assert.equal(last.metrics.hashMatches, last.metrics.snapshots); assert.ok(last.metrics.lastConsumedInputSeq > 0);
    }
    const byTick = new Map<number, Map<number, string>>();
    for (const sample of samples) if (sample.type === "snapshot" && sample.metrics) {
      const peers = byTick.get(sample.metrics.snapshotTick) ?? new Map<number, string>();
      peers.set(sample.player, sample.metrics.snapshotHash); byTick.set(sample.metrics.snapshotTick, peers);
    }
    const shared = [...byTick.values()].filter(peers => peers.size === 3);
    assert.ok(shared.length >= 5, "three peers must observe common authoritative ticks");
    for (const peers of shared) assert.equal(new Set(peers.values()).size, 1);
    assert.deepEqual(server.errors, []);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); await server.close(); }
});
