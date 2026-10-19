import assert from "node:assert/strict";
import { before, test } from "node:test";
import { resolve } from "node:path";
import { loadSim, loadSimContent, requireStatus, encodeInput, type SimHost } from "@soldat-web/sim-host";
import type { Message, TickRecord } from "@soldat-web/protocol";
import { OnlineSession } from "../../client/src/net/session.ts";
import { PlayerInputBuffer } from "../src/input-buffer.ts";
import { qualificationConfig, type QualificationConfig } from "./support.ts";
import { readFile } from "node:fs/promises";

let config: QualificationConfig;
before(async () => { config = await qualificationConfig(resolve("build-out/prediction-bootstrap")); });

async function host(): Promise<SimHost> {
  const sim = await loadSim(config.wasm);
  try {
    await loadSimContent(sim, config.manifest, path => readFile(resolve(config.match.contentRoot, path)));
    requireStatus(sim.init({ ...config.match.rules, ai: true }, 1), "bootstrap init");
    requireStatus(sim.loadMap("Arena"), "bootstrap map");
    return sim;
  } catch (error) { sim.dispose(); throw error; }
}

/** Ordered virtual links exercise real native prediction and the production input buffer. */
async function startup(uplinkMs: number, downlinkMs: number, hz: number, firstReplyDelayMs = 0) {
  const authority = await host(), prediction = await host(), confirmed = await host();
  const buffer = new PlayerInputBuffer(0n), intent = encodeInput({ Right: true });
  const outgoing: { at: number; message: Message }[] = [], incoming: { at: number; message: Message }[] = [];
  const deferred: typeof incoming = [];
  let firstPing: bigint | undefined;
  let lastPingReplyAt = -Infinity;
  const records: TickRecord[] = [];
  const pointer = requireStatus(authority.exports.sim_alloc(12), "bootstrap input allocation");
  let now = 0, tick = 0, nextTickAt = 1000 / 60, nextFrameAt = downlinkMs, consumed = 0;
  let session: OnlineSession | undefined, firstScheduledAt: number | null = null, steadyScheduled = 0, steadyTicks = 0;
  let maximumStepsPerFrame = 0;
  const enqueue = (queue: typeof outgoing, delay: number, message: Message) => {
    queue.push({ at: Math.max(now + delay, queue.at(-1)?.at ?? 0), message });
  };
  try {
    requireStatus(authority.command(0, { kind: "join", slot: 1, control: "authoritative", team: 0 }), "bootstrap join");
    const state = authority.saveState();
    if (typeof state === "number") throw new Error(`bootstrap state ${state}`);
    enqueue(incoming, downlinkMs, { type: "state", tick: 0, hash: BigInt(`0x${authority.hash()}`), lastConsumedInputSeq: 0, bytes: state });
    for (let ms = 0; ms <= 2500; ms++) {
      now = ms;
      while (outgoing.length && outgoing[0]!.at <= now) {
        const message = outgoing.shift()!.message;
        if (message.type === "ping") {
          // Match the production listener's existing four-replies/second gate.
          if (now - lastPingReplyAt < 250) continue;
          lastPingReplyAt = now;
          if (firstReplyDelayMs) {
            enqueue(incoming, downlinkMs, { type: "pong", timestamp: message.timestamp + 1_000_000_000n });
            if (firstPing !== undefined) enqueue(incoming, downlinkMs, { type: "pong", timestamp: firstPing });
          }
          const reply: Message = { type: "pong", timestamp: message.timestamp };
          if (firstPing === undefined && firstReplyDelayMs) deferred.push({ at: now + firstReplyDelayMs, message: reply });
          else enqueue(incoming, downlinkMs, reply);
          firstPing ??= message.timestamp;
        }
        else if (message.type === "input") buffer.offer(message.frames, tick, BigInt(ms) * 1_000_000n);
      }
      while (deferred.length && deferred[0]!.at <= now) enqueue(incoming, downlinkMs, deferred.shift()!.message);
      while (nextTickAt <= now + 1e-7) {
        const input = buffer.consume(tick);
        consumed = input.seq;
        if (input.consumption === "scheduled") {
          firstScheduledAt ??= now;
          assert.equal(input.input[0]! & 2, 2, "The first admitted intent must retain the player's actual Right control");
        }
        if (now >= 2000) { steadyTicks++; if (input.consumption === "scheduled") steadyScheduled++; }
        new Uint8Array(authority.exports.memory.buffer, pointer, 12).set(input.input);
        requireStatus(authority.exports.sim_set_input(1, tick, pointer), "bootstrap authoritative input");
        requireStatus(authority.step(), "bootstrap authoritative step"); authority.events();
        records.push({ type: "step", tick: tick++, commands: [], inputs: [{ slot: 1, input: input.input.slice() }] });
        if (tick % 30 === 0) records.push({ type: "hash", tick, hash: BigInt(`0x${authority.hash()}`) });
        nextTickAt += 1000 / 60;
      }
      if (tick % 2 === 0 && records.length) enqueue(incoming, downlinkMs, { type: "ticks", records: records.splice(0), lastConsumedInputSeq: consumed });
      if (!session && now >= downlinkMs) session = new OnlineSession({ prediction, confirmed, slot: 1, now: () => now, send: message => enqueue(outgoing, uplinkMs, message) });
      while (incoming.length && incoming[0]!.at <= now) session!.receive(incoming.shift()!.message);
      if (session && now + 1e-7 >= nextFrameAt) {
        let steps = 0;
        session.advance(() => intent, undefined, () => { steps++; }); session.present();
        maximumStepsPerFrame = Math.max(maximumStepsPerFrame, steps);
        nextFrameAt += 1000 / hz;
      }
    }
    assert.ok(session);
    assert.equal(session.metrics.hashMismatches, 0); assert.equal(session.metrics.resyncs, 0);
    assert.equal(buffer.rejected.lead, 0, "Bootstrap must stay inside the existing eight-tick arrival limit");
    assert.ok(maximumStepsPerFrame <= 4, "Clock priming cannot bypass bounded native catch-up");
    return { firstScheduledAt, admittedAfterStateMs: firstScheduledAt === null ? Infinity : firstScheduledAt - downlinkMs, steadyScheduled, steadyTicks };
  } finally {
    authority.exports.sim_free(pointer); authority.dispose();
    if (session) session.dispose(); else { prediction.dispose(); confirmed.dispose(); }
  }
}

for (const [uplinkMs, downlinkMs, hz] of [[0, 0, 60], [30, 30, 60], [30, 30, 120], [30, 30, 144], [60, 60, 60], [125, 125, 60], [10, 90, 60], [90, 10, 60]] as const) {
  test(`cold prediction schedules real intent promptly at ${uplinkMs}+${downlinkMs} ms and ${hz} Hz`, async () => {
    const result = await startup(uplinkMs, downlinkMs, hz);
    // At most two probes, respecting the existing reply gate, then outbound
    // transit and bounded native/render catch-up rather than seconds of slewing.
    const deadlineMs = 2 * (uplinkMs + downlinkMs) + 250 + uplinkMs + 8 * 1000 / hz;
    assert.ok(result.admittedAfterStateMs <= deadlineMs, JSON.stringify({ ...result, deadlineMs }));
    assert.ok(result.steadyScheduled >= result.steadyTicks * 0.9, "Healthy delivery must continue consuming fresh scheduled inputs after bootstrap");
  });
}

test("a delayed admission probe cannot over-prime the cold clock, and forged/replayed pongs cannot seed it", async () => {
  const result = await startup(30, 30, 60, 400);
  assert.ok(result.admittedAfterStateMs < 1000, "A single delayed probe must not leave seconds of stale or prematurely scheduled intent");
  assert.ok(result.steadyScheduled >= result.steadyTicks * 0.9);
});
