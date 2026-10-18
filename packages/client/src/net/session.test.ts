import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSim, loadSimContent, requireStatus, encodeInput, type SimHost, type SimManifest } from "@soldat-web/sim-host";
import { type ChatDelivery, type Message, type TickRecord } from "@soldat-web/protocol";
import { heldInput, OnlineSession, INPUT_HISTORY } from "./session.ts";
import { SpectatorController } from "../spectator";

const root = new URL("../../../../", import.meta.url);
async function realHost(): Promise<SimHost> {
  const host = await loadSim(new Uint8Array(await readFile(new URL("build-out/sim/sim.wasm", root))));
  const manifest: SimManifest = JSON.parse(await readFile(new URL("dist/content-next/sim/manifest.json", root), "utf8"));
  try {
    await loadSimContent(host, manifest, path => readFile(new URL(`dist/content-next/${path}`, root)));
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
    for (const slot of [1, 2]) requireStatus(authoritative.command(0, {kind: "join", slot, control: "authoritative", team: 0, weapon: 4}), "join");
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
    requireStatus(authoritative.command(0, {kind: "join", slot: 1, control: "authoritative", team: 0}), "join");
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

test("round bootstrap clears old timeline while retaining input and reliable-event identity", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  const sent: Message[] = []; let now = 0;
  const session = new OnlineSession({ prediction, confirmed, slot: 1, now: () => now, send: message => sent.push(message) });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative", team: 0, weapon: 4 }), "join");
    session.receive(state(authoritative, 0)); now = 34; session.advance(() => encodeInput({ Right: true }));
    const previous = sent.filter(message => message.type === "input").at(-1)!.frames[0]!.seq;
    const header = new Uint8Array(20);
    session.receive({ type: "events", events: [{ id: 10, tick: 0, header, payload: new Uint8Array() }] });
    for (let tick = 0; tick < 12; tick++) { requireStatus(authoritative.step(), "step"); authoritative.events(); }
    session.resetRound();
    for (const host of [authoritative, prediction, confirmed]) requireStatus(host.loadMap("Arena"), "next map");
    session.receive(state(authoritative, 12));
    const nextHeader = new Uint8Array(20); new DataView(nextHeader.buffer).setUint32(4, 12, true);
    session.receive({ type: "events", events: [{ id: 11, tick: 12, header: nextHeader, payload: new Uint8Array() }] });
    now = 68; session.advance(() => encodeInput({}));
    const next = sent.filter(message => message.type === "input").at(-1)!.frames[0]!;
    assert.ok(next.seq > previous); assert.ok(next.tick >= 12);
    assert.equal(session.metrics.hashMismatches, 0); assert.equal(session.metrics.eventGaps, 0);
    assert.equal(session.metrics.resyncs, 0); assert.equal(session.metrics.status, "online");
  } finally { session.dispose(); authoritative.dispose(); }
});

test("chat and notices bypass simulation, and leave/reuse invalidation is not replayed", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  const sent: Message[] = [], chats: ChatDelivery[] = [], notices: string[] = [], leaves: number[] = [];
  const session = new OnlineSession({ prediction, confirmed, slot: 1, send: message => sent.push(message),
    onChat: message => chats.push(message), onNotice: text => notices.push(text), onSlotLeave: slot => leaves.push(slot) });
  try {
    for (const slot of [1, 2]) requireStatus(authoritative.command(0, { kind: "join", slot, team: 0, control: "authoritative", name: `Human ${slot}` }), "join");
    session.receive(state(authoritative, 0));
    const hash = confirmed.hash(), predictedHash = prediction.hash();
    session.sendChat("team", "hello team");
    assert.deepEqual(sent.at(-1), { type: "chat", channel: "team", text: "hello team" });
    const message: ChatDelivery = { type: "chat-message", channel: "team", slot: 2, nickname: "Human 2", text: "hello team" };
    session.receive(message); session.receive({ type: "notice", text: "Team is full" });
    assert.deepEqual(chats, [message]); assert.deepEqual(notices, ["Team is full"]);
    assert.equal(confirmed.hash(), hash); assert.equal(prediction.hash(), predictedHash);
    assert.throws(() => session.sendChat("public", "\n"));
    const commands = [{ kind: "leave", slot: 2 }, { kind: "join", slot: 2, team: 0, control: "authoritative", name: "Human 2" }] as const;
    const neutral = encodeInput({});
    const records: TickRecord[] = [
      { type: "step", tick: 0, commands: commands.map(command => new TextEncoder().encode(JSON.stringify(command))), inputs: [{ slot: 1, input: neutral }, { slot: 2, input: neutral }] },
      { type: "step", tick: 1, commands: [], inputs: [{ slot: 1, input: neutral }, { slot: 2, input: neutral }] },
    ];
    session.receive({ type: "ticks", lastConsumedInputSeq: 0, records });
    assert.deepEqual(leaves, [2], "Same-name same-slot replacement still invalidates once");
    session.receive({ type: "ticks", lastConsumedInputSeq: 0, records: [{ type: "correct", tick: 0, slot: 1, input: encodeInput({ Right: true }) }] });
    assert.deepEqual(leaves, [2], "Correction replay must not invalidate a second time");
    const snapshot = state(confirmed, 2);
    session.receive(snapshot); session.receive(snapshot);
    assert.deepEqual(leaves, [2], "Unchanged full-state roster must not invalidate");
    session.dispose(); assert.throws(() => session.sendChat("public", "closed"));
  } finally { session.dispose(); authoritative.dispose(); }
});

test("snapshot recovery cannot retain a followed same-name replacement occupant", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  const spectator = new SpectatorController();
  const sent: Message[] = [];
  const session = new OnlineSession({ prediction, confirmed, slot: 1, send: message => sent.push(message),
    onSlotLeave: slot => spectator.invalidate(slot), onStateReset: () => spectator.reset() });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative", team: 5, name: "Observer" }), "observer");
    requireStatus(authoritative.command(0, { kind: "join", slot: 2, control: "authoritative", team: 0, name: "Same name" }), "original occupant");
    session.receive(state(authoritative, 0));
    spectator.update(session.predictionWorld.sprites, 1, false, 0); spectator.follow(2);
    session.receive({ type: "ticks", lastConsumedInputSeq: 0, records: [{ type: "hash", tick: 0, hash: 0n }] });
    assert.equal(sent.at(-1)?.type, "resync");
    requireStatus(authoritative.command(0, { kind: "leave", slot: 2 }), "leave while resynchronizing");
    requireStatus(authoritative.command(0, { kind: "join", slot: 2, control: "authoritative", team: 0, name: "Same name" }), "replacement occupant");
    session.receive(state(authoritative, 0));
    spectator.update(session.predictionWorld.sprites, 1, false, 0);
    assert.equal(spectator.targetSlot, 0, "A snapshot cannot prove the old slot occupant survived");
    assert.equal(spectator.observing, true);
    assert.equal(confirmed.hash(), authoritative.hash());
  } finally { session.dispose(); authoritative.dispose(); }
});

test("server pause freezes prediction/input debt; resume fullstate resets clock and direction boundaries stay explicit", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  const sent: Message[] = []; let now = 0;
  const session = new OnlineSession({ prediction, confirmed, slot: 1, now: () => now, send: message => sent.push(message) });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative", team: 0 }), "join");
    session.receive(state(authoritative, 0)); now = 34; session.advance(() => encodeInput({ Right: true }));
    session.receive(state(authoritative, 0));
    session.receive({ type: "control-state", state: { host: true, admin: false, paused: true, muted: false, vote: null } });
    const tick = session.predictionWorld.tick, count = sent.filter(m => m.type === "input").length;
    now += 600000; session.advance(() => assert.fail("Paused sessions must not sample input"));
    assert.equal(session.paused, true); assert.equal(session.predictionWorld.tick, tick);
    assert.equal(sent.filter(m => m.type === "input").length, count); assert.equal(session.metrics.pendingInputs, 0);
    session.receive(state(authoritative, 0));
    session.receive({ type: "control-state", state: { host: true, admin: false, paused: false, muted: false, vote: null } });
    now += 17; session.advance(() => encodeInput({}));
    assert.ok(session.predictionWorld.tick <= 4); assert.equal(sent.filter(m => m.type === "resync").length, 0);
    session.sendFeature({ type: "gesture", gesture: "victory" }); assert.equal(sent.at(-1)!.type, "gesture");
    assert.throws(() => session.receive({ type: "self-kill" }), /Client-originated/);
  } finally { session.dispose(); authoritative.dispose(); }
});
