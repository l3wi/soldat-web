import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSim, loadSimContent, requireStatus, encodeInput, type SimHost, type SimManifest } from "@soldat-web/sim-host";
import { encodeDelta, type Message } from "@soldat-web/protocol";
import { heldInput, OnlineSession, INPUT_HISTORY } from "./session.ts";

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

test("real fullstate load/hash, REPLAY, newest+2 redundancy, remote authoritative split and exactly-once events", async () => {
  const [authoritative, prediction, extraction] = await Promise.all([realHost(), realHost(), realHost()]);
  const sent: Message[] = []; let now = 0, events = 0;
  const session = new OnlineSession({ prediction, extraction, slot: 1, now: () => now, send: message => sent.push(message), onEvent: () => events++ });
  try {
    for (const slot of [1, 2]) requireStatus(authoritative.command(0, { kind: "join", slot, team: 1, control: "authoritative" }), "join");
    const initial = save(authoritative);
    session.receive(snapshot(authoritative, initial, 1, 0)); session.present();
    const right = encodeInput({ Right: true, MouseAimX: 200, MouseDist: 150 });
    now = 34; session.advance(() => right);
    const inputs = sent.filter(message => message.type === "input");
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
