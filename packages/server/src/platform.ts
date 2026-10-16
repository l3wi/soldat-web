import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";
import type { Server as HttpsServer, ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { decodeMessage, encodeMessage } from "@soldat-web/protocol";
import type { GameMode, LobbyState, LobbyPlayer, Message, Region } from "@soldat-web/protocol";
import { createGameServer } from "./server.ts";
import type { GameServer } from "./server.ts";
import type { MatchConfiguration } from "./worker-messages.ts";

export interface PlatformOptions {
  match: MatchConfiguration;
  tls: ServerOptions;
  host?: string;
  port?: number;
  /** Explicit public HTTPS origin, required behind a reverse proxy. Never trust Host. */
  publicUrl?: string;
  regions?: Region[];
  maps: { name: string; mode: GameMode; botCapable: boolean }[];
  targetPlayers?: number;
  maxMatches?: number;
  maxLobbies?: number;
  idleMs?: number;
  reservationMs?: number;
  allowedOrigins?: string[];
  onError?: (error: Error) => void;
}
interface MatchEntry {
  id: string; game: GameServer; mode: GameMode; map: string; target: number; public: boolean;
  idleSince: number; leases: Map<string, { nickname: string; expires: number }>;
}
interface Lobby {
  code: string; hostToken: string; state: LobbyState; peers: Map<string, WebSocket>;
  idleSince: number; starting: boolean; match?: MatchEntry; tickets: Map<string, string>;
}
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function validateNickname(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value !== value.trim() || /[\p{Cc}\p{Cf}]/u.test(value) || Buffer.byteLength(value) > 48 || !value.isWellFormed()) throw new HttpError(400, "Invalid nickname");
}
function objectBody(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected JSON object");
}
function keys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, "Unknown request field");
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "Expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON"); }
  objectBody(parsed); return parsed;
}

/** HTTPS control plane. Every registered match owns a separate existing worker/WASM. */
export async function createPlatformServer(options: PlatformOptions): Promise<{ httpsServer: HttpsServer; close(): Promise<void> }> {
  const target = options.targetPlayers ?? 8, maxMatches = options.maxMatches ?? 8, maxLobbies = options.maxLobbies ?? 128;
  const idleMs = options.idleMs ?? 5 * 60_000, reservationMs = options.reservationMs ?? 30_000;
  for (const [name, value, max] of [["targetPlayers", target, 32], ["maxMatches", maxMatches, 64], ["maxLobbies", maxLobbies, 4096]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  }
  if (!Number.isFinite(idleMs) || !Number.isFinite(reservationMs) || idleMs < 1 || reservationMs < 1) throw new Error("Invalid lifecycle timeout");
  if (options.regions !== undefined) {
    if (!Array.isArray(options.regions) || options.regions.length < 1 || options.regions.length > 32) throw new Error("Invalid regions configuration");
    const ids = new Set<string>();
    for (const region of options.regions) {
      if (!region || typeof region.id !== "string" || !/^[a-z0-9-]{1,32}$/.test(region.id) || ids.has(region.id) || typeof region.name !== "string" || !region.name.trim() || region.name.length > 64 || typeof region.url !== "string") throw new Error("Invalid region");
      const url = new URL(region.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Region URL must be an HTTPS origin");
      ids.add(region.id);
    }
  }
  if (!options.maps.length || !options.maps.some(map => map.mode === "dm" && map.botCapable)) throw new Error("A bot-capable DM map is required");
  const matches = new Map<string, MatchEntry>(), lobbies = new Map<string, Lobby>();
  const buckets = new Map<string, { tokens: number; at: number }>();
  let closing = false, rotation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation); queue = next.catch(() => {}); return next;
  };
  const report = options.onError ?? console.error;
  const server = createServer(options.tls, (request, response) => { void handle(request, response); });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.setMaxListeners(maxMatches + 10);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  let origin = options.publicUrl ? new URL(options.publicUrl).origin : "";
  if (origin && !origin.startsWith("https://")) throw new Error("publicUrl must use HTTPS");
  const wsOrigin = () => origin.replace(/^https:/, "wss:");
  const matchUrl = (match: MatchEntry) => `${wsOrigin()}/matches/${match.id}`;
  const validSetup = (mode: unknown, map: unknown): { mode: GameMode; map: string } => {
    if ((mode !== "dm" && mode !== "ctf") || typeof map !== "string" || !options.maps.some(item => item.name === map && item.mode === mode && item.botCapable)) throw new HttpError(400, "Select a bot-capable map for this mode");
    return { mode, map };
  };
  const expireLeases = (match: MatchEntry, now: number) => {
    for (const [token, lease] of match.leases) if (lease.expires <= now) match.leases.delete(token);
  };
  const load = (match: MatchEntry) => match.game.humanCount + match.leases.size;
  const reserve = (match: MatchEntry, nickname: string): string => {
    expireLeases(match, Date.now());
    if (!match.game.available || load(match) >= match.target) throw new HttpError(409, "Match full");
    const token = randomBytes(24).toString("hex");
    match.leases.set(token, { nickname, expires: Date.now() + reservationMs });
    match.idleSince = Date.now();
    return `${matchUrl(match)}?ticket=${token}`;
  };
  async function newMatch(mode: GameMode, map: string, population: number, isPublic: boolean): Promise<MatchEntry> {
    if (closing || matches.size >= maxMatches) throw new HttpError(503, "Match capacity reached");
    const id = randomUUID();
    let entry: MatchEntry;
    const game = await createGameServer({
      match: { ...options.match, map, rules: { ...options.match.rules, mode }, targetPlayers: population },
      httpsServer: server, path: `/matches/${id}`, ...(options.onError ? { onError: options.onError } : {}),
      authorize: request => {
        if (!entry || !entry.game.available || entry.game.humanCount >= entry.target) return false;
        const ticket = new URL(request.url!, origin).searchParams.get("ticket");
        if (!ticket) return false;
        const lease = entry.leases.get(ticket);
        if (!lease || lease.expires <= Date.now()) { entry.leases.delete(ticket); return false; }
        entry.leases.delete(ticket); return true;
      },
    });
    entry = { id, game, mode, map, target: population, public: isPublic, idleSince: Date.now(), leases: new Map() };
    matches.set(id, entry); return entry;
  }
  function broadcast(lobby: Lobby): void {
    for (const [selfId, peer] of lobby.peers) {
      const state = { ...lobby.state };
      // One ticket per lobby member, stable until consumed/expired. Do not expose other members' tickets.
      if (lobby.match) {
        const player = lobby.state.players.find(item => item.id === selfId)!;
        let ticket = lobby.tickets.get(selfId);
        if (!ticket && load(lobby.match) < lobby.match.target) {
          ticket = new URL(reserve(lobby.match, player.nickname)).searchParams.get("ticket")!;
          lobby.tickets.set(selfId, ticket);
        }
        state.matchWsUrl = ticket ? `${matchUrl(lobby.match)}?ticket=${ticket}` : matchUrl(lobby.match);
      }
      peer.send(encodeMessage({ type: "lobby-state", selfId, state }));
    }
  }
  function leave(lobby: Lobby, id: string): void {
    const player = lobby.state.players.find(item => item.id === id);
    lobby.peers.delete(id); lobby.state.players = lobby.state.players.filter(item => item.id !== id);
    lobby.idleSince = Date.now();
    const ticket = lobby.tickets.get(id);
    if (ticket) lobby.match?.leases.delete(ticket);
    lobby.tickets.delete(id);
    if (player?.host && !lobby.state.started) {
      // The capability stays with the original host; a stranger cannot take it by joining first.
      for (const peer of lobby.peers.values()) peer.close(1001, "Host left");
      lobbies.delete(lobby.code);
    } else broadcast(lobby);
  }
  function rateLimit(address: string): void {
    if (!buckets.has(address) && buckets.size >= 4096) throw new HttpError(429, "Creation rate limit capacity reached");
    const now = Date.now(), bucket = buckets.get(address) ?? { tokens: 8, at: now };
    bucket.tokens = Math.min(8, bucket.tokens + (now - bucket.at) / 10_000); bucket.at = now;
    buckets.set(address, bucket);
    if (bucket.tokens < 1) throw new HttpError(429, "Creation rate limit exceeded");
    bucket.tokens--;
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    const requestOrigin = request.headers.origin;
    const allowed = options.allowedOrigins ?? ["http://127.0.0.1:5195", "http://localhost:5195"];
    if (requestOrigin && (requestOrigin === origin || allowed.includes(requestOrigin))) {
      response.setHeader("Access-Control-Allow-Origin", requestOrigin); response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    try {
      if (requestOrigin && requestOrigin !== origin && !allowed.includes(requestOrigin)) throw new HttpError(403, "Origin not allowed");
      const path = new URL(request.url ?? "/", "https://localhost").pathname;
      if (request.method === "OPTIONS" && path.startsWith("/api/")) { response.writeHead(204); response.end(); return; }
      let result: unknown;
      if (request.method === "GET" && path === "/api/ping") result = { ok: true };
      else if (request.method === "GET" && path === "/api/regions") result = options.regions ?? [{ id: "local", name: "Local", url: origin }];
      else if (request.method === "GET" && /^\/api\/lobbies\/[A-Z0-9]{6}$/.test(path)) {
        const lobby = lobbies.get(path.split("/").at(-1)!);
        if (!lobby) throw new HttpError(404, "Lobby not found");
        result = lobby.state;
      } else if (request.method === "POST" && (path === "/api/quickplay" || path === "/api/lobbies")) {
        rateLimit(request.socket.remoteAddress ?? "unknown");
        const data = await body(request);
        if (path === "/api/quickplay") {
          keys(data, ["nickname"]); validateNickname(data.nickname);
          result = await serial(async () => {
            for (const match of matches.values()) expireLeases(match, Date.now());
            let match = [...matches.values()].filter(item => item.public && item.game.available && load(item) < item.target).sort((a, b) => load(a) - load(b))[0];
            if (!match) {
              const maps = options.maps.filter(item => item.mode === "dm" && item.botCapable);
              match = await newMatch("dm", maps[rotation++ % maps.length]!.name, target, true);
            }
            const wsUrl = reserve(match, data.nickname as string);
            return { matchId: match.id, wsUrl, map: match.map, mode: match.mode, humans: [...match.game.humans, ...[...match.leases.values()].map(lease => lease.nickname)], bots: Math.max(0, match.target - load(match)) };
          });
        } else {
          keys(data, ["mode", "map"]); const setup = validSetup(data.mode, data.map);
          if (lobbies.size >= maxLobbies) throw new HttpError(503, "Lobby capacity reached");
          let code: string;
          do { code = randomBytes(4).toString("hex").slice(0, 6).toUpperCase(); } while (lobbies.has(code));
          const hostToken = randomBytes(32).toString("hex");
          lobbies.set(code, { code, hostToken, peers: new Map(), tickets: new Map(), state: { code, ...setup, targetPlayers: target, players: [], started: false }, idleSince: Date.now(), starting: false });
          result = { code, hostToken, wsUrl: `${wsOrigin()}/lobbies/${code}` };
        }
      } else throw new HttpError(404, "Route not found");
      response.writeHead(request.method === "POST" ? 201 : 200); response.end(JSON.stringify(result));
    } catch (error) {
      if (!(error instanceof HttpError)) report(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(error instanceof HttpError ? error.status : 500); response.end(JSON.stringify({ error: error instanceof HttpError ? error.message : "Server failure" }));
    }
  }
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "https://localhost").pathname;
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== origin && !(options.allowedOrigins ?? ["http://127.0.0.1:5195", "http://localhost:5195"]).includes(requestOrigin)) { socket.destroy(); return; }
    if (path.startsWith("/matches/")) {
      if (![...matches.values()].some(match => path === `/matches/${match.id}`)) socket.destroy();
      return;
    }
    const code = path.match(/^\/lobbies\/([A-Z0-9]{6})$/)?.[1], lobby = code ? lobbies.get(code) : undefined;
    if (!lobby || closing || lobby.peers.size >= lobby.state.targetPlayers || sockets.clients.size >= maxLobbies * 32) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, peer => sockets.emit("connection", peer, lobby));
  };
  server.on("upgrade", upgrade);
  sockets.on("connection", (peer: WebSocket, lobby: Lobby) => {
    const id = randomBytes(12).toString("hex"); let joined = false, tokens = 12, last = Date.now(), busy = false;
    const timeout = setTimeout(() => peer.close(1008, "Admission timed out"), 5000); timeout.unref();
    peer.on("error", () => peer.close(1002, "Transport failure"));
    peer.on("close", () => { clearTimeout(timeout); if (joined) leave(lobby, id); });
    peer.on("message", (bytes, binary) => { void receive(bytes as Buffer, binary); });
    async function receive(bytes: Buffer, binary: boolean): Promise<void> {
      try {
        const now = Date.now(); tokens = Math.min(12, tokens + (now - last) / 1000 * 4); last = now;
        if (!binary || tokens < 1 || busy) { peer.close(1008, "Invalid or excessive lobby traffic"); return; } tokens--;
        const message: Message = decodeMessage(bytes);
        if (!joined) {
          if (message.type !== "lobby-join") throw new Error("First message must be lobby-join");
          validateNickname(message.nickname);
          if (lobby.peers.size >= lobby.state.targetPlayers) throw new Error("Lobby full");
          let host = false;
          if (message.hostToken !== undefined) {
            const token = Buffer.from(message.hostToken), expected = Buffer.from(lobby.hostToken);
            if (token.length !== expected.length || !timingSafeEqual(token, expected) || lobby.state.players.some(player => player.host)) throw new Error("Invalid host token");
            host = true;
          }
          if (lobby.match && load(lobby.match) >= lobby.match.target) throw new Error("Match full");
          const player: LobbyPlayer = { id, nickname: message.nickname, host, ready: host };
          joined = true; clearTimeout(timeout); lobby.peers.set(id, peer); lobby.state.players.push(player); lobby.idleSince = Date.now(); broadcast(lobby); return;
        }
        const player = lobby.state.players.find(item => item.id === id)!;
        if (message.type === "lobby-leave") { peer.close(1000, "Left lobby"); return; }
        if (message.type === "lobby-ready") {
          if (lobby.state.started || lobby.starting) throw new Error("Match already starting");
          player.ready = player.host || message.ready;
        } else if (message.type === "lobby-update") {
          if (!player.host) throw new Error("Only host may change setup");
          if (lobby.state.started || lobby.starting) throw new Error("Match already starting");
          const setup = validSetup(message.mode ?? lobby.state.mode, message.map ?? lobby.state.map);
          const population = message.targetPlayers ?? lobby.state.targetPlayers;
          if (population < lobby.state.players.length) throw new Error("Target smaller than roster");
          Object.assign(lobby.state, setup, { targetPlayers: population });
          for (const member of lobby.state.players) member.ready = member.host;
        } else if (message.type === "lobby-start") {
          if (!player.host) throw new Error("Only host may start");
          if (lobby.state.started || lobby.starting) throw new Error("Match already starting");
          if (lobby.state.players.some(member => !member.ready)) throw new Error("Players are not ready");
          lobby.starting = true; busy = true;
          try {
            const match = await serial(() => newMatch(lobby.state.mode, lobby.state.map, lobby.state.targetPlayers, false));
            if (lobbies.get(lobby.code) !== lobby || closing) {
              matches.delete(match.id); await match.game.close(); return;
            }
            lobby.match = match;
            lobby.state.started = true; lobby.state.matchId = lobby.match.id; lobby.state.matchWsUrl = matchUrl(lobby.match);
          } finally { lobby.starting = false; busy = false; }
        } else throw new Error("Message not permitted in lobby");
        broadcast(lobby);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Lobby request rejected";
        peer.send(encodeMessage({ type: "lobby-error", reason: reason.slice(0, 200) }));
        if (!joined) peer.close(1008, "Lobby admission rejected");
      }
    }
  });
  const cleanup = setInterval(() => { void serial(async () => {
    const now = Date.now();
    for (const [address, bucket] of buckets) if (now - bucket.at > 120_000) buckets.delete(address);
    for (const match of matches.values()) {
      expireLeases(match, now);
      if (load(match)) match.idleSince = now;
      else if (!match.game.available || now - match.idleSince >= idleMs) {
        matches.delete(match.id); await match.game.close();
        for (const lobby of lobbies.values()) if (lobby.match === match) { for (const peer of lobby.peers.values()) peer.close(1001, "Match expired"); lobbies.delete(lobby.code); }
      }
    }
    for (const lobby of lobbies.values()) if (!lobby.peers.size && now - lobby.idleSince >= idleMs) lobbies.delete(lobby.code);
  }).catch(report); }, Math.min(idleMs, 5000)); cleanup.unref();
  try {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(options.port ?? 443, options.host ?? "127.0.0.1", () => { server.off("error", listening.reject); listening.resolve(); });
    await listening.promise;
    if (!origin) { const address = server.address(); if (!address || typeof address === "string") throw new Error("TCP address unavailable"); origin = `https://127.0.0.1:${address.port}`; }
  } catch (error) { clearInterval(cleanup); sockets.close(); throw error; }
  let closePromise: Promise<void> | undefined;
  return { httpsServer: server, close() {
    return closePromise ??= (async () => {
      closing = true; clearInterval(cleanup); await queue;
      for (const peer of sockets.clients) peer.terminate();
      await Promise.all([...matches.values()].map(match => match.game.close()));
      const socketsClosed = Promise.withResolvers<void>();
      sockets.close(() => socketsClosed.resolve()); await socketsClosed.promise;
      server.off("upgrade", upgrade);
      const serverClosed = Promise.withResolvers<void>();
      server.close(error => error ? serverClosed.reject(error) : serverClosed.resolve()); await serverClosed.promise;
    })();
  } };
}
