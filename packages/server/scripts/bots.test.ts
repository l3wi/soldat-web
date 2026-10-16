import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { decodeDelta, encodeMessage, type Message } from "@soldat-web/protocol";
import { createGameServer } from "../src/server.ts";
import { BOT_PROFILES, reservedBotSlots } from "../src/bots.ts";
import { AuthoritativeMatch } from "../src/match.ts";
import type { WorkerResponse } from "../src/worker-messages.ts";
import { loadSim, loadSimContent, requireStatus, SIM_ABI_VERSION } from "@soldat-web/sim-host";
import { RawPeer, qualificationConfig, FROZEN_WASM_SHA256 } from "./support.ts";

interface BotSample {
  slot: number; name: string; team: number; kills: number; deaths: number;
  x: number; y: number; fired: number; controlBits: number; aimX: number; aimY: number;
  mouseDist: number; waypoint: number; input: number[] | null;
}
interface BotSnapshot {
  type: "bots"; player: number; tick: number; hash: string; bots: BotSample[];
  projectiles: number[]; humanTeams: number[]; teamScores: number[]; thingStyles: number[];
}
interface ClientSample {
  type: string; player: number; slot?: number; error?: string;
  metrics?: { snapshots: number; hashMatches: number; hashMismatches: number; lastConsumedInputSeq: number };
}

async function waitForClient(worker: Worker, predicate: (sample: ClientSample | BotSnapshot) => boolean, signal: AbortSignal): Promise<void> {
  while (true) {
    const [sample] = await once(worker, "message", { signal }) as [ClientSample | BotSnapshot];
    if (sample.type === "failure") throw new Error((sample as ClientSample).error);
    if (predicate(sample)) return;
  }
}

for (const mode of ["dm", "ctf"] as const) {
  test(`${mode}: two real headless clients receive four original bots and verified snapshots`, { timeout: 90_000 }, async context => {
    const out = resolve(process.env.NET_BOTS_OUT ?? "build-out/net-bots", mode);
    const config = await qualificationConfig(out);
    const errors: string[] = [], samples: BotSnapshot[] = [], clientSamples: ClientSample[] = [];
    const workers: Worker[] = [], botSlots = reservedBotSlots(4);
    const server = await createGameServer({
      match: { ...config.match, map: mode === "ctf" ? "ctf_Ash" : "Arena", botCount: 4, rules: { rng: "keyed", mode, world: "original", botDifficulty: 100 } },
      tls: config.tls, host: "127.0.0.1", port: 0,
      onError: error => errors.push(error.stack ?? error.message),
    });
    const address = server.httpsServer.address();
    assert.ok(address && typeof address !== "string");
    const url = `wss://127.0.0.1:${address.port}`;
    try {
      // Each peer uses its own worker and the production OnlineSession, not a
      // fabricated snapshot or a server-side input controller.
      for (let player = 1; player <= 2; player++) {
        const worker = new Worker(new URL("./headless-worker.ts", import.meta.url), { workerData: {
          url, wasmPath: config.match.wasmPath, contentRoot: config.match.contentRoot,
          manifest: config.manifest, player, combat: true, stackedCombat: false, pickupCombat: false, botDiagnostics: botSlots,
        } });
        workers.push(worker);
        worker.on("error", error => errors.push(error.stack ?? error.message));
        worker.on("message", (sample: ClientSample | BotSnapshot) => {
          if (sample.type === "bots") samples.push(sample as BotSnapshot);
          else clientSamples.push(sample);
          if (sample.type === "failure") errors.push((sample as ClientSample).error ?? "Unknown headless failure");
        });
        await waitForClient(worker, sample => sample.type === "ready", context.signal);
      }
      const ready = clientSamples.filter(sample => sample.type === "ready");
      assert.deepEqual(ready.map(sample => sample.slot), [1, 2], "human admissions must not enter reserved bot slots");
      // Exercise the new reliable path in the actual listener and worker. A
      // choice outside native limbo eligibility remains a next-respawn choice.
      workers[0]!.postMessage({ type: "weapon-choice", primary: 5, secondary: 11, selection: "primary" });
      // Observe at least 720 real ticks and an actual bot shot. CTF opponents
      // can need longer than twelve seconds to traverse their native waypoints.
      // The test's finite timeout remains the bound; no fixed sleep proves fire.
      const startTick = samples.at(-1)!.tick;
      await waitForClient(workers[1]!, sample => sample.type === "bots" && (sample as BotSnapshot).tick >= startTick + 720 &&
        samples.some(observed => observed.projectiles.length > 0 || observed.bots.some(bot => bot.fired > 0)), context.signal);
      assert.deepEqual(errors, []);
      for (const player of [1, 2]) {
        const snapshots = clientSamples.filter(sample => sample.type === "snapshot" && sample.player === player);
        assert.ok(snapshots.length >= 30, `player ${player} did not receive a sustained snapshot stream`);
        const last = snapshots.at(-1)!.metrics!;
        assert.equal(last.hashMismatches, 0);
        assert.equal(last.hashMatches, last.snapshots);
        assert.ok(last.lastConsumedInputSeq > 0, "real human input should reach the authoritative worker");
      }
      let sharedHashes = 0;
      const first = new Map(samples.filter(sample => sample.player === 1).map(sample => [sample.tick, sample]));
      for (const sample of samples.filter(sample => sample.player === 2)) {
        const other = first.get(sample.tick);
        if (!other) continue;
        assert.equal(sample.hash, other.hash, `clients disagree on authoritative tick ${sample.tick}`);
        assert.deepEqual(sample.bots, other.bots);
        assert.deepEqual(sample.teamScores, other.teamScores);
        sharedHashes++;
      }
      assert.ok(sharedHashes >= 20, "both real peers must verify the same authoritative timeline");
      for (const sample of samples) {
        assert.deepEqual(sample.bots.map(bot => bot.slot), botSlots);
        assert.equal(sample.teamScores.length, 6);
        for (const [index, bot] of sample.bots.entries()) {
          assert.equal(bot.name, BOT_PROFILES[index]);
          assert.equal(bot.team, mode === "ctf" ? index % 2 + 1 : 0);
          assert.ok(Number.isInteger(bot.kills) && Number.isInteger(bot.deaths));
          assert.ok(bot.input, "bot control record missing from the wire snapshot");
          const bytes = Uint8Array.from(bot.input), input = new DataView(bytes.buffer);
          assert.equal(bytes.length, 12);
          assert.equal(input.getUint16(0, true), bot.controlBits,
            `bot control mismatch player=${sample.player} tick=${sample.tick} slot=${bot.slot} hash=${sample.hash}: ${JSON.stringify(bot)}`);
          assert.equal(input.getInt16(2, true), bot.aimX);
          assert.equal(input.getInt16(4, true), bot.aimY);
          assert.equal(input.getInt16(6, true), bot.mouseDist);
          assert.equal(input.getUint32(8, true), 0, "bot press-order/reserved bytes must be zero");
        }
      }
      const latest = samples.at(-1)!;
      assert.deepEqual(latest.humanTeams, mode === "ctf" ? [1, 2] : [0, 0]);
      const initial = samples[0]!;
      assert.ok(samples.some(sample => sample.bots.some((bot, index) => Math.hypot(bot.x - initial.bots[index]!.x, bot.y - initial.bots[index]!.y) > 5)), "bots did not move");
      assert.ok(samples.some(sample => sample.bots.some(bot => bot.waypoint > 0 && (bot.controlBits & 0x2f) !== 0)), "no original waypoint movement controls observed");
      assert.ok(samples.some(sample => sample.projectiles.length > 0 || sample.bots.some(bot => bot.fired > 0)), "no bot fired on the reachable stock map");
      assert.ok(samples.some(sample => sample.thingStyles.includes(16)), "original-world medikits absent");
      assert.ok(samples.some(sample => sample.thingStyles.includes(17)), "original-world grenade kits absent");
      if (mode === "ctf") for (const flag of [1, 2])
        assert.ok(samples.some(sample => sample.thingStyles.includes(flag)), "original-world CTF flag absent");

      // Malformed and flooding connections must not kill the match or the two
      // already synchronized peers. Mutate valid wire bytes past the encoder.
      const malformed = new RawPeer(url);
      try {
        await malformed.connect(config.manifest.sha256, "Invalid-choice");
        const packet = encodeMessage({ type: "weapon-choice", primary: 4, secondary: 0, selection: "primary" });
        packet[8] = 255;
        const closed = once(malformed.socket, "close"); malformed.socket.send(packet);
        const [code] = await closed; assert.equal(code, 1008);
      } finally { await malformed.close(); }
      const flood = new RawPeer(url);
      try {
        await flood.connect(config.manifest.sha256, "Choice-flood");
        const closed = once(flood.socket, "close");
        for (let index = 0; index < 32; index++) flood.send({ type: "weapon-choice", primary: index % 10 + 1, secondary: 0, selection: "primary" });
        const [code] = await closed; assert.equal(code, 1008);
      } finally { await flood.close(); }
      const before = samples.at(-1)!.tick;
      await waitForClient(workers[1]!, sample => sample.type === "bots" && (sample as BotSnapshot).tick >= before + 12, context.signal);
      assert.ok(samples.at(-1)!.tick > before, "healthy clients stopped receiving snapshots after attacker rejection");
      assert.deepEqual(errors, []);
      await writeFile(resolve(out, "bots.json"), JSON.stringify({ wasmSha256: FROZEN_WASM_SHA256, abiVersion: SIM_ABI_VERSION,
        contentSetHash: config.manifest.sha256, world: "original", mode, sharedHashes, slots: ready.map(sample => sample.slot), initial, latest,
        firingObserved: true, samples: samples.length, errors }, null, 2));
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
      await server.close();
    }
  });
}

test("worker applies secondary then primary once, retains fallback, and rejects invalid/rate-abusive choices safely", async () => {
  const config = await qualificationConfig(resolve(process.env.NET_BOTS_OUT ?? "build-out/net-bots", "weapon-choice"));
  const responses: WorkerResponse[] = [];
  const match = await AuthoritativeMatch.start({ ...config.match, botCount: 4, rules: { ...config.match.rules, world: "original" } }, response => responses.push(response));
  const inspector = await loadSim(config.wasm);
  try {
    await loadSimContent(inspector, config.manifest, async path => new Uint8Array(await readFile(resolve(config.match.contentRoot, path))));
    requireStatus(inspector.init({ ...config.match.rules, ai: false, world: "original" }, 123456789, 0, 0), "weapon-choice inspector init");
    requireStatus(inspector.loadMap("Arena"), "weapon-choice inspector map");
    assert.throws(() => match.receive({ type: "join", slot: 29, weapon: 4, secondaryWeapon: 0 }, 0n), /slot/);
    match.receive({ type: "join", slot: 1, weapon: 4, secondaryWeapon: 0 }, 0n);
    let state: Uint8Array | undefined;
    const inspect = () => {
      match.step(); match.step();
      const snapshot = responses.filter((response): response is Extract<WorkerResponse, { type: "send" }> => response.type === "send" && response.message.type === "snapshot").at(-1)!.message as Extract<Message, { type: "snapshot" }>;
      state = decodeDelta(snapshot.state, snapshot.baselineId ? state : undefined);
      requireStatus(inspector.loadState(state), "weapon-choice snapshot load");
      assert.equal(inspector.hash(), snapshot.stateHash.toString(16).padStart(16, "0"));
      match.receive({ type: "snapshotAck", slot: 1, snapshotId: snapshot.snapshotId }, BigInt(match.tick) * 16_666_667n);
      const render = inspector.renderView();
      if (typeof render === "number") throw new Error("Missing weapon-choice render view");
      return render.sprite(0);
    };
    match.receive({ type: "weapon-choice", slot: 1, primary: 4, secondary: 11, selection: "secondary" }, 0n);
    const secondary = inspect();
    assert.equal(secondary.weapon, 4); assert.equal(secondary.secondaryWeapon, 11);
    match.receive({ type: "weapon-choice", slot: 1, primary: 5, secondary: 11, selection: "primary" }, 33_333_334n);
    const primary = inspect();
    assert.equal(primary.weapon, 5); assert.equal(primary.secondaryWeapon, 11);
    match.receive({ type: "weapon-choice", slot: 1, primary: 2, secondary: 13, selection: "primary" }, 66_666_668n);
    const closed = inspect();
    assert.equal(closed.weapon, 5); assert.equal(closed.secondaryWeapon, 11, "closed limbo must not refill/change live guns");
    assert.equal(responses.some(response => response.type === "reject"), false, "native eligibility rejection should retain fallback without disconnecting");
    // Inspect the serialized next-respawn choices on a client-side clone using
    // a trusted harness spawn; no spawn command is admitted over the network.
    requireStatus(inspector.command(match.tick, { kind: "spawn", slot: 1 }), "inspect saved respawn choice");
    const respawn = inspector.renderView();
    if (typeof respawn === "number") throw new Error("Missing respawn view");
    assert.equal(respawn.sprite(0).weapon, 2); assert.equal(respawn.sprite(0).secondaryWeapon, 13);
    match.receive({ type: "weapon-choice", slot: 1, primary: 255, secondary: 0, selection: "primary" }, 100_000_002n);
    assert.ok(responses.some(response => response.type === "reject" && response.reason === "Invalid weapon choice"));
    match.receive({ type: "weapon-choice", slot: 1, primary: 2, secondary: 0, selection: "primary" }, 100_000_002n);
    match.receive({ type: "weapon-choice", slot: 1, primary: 2, secondary: 0, selection: "primary" }, 100_000_002n);
    assert.ok(responses.some(response => response.type === "reject" && response.reason === "Weapon choice rate limit exceeded"));
    const tick = match.tick;
    inspect();
    assert.equal(match.tick, tick + 2, "rejected choices must not terminate the simulation");
  } finally { inspector.dispose(); match.dispose(); }
});
