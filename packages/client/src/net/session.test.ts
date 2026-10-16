import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSim, loadSimContent, requireStatus, encodeInput, type SimHost, type SimManifest } from "@soldat-web/sim-host";
import { encodeDelta, type Message } from "@soldat-web/protocol";
import { heldInput, OnlineSession, INPUT_HISTORY, type CorrectionDiagnostic } from "./session.ts";

const root = new URL("../../../../", import.meta.url);
async function realHost(): Promise<SimHost> {
  const host = await loadSim(new Uint8Array(await readFile(new URL("build-out/sim/sim.wasm", root))));
  const manifest: SimManifest = JSON.parse(await readFile(new URL("dist/content/sim/manifest.json", root), "utf8"));
  try {
    await loadSimContent(host, manifest, path => readFile(new URL(`dist/content/${path}`, root)));
    requireStatus(host.init({}, 1), "init"); requireStatus(host.loadMap("Arena"), "map");
    return host;
  } catch (error) { host.dispose(); throw error; }
}
function save(host: SimHost): Uint8Array {
  const state = host.saveState(); if (typeof state === "number") throw new Error(`save_state ${state}`); return state;
}
function snapshot(host: SimHost, state: Uint8Array, id: number, tick: number, ack = 0,
  inputs: { slot: number; input: Uint8Array }[] = []): Extract<Message, { type: "snapshot" }> {
  return { type: "snapshot", serverTick: tick, lastConsumedInputSeq: ack, snapshotId: id, baselineId: 0,
    stateHash: BigInt(`0x${host.hash()}`), inputs, state: encodeDelta(state) };
}

test("held controls preserve movement/aim/order, clear only one-shot bits, and own bytes", () => {
  const input = encodeInput({ Left: true, Fire: true, Jetpack: true, ThrowNade: true, ChangeWeapon: true,
    ThrowWeapon: true, Reload: true, Prone: true, FlagThrow: true, MouseAimX: 177, MouseDist: 150, pressOrder: 1 });
  const held = heldInput(input);
  assert.equal(new DataView(held.buffer).getUint16(0, true), 1 | 16 | 32);
  assert.deepEqual(held.subarray(2), input.subarray(2)); assert.notEqual(held.buffer, input.buffer);
});

test("held Node Buffer controls never mutate the borrowed wire snapshot", () => {
  const input = Buffer.from(encodeInput({ Right: true, Fire: true, ThrowNade: true, MouseAimX: 200 }));
  const original = Uint8Array.from(input), held = heldInput(input);
  assert.equal(new DataView(held.buffer).getUint16(0, true), 2 | 16);
  assert.deepEqual(Uint8Array.from(input), original, "Buffer.slice is a shared view, not Uint8Array.slice ownership");
  assert.notEqual(held.buffer, input.buffer);
});

test("real fullstate load/hash, REPLAY, newest+2 redundancy, remote authoritative split and exactly-once events", async () => {
  const [authoritative, prediction, extraction] = await Promise.all([realHost(), realHost(), realHost()]);
  const sent: Message[] = []; let now = 0, events = 0;
  const liveTicks: number[] = [];
  const session = new OnlineSession({ prediction, extraction, slot: 1, now: () => now, send: message => sent.push(message),
    onEvent: () => events++, onLiveStep: tick => liveTicks.push(tick) });
  try {
    for (const slot of [1, 2]) requireStatus(authoritative.command(0, { kind: "join", slot, team: 1, control: "authoritative" }), "join");
    const initial = save(authoritative);
    session.receive(snapshot(authoritative, initial, 1, 0)); session.present();
    const right = encodeInput({ Right: true, MouseAimX: 200, MouseDist: 150 });
    now = 34; session.advance(() => right);
    const inputs = sent.filter(message => message.type === "input");
    assert.deepEqual(liveTicks, [1, 2, 3, 4]);
    assert.equal(inputs.length, 4); assert.deepEqual(inputs[3]!.frames.map(frame => frame.seq), [4, 3, 2]);
    assert.deepEqual(inputs[3]!.frames.map(frame => frame.tick), [3, 2, 1]);
    assert.ok(inputs.every(message => message.frames.every(frame => frame.viewTick <= frame.tick)));
    for (let tick = 0; tick < 2; tick++) {
      requireStatus(authoritative.setInput(1, tick, { Right: true, MouseAimX: 200, MouseDist: 150 }), "local input");
      requireStatus(authoritative.setInput(2, tick, { Left: true, MouseAimX: -200, MouseDist: 150 }), "remote input");
      requireStatus(authoritative.step(), "step");
    }
    const state = save(authoritative), remote = encodeInput({ Left: true, Reload: true, MouseAimX: -200, MouseDist: 150 });
    const second = snapshot(authoritative, state, 2, 2, 2, [{ slot: 1, input: right }, { slot: 2, input: remote }]);
    for (let tick = 2; tick < 4; tick++) {
      requireStatus(authoritative.setInput(1, tick, { Right: true, MouseAimX: 200, MouseDist: 150 }), "local replay reference");
      requireStatus(authoritative.setInput(2, tick, { Left: true, MouseAimX: -200, MouseDist: 150 }), "remote held reference");
      requireStatus(authoritative.step(1), "reference REPLAY");
    }
    session.receive(second);
    assert.deepEqual(liveTicks, [1, 2, 3, 4], "reconciliation never republishes live-step bink events");
    assert.equal(session.metrics.replayLength, 2); assert.equal(session.metrics.predictedTick, 4);
    assert.equal(prediction.hash(), authoritative.hash());
    assert.equal(session.metrics.loadedHash, second.stateHash.toString(16).padStart(16, "0"));
    assert.equal(session.metrics.hashMismatches, 0);
    const hash = prediction.hash(); session.present(); session.present(); assert.equal(prediction.hash(), hash);
    now = 100; session.present();
    const authoritativeRender = extraction.renderView();
    if (typeof authoritativeRender === "number") throw new Error("Authoritative render extraction failed");
    assert.equal(session.world.sprites[1]!.x, authoritativeRender.sprite(1).posX);
    session.receive(second); assert.equal(session.metrics.hashMatches, 2);
    const event = { id: 1, tick: 2, header: new Uint8Array(20), payload: new Uint8Array() };
    session.receive({ type: "events", events: [event] }); session.receive({ type: "events", events: [event] });
    assert.equal(events, 1); assert.equal(session.metrics.duplicateEvents, 1);
    assert.equal(sent.filter(message => message.type === "eventAck").length, 2);
    session.receive({ type: "ping", timestamp: 12345n });
    assert.deepEqual(sent[sent.length - 1], { type: "pong", timestamp: 12345n });
  } finally { session.dispose(); authoritative.dispose(); }
});

test("unknown baselines and exhausted prediction history request resync without acknowledging rejected state", async () => {
  const [authoritative, prediction, extraction] = await Promise.all([realHost(), realHost(), realHost()]);
  const sent: Message[] = []; let now = 0;
  const session = new OnlineSession({ prediction, extraction, slot: 1, now: () => now, send: message => sent.push(message) });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, team: 1, control: "authoritative" }), "join");
    const full = snapshot(authoritative, save(authoritative), 1, 0);
    session.receive({ ...full, baselineId: 999 });
    assert.equal(sent.some(message => message.type === "snapshotAck"), false);
    assert.deepEqual(sent.pop(), { type: "resync", baselineId: 999 });
    session.receive(full); session.present();
    now = (INPUT_HISTORY + 1) * 1000 / 60; session.advance(() => encodeInput({}));
    assert.deepEqual(sent.pop(), { type: "resync", baselineId: 0 }); assert.equal(session.metrics.pendingInputs, 0);
  } finally { session.dispose(); authoritative.dispose(); }
});

test("real snapshots retain an acknowledged baseline beyond eight arrivals and coalesce recovery until fullstate", async () => {
  const [authoritative, prediction, extraction] = await Promise.all([realHost(), realHost(), realHost()]);
  const sent: Message[] = [];
  const session = new OnlineSession({ prediction, extraction, slot: 1, now: () => 0, send: message => sent.push(message) });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, team: 1, control: "authoritative" }), "join");
    const state = save(authoritative), first = snapshot(authoritative, state, 1, 0);
    session.receive(first);
    const delta = encodeDelta(state, state);
    // These packets were produced while ACKs were still in flight to the server.
    for (let id = 2; id <= 12; id++) session.receive({ ...first, snapshotId: id, baselineId: 1, state: delta });
    assert.equal(session.metrics.hashMatches, 12);
    assert.equal(session.metrics.resyncs, 0);
    assert.equal(sent.filter(message => message.type === "snapshotAck").length, 12);
    assert.equal(session.metrics.baselineBytes, state.byteLength * 12);
    session.receive({ ...first, snapshotId: 13, baselineId: 999, state: delta });
    // Queued unknown AND otherwise-decodable old-epoch deltas cannot restart
    // prediction or create a fullstate-request storm before the reply arrives.
    for (let id = 14; id <= 20; id++) session.receive({ ...first, snapshotId: id, baselineId: id % 2 ? 999 : 1, state: delta });
    assert.equal(session.metrics.hashMatches, 12);
    assert.equal(session.metrics.resyncs, 1);
    assert.equal(sent.filter(message => message.type === "resync").length, 1);
    assert.equal(sent.filter(message => message.type === "snapshotAck").length, 12);
    session.receive({ ...first, snapshotId: 21 });
    session.receive({ ...first, snapshotId: 22, baselineId: 21, state: delta });
    assert.equal(session.metrics.status, "online");
    assert.equal(session.metrics.hashMatches, 14);
    assert.equal(session.metrics.baselineBytes, state.byteLength * 2);
    assert.equal(sent.filter(message => message.type === "snapshotAck").length, 14);
  } finally { session.dispose(); authoritative.dispose(); }
});

test("fresh snapshots cannot hide an exhausted unconsumed sequence window", async () => {
  const [authoritative, prediction, extraction] = await Promise.all([realHost(), realHost(), realHost()]);
  const sent: Message[] = []; let now = 0;
  const session = new OnlineSession({ prediction, extraction, slot: 1, now: () => now, send: message => sent.push(message) });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative" }), "join");
    session.receive(snapshot(authoritative, save(authoritative), 1, 0));
    for (let tick = 1; tick <= INPUT_HISTORY + 2; tick++) {
      requireStatus(authoritative.step(), "step");
      now = tick * 1000 / 60;
      // A real server keeps advancing and publishing valid snapshots even if
      // every input is rejected. No consumption ACK advances in this case.
      session.receive(snapshot(authoritative, save(authoritative), tick + 1, tick));
      session.advance(() => encodeInput({ Right: true }));
      if (session.metrics.resyncs) break;
    }
    assert.equal(session.metrics.resyncs, 1);
    assert.equal(session.metrics.status, "resynchronizing");
    assert.equal(sent.filter(message => message.type === "resync").length, 1);
    assert.equal(session.metrics.pendingInputs, 0);
    session.advance(() => encodeInput({}));
    assert.equal(sent.filter(message => message.type === "resync").length, 1);
    const priorInputs = sent.filter(message => message.type === "input").length;
    session.receive(snapshot(authoritative, save(authoritative), session.metrics.snapshotId + 1, session.metrics.serverTick));
    now += 17;
    session.advance(() => encodeInput({ Right: true }));
    assert.equal(session.metrics.resyncs, 1);
    assert.ok(sent.filter(message => message.type === "input").length > priorInputs);
  } finally { session.dispose(); authoritative.dispose(); }
});

test("real-host correction evidence preserves pre-retirement controls and separates missing authority from damage", async () => {
  const [authoritative, prediction, extraction] = await Promise.all([realHost(), realHost(), realHost()]);
  const diagnostics: Readonly<CorrectionDiagnostic>[] = [];
  let now = 0;
  const session = new OnlineSession({ prediction, extraction, slot: 1, now: () => now, send() {},
    onCorrection: diagnostic => diagnostics.push(diagnostic) });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative" }), "join");
    for (let tick = 0; tick < 60; tick++) requireStatus(authoritative.step(), "settle");
    const neutral = encodeInput({});
    session.receive(snapshot(authoritative, save(authoritative), 1, 60, 0, [{ slot: 1, input: neutral }]));
    const right = encodeInput({ Right: true });
    now = 250;
    for (let batch = 0; batch < 4; batch++) session.advance(() => right);
    assert.equal(session.metrics.predictedTick, 76);
    // The server never received these controls. Its unchanged ACK and neutral
    // held input must remain visible, not be rewritten to match prediction.
    for (let tick = 60; tick < 72; tick++) {
      requireStatus(authoritative.setInput(1, tick, {}), "neutral authoritative input");
      requireStatus(authoritative.step(), "authoritative step");
    }
    session.receive(snapshot(authoritative, save(authoritative), 2, 72, 0, [{ slot: 1, input: neutral }]));
    assert.equal(diagnostics.length, 1);
    const diagnostic = diagnostics[0]!;
    assert.ok(diagnostic.correction > 0.001);
    assert.equal(diagnostic.correction, session.metrics.correction);
    assert.equal(diagnostic.previousServerTick, 60); assert.equal(diagnostic.serverTick, 72);
    assert.equal(diagnostic.predictedTick, 76); assert.equal(diagnostic.viewTick, 60);
    assert.equal(diagnostic.previousConsumedInputSeq, 0); assert.equal(diagnostic.consumedInputSeq, 0);
    assert.deepEqual(diagnostic.replayGaps, []);
    assert.equal(diagnostic.ring.length, 16);
    assert.deepEqual(diagnostic.ring.map(frame => frame.tick), Array.from({ length: 16 }, (_, i) => 60 + i));
    assert.ok(diagnostic.ring.every(frame => frame.bits === 2 && frame.viewTick === 60));
    assert.deepEqual(diagnostic.ring[0]!.input, Array.from(right));
    assert.equal(diagnostic.authoritativeInputs[0]!.bits, 0);
    const before = diagnostic.before.find(sprite => sprite.slot === 1)!;
    const restored = diagnostic.authoritative.find(sprite => sprite.slot === 1)!;
    const after = diagnostic.after.find(sprite => sprite.slot === 1)!;
    assert.equal(before.health, restored.health); assert.equal(restored.health, after.health);
    assert.equal(before.fuel, restored.fuel); assert.equal(restored.fuel, after.fuel);
    assert.notEqual(before.x, after.x);
    // Subsequent syncs may mutate WorldSprites but not the delivered evidence.
    const beforeX = before.x;
    now += 17; session.advance(() => right);
    assert.equal(before.x, beforeX);
  } finally { session.dispose(); authoritative.dispose(); }
});

test("adaptive prediction passes sixteen ticks without inventing view time or skipping sampled controls", async () => {
  const [authoritative, prediction, extraction] = await Promise.all([realHost(), realHost(), realHost()]);
  const sent: Message[] = [];
  let now = 0;
  const session = new OnlineSession({ prediction, extraction, slot: 1, now: () => now, send: message => sent.push(message) });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative" }), "join");
    session.receive(snapshot(authoritative, save(authoritative), 1, 0));
    const input = encodeInput({ Right: true });
    session.advance(() => input);
    const firstPing = sent.find(message => message.type === "ping")!;
    assert.equal(firstPing.type, "ping");
    for (let tick = 1; tick <= 90; tick++) {
      now = tick * 1000 / 60;
      if (tick === 24) {
        session.receive({ type: "pong", timestamp: firstPing.timestamp });
        assert.ok(Math.abs(session.metrics.targetPredictionLeadTicks - 14) < 0.001);
      }
      if (tick === 90) {
        const pings = sent.filter(message => message.type === "ping");
        const secondPing = pings[pings.length - 1]!;
        assert.equal(secondPing.type, "ping");
        session.receive({ type: "pong", timestamp: secondPing.timestamp });
        assert.ok(Math.abs(session.metrics.rttDeviationMs - 100) < 0.001);
        assert.ok(session.metrics.targetPredictionLeadTicks > 17);
      }
      const previousLead = session.metrics.predictionLeadTicks;
      session.advance(() => input);
      assert.ok(session.metrics.predictionClockRate >= 0.9 && session.metrics.predictionClockRate <= 1.1);
      assert.ok(session.metrics.predictionLeadTicks - previousLead <= 1 / 60 + 0.000001);
    }
    const frames = sent.filter(message => message.type === "input").map(message => message.frames[0]!);
    assert.ok(frames.length > 90 && frames.length < INPUT_HISTORY - 8);
    assert.deepEqual(frames.map(frame => frame.tick), Array.from({ length: frames.length }, (_, i) => i));
    assert.deepEqual(frames.map(frame => frame.seq), Array.from({ length: frames.length }, (_, i) => i + 1));
    assert.ok(frames.every(frame => frame.viewTick === 0));
    assert.ok(frames.some(frame => frame.tick - frame.viewTick > 18));
    assert.ok(frames.every(frame => frame.input.every((byte, i) => byte === input[i])));
    assert.equal(session.metrics.resyncs, 0);
    assert.equal(session.metrics.viewTick, 0);
  } finally { session.dispose(); authoritative.dispose(); }
});

test("adaptive jitter lead leaves two ticks of the eight-tick server window for clock error", async () => {
  const [authoritative, prediction, extraction] = await Promise.all([realHost(), realHost(), realHost()]);
  const sent: Message[] = []; let now = 0;
  const session = new OnlineSession({ prediction, extraction, slot: 1, now: () => now, send: message => sent.push(message) });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative" }), "join");
    session.receive(snapshot(authoritative, save(authoritative), 1, 0));
    session.advance(() => encodeInput({}));
    const first = sent.find(message => message.type === "ping")!;
    assert.equal(first.type, "ping");
    now = 100; session.receive({ type: "pong", timestamp: first.timestamp });
    now = 1000; session.advance(() => encodeInput({}));
    const second = sent.filter(message => message.type === "ping").at(-1)!;
    assert.equal(second.type, "ping");
    now = 7000; session.receive({ type: "pong", timestamp: second.timestamp });
    assert.equal(session.metrics.rttDeviationMs, 5900);
    assert.ok(Math.abs(session.metrics.targetPredictionLeadTicks - (session.metrics.rttMs / 2 / (1000 / 60) + 8)) < 0.000001);
    assert.ok(session.metrics.targetPredictionLeadTicks < INPUT_HISTORY - 8);
  } finally { session.dispose(); authoritative.dispose(); }
});
