import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSim, loadSimContent, requireStatus, encodeInput, type SimHost, type SimManifest } from "@soldat-web/sim-host";
import { type Message, type TickRecord } from "@soldat-web/protocol";
import { heldInput, OnlineSession, INPUT_HISTORY } from "./session.ts";

const root = new URL("../../../../", import.meta.url);
async function realHost(): Promise<SimHost> {
  const host = await loadSim(new Uint8Array(await readFile(new URL("build-out/sim/sim.wasm", root))));
  const manifest: SimManifest = JSON.parse(await readFile(new URL("dist/content/sim/manifest.json", root), "utf8"));
  try {
    await loadSimContent(host, manifest, path => readFile(new URL(`dist/content/${path}`, root)));
    requireStatus(host.init({ world: "fixture", ai: true }, 1), "init"); requireStatus(host.loadMap("Arena"), "map");
    return host;
  } catch (error) { host.dispose(); throw error; }
}
function state(host: SimHost, tick: number): Extract<Message, {type: "state"}> {
  const bytes = host.saveState(); if (typeof bytes === "number") throw new Error(`save ${bytes}`);
  return { type: "state", tick, hash: BigInt(`0x${host.hash()}`), lastConsumedInputSeq: 0, bytes };
}

test("held controls own bytes, preserve movement and aim, clear only one-shot bits", () => {
  for (const buffer of [false, true]) {
    const source = encodeInput({ Left: true, Fire: true, Jetpack: true, ThrowNade: true, ChangeWeapon: true, Reload: true, MouseAimX: 177, MouseDist: 150, pressOrder: 1 });
    const input = buffer ? Buffer.from(source) : source;
    const original = Uint8Array.from(input), held = heldInput(input);
    assert.equal(new DataView(held.buffer).getUint16(0, true), 1 | 16 | 32);
    assert.deepEqual(held.subarray(2), original.subarray(2)); assert.deepEqual(Uint8Array.from(input), original);
    assert.notEqual(held.buffer, input.buffer);
  }
});

test("real confirmed timeline, sparse correction rollback, hash verification and reliable event deduplication", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  const sent: Message[] = []; let now = 0, events = 0;
  const session = new OnlineSession({ prediction, confirmed, slot: 1, now: () => now, send: m => sent.push(m), onEvent: () => events++ });
  try {
    for (const slot of [1, 2]) requireStatus(authoritative.command(0, {kind: "join", slot, control: "authoritative", team: 1, weapon: 4}), "join");
    const initial = state(authoritative, 0); session.receive(initial);
    const right = encodeInput({Right: true, MouseAimX: 200}), neutral = encodeInput({});
    now = 34; session.advance(() => right);
    const outgoing = sent.filter(m => m.type === "input");
    assert.ok(outgoing.length >= 2); assert.equal(outgoing.at(-1)!.frames.length, Math.min(3, outgoing.length));
    const records: TickRecord[] = [];
    for (let tick = 0; tick < 24; tick++) {
      requireStatus(authoritative.setInput(1, tick, {Right: true, MouseAimX: 200}), "input");
      requireStatus(authoritative.setInput(2, tick, {}), "remote");
      requireStatus(authoritative.step(), "step"); authoritative.events();
      records.push({type: "step", tick, commands: [], inputs: [{slot: 1, input: right}, {slot: 2, input: neutral}]});
    }
    records.push({type: "hash", tick: 24, hash: BigInt(`0x${authoritative.hash()}`)});
    session.receive({type: "ticks", lastConsumedInputSeq: 0, records});
    assert.equal(confirmed.hash(), authoritative.hash()); assert.equal(session.metrics.hashMismatches, 0);
    const corrected = encodeInput({Right: true, Fire: true, MouseAimX: 200});
    requireStatus(authoritative.loadState(initial.bytes), "rewind");
    for (let tick = 0; tick < 24; tick++) {
      requireStatus(authoritative.setInput(1, tick, {Right: true, Fire: tick === 15, MouseAimX: 200}), "corrected input");
      requireStatus(authoritative.setInput(2, tick, {}), "remote"); requireStatus(authoritative.step(1), "replay"); authoritative.events();
    }
    session.receive({type: "ticks", lastConsumedInputSeq: 0, records: [{type: "correct", tick: 15, slot: 1, input: corrected}, {type: "hash", tick: 24, hash: BigInt(`0x${authoritative.hash()}`)}]});
    assert.equal(confirmed.hash(), authoritative.hash()); assert.equal(session.metrics.rollbacks, 1); assert.equal(session.metrics.hashMismatches, 0);
    const header = new Uint8Array(20); new DataView(header.buffer).setUint32(4, 24, true);
    const event = {id: 1, tick: 24, header, payload: new Uint8Array()};
    session.receive({type: "events", events: [event]}); session.receive({type: "events", events: [event]});
    assert.equal(events, 1); assert.equal(session.metrics.duplicateEvents, 1);
  } finally { session.dispose(); authoritative.dispose(); }
});

test("matching confirmed prediction avoids reload; changed controls force reload", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  let now = 0; const session = new OnlineSession({prediction, confirmed, slot: 1, now: () => now, send() {}});
  try {
    requireStatus(authoritative.command(0, {kind: "join", slot: 1, control: "authoritative", team: 1}), "join");
    session.receive(state(authoritative, 0)); now = 34; session.advance(() => encodeInput({}));
    const reloads = session.metrics.reloads;
    session.receive({type: "ticks", lastConsumedInputSeq: 0, records: [{type: "step", tick: 0, commands: [], inputs: [{slot: 1, input: encodeInput({})}]}]});
    assert.equal(session.metrics.reloads, reloads); assert.equal(session.metrics.skippedReloads, 1);
    session.receive({type: "ticks", lastConsumedInputSeq: 0, records: [{type: "step", tick: 1, commands: [], inputs: [{slot: 1, input: encodeInput({Right: true})}]}]});
    assert.equal(session.metrics.reloads, reloads + 1);
  } finally { session.dispose(); authoritative.dispose(); }
});

test("hash mismatch requests one resync and freezes prediction until fresh state", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  const sent: Message[] = []; let now = 0;
  const session = new OnlineSession({prediction, confirmed, slot: 1, now: () => now, send: m => sent.push(m)});
  try {
    const initial = state(authoritative, 0); session.receive(initial);
    const bad: Message = {type: "ticks", lastConsumedInputSeq: 0, records: [{type: "hash", tick: 0, hash: initial.hash ^ 1n}]};
    session.receive(bad); session.receive(bad); now = 100; session.advance(() => encodeInput({}));
    assert.equal(session.metrics.hashMismatches, 1); assert.equal(session.metrics.status, "resynchronizing");
    assert.equal(sent.filter(m => m.type === "resync").length, 1); assert.equal(session.predictionWorld.tick, 0);
    session.receive(initial); assert.equal(session.metrics.status, "online");
    now += (INPUT_HISTORY + 1) * 1000 / 60; session.advance(() => encodeInput({}));
    assert.equal(sent.filter(m => m.type === "resync").length, 2); assert.equal(session.metrics.pendingInputs, 0);
  } finally { session.dispose(); authoritative.dispose(); }
});
