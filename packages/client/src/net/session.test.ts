import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSim, loadSimContent, requireStatus, encodeInput, type SimCommand, type SimHost, type SimManifest } from "@soldat-web/sim-host";
import { type ChatDelivery, type Message, type TickRecord } from "@soldat-web/protocol";
import { heldInput, OnlineSession, INPUT_HISTORY } from "./session.ts";
import { SpectatorController } from "../spectator";
import { CameraPresentation, createCamera, updateCamera } from "../camera";

const root = new URL("../../../../", import.meta.url);
async function realHost(rules: Record<string, unknown> = {}): Promise<SimHost> {
  const host = await loadSim(new Uint8Array(await readFile(new URL("build-out/sim/sim.wasm", root))));
  const manifest: SimManifest = JSON.parse(await readFile(new URL("dist/content-next/sim/manifest.json", root), "utf8"));
  try {
    await loadSimContent(host, manifest, path => readFile(new URL(`dist/content-next/${path}`, root)));
    requireStatus(host.init({ world: "fixture", ai: true, ...rules }, 1), "init"); requireStatus(host.loadMap("Arena"), "map");
    return host;
  } catch (error) { host.dispose(); throw error; }
}
function state(host: SimHost, tick: number): Extract<Message, {type: "state"}> {
  const bytes = host.saveState(); if (typeof bytes === "number") throw new Error(`save ${bytes}`);
  return { type: "state", tick, hash: BigInt(`0x${host.hash()}`), lastConsumedInputSeq: 0, bytes };
}

interface PlayoutPacket { at: number; tick: number; records: TickRecord[] }
/** Real native authority and ordered two-tick relays with a controllable receipt clock. */
async function playoutFixture(rttMs = 0, rules: Record<string, unknown> = {}) {
  const authoritative = await realHost(rules), prediction = await realHost(rules), confirmed = await realHost(rules);
  const sent: Message[] = [], input = encodeInput({ Right: true });
  let now = rttMs / 2, tick = 0, elapsedMs = 0;
  // A positive epoch lets public timing probes warm up before the fixture's
  // logical receipt time without fabricating RTT metrics or negative wire timestamps.
  const session = new OnlineSession({ prediction, confirmed, slot: 1, now: () => now + 10_000, send: message => sent.push(message) });
  now = -(2 * rttMs + 1002);
  for (let probe = 0; probe < 2; probe++) {
    session.advance(() => input);
    const ping = sent.at(-1)!;
    assert.ok(ping.type === "ping");
    now += rttMs;
    session.receive({ type: "pong", timestamp: ping.timestamp });
    if (!probe) now += 1001;
  }
  now = rttMs / 2;
  for (const slot of [1, 2]) requireStatus(authoritative.command(0, {
    kind: "join", slot, control: "authoritative", team: 0, x: slot * 20, y: -100,
  }), "playout join");
  for (; tick < 30; tick++) {
    for (const slot of [1, 2]) requireStatus(authoritative.setInput(slot, tick, { Right: true }), "playout warm input");
    requireStatus(authoritative.step(), "playout warm step"); authoritative.events();
  }
  const initial = state(authoritative, tick);
  session.receive(initial);
  return {
    session, authoritative, confirmed, sent, input, initial,
    get now() { return now; }, set now(value: number) { now = value; },
    get tick() { return tick; },
    batch(commands: SimCommand[] = []): PlayoutPacket {
      const records: TickRecord[] = [];
      for (let count = 0; count < 2; count++) {
        const view = authoritative.renderView();
        if (typeof view === "number") throw new Error(`playout render ${view}`);
        elapsedMs += 1000 / 60 / view.globals.tickScale;
        const applied = count ? [] : commands;
        for (const command of applied) requireStatus(authoritative.command(tick, command), "playout command");
        for (const slot of [1, 2]) requireStatus(authoritative.setInput(slot, tick, { Right: true }), "playout input");
        requireStatus(authoritative.step(), "playout step"); authoritative.events();
        records.push({ type: "step", tick: tick++, commands: applied.map(command => new TextEncoder().encode(JSON.stringify(command))),
          inputs: [{ slot: 1, input }, { slot: 2, input }] });
      }
      records.push({ type: "hash", tick, hash: BigInt(`0x${authoritative.hash()}`) });
      return { at: elapsedMs + rttMs / 2, tick, records };
    },
    deliver(packet: PlayoutPacket) {
      const consumed = sent.filter(message => message.type === "input").flatMap(message => message.frames)
        .filter(frame => frame.tick < packet.tick).reduce((seq, frame) => Math.max(seq, frame.seq), 0);
      session.receive({ type: "ticks", records: packet.records, lastConsumedInputSeq: consumed });
    },
    dispose() { session.dispose(); authoritative.dispose(); },
  };
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

test("reliable event batches acknowledge only their handled high watermark, including retries after callbacks or sends throw", async () => {
  const sent: Message[] = [], handled: number[] = [];
  const prediction = await realHost(), confirmed = await realHost();
  let failEvent = true, failSend = false;
  const events = new OnlineSession({ prediction, confirmed, slot: 1,
    send(message) { if (failSend) { failSend = false; throw new Error("send failed"); } sent.push(message); },
    onEvent(event) {
      if (event.id === 16 && failEvent) { failEvent = false; throw new Error("handler failed"); }
      handled.push(event.id);
    } });
  const batch = (...ids: number[]): Extract<Message, { type: "events" }> => ({ type: "events",
    events: ids.map(id => ({ id, tick: 0, header: new Uint8Array(20), payload: new Uint8Array() })) });
  const acknowledgements = () => sent.filter(message => message.type === "eventAck").map(message => message.eventId);
  try {
    events.receive(batch(10, 11, 11, 12));
    assert.deepEqual(handled, [10, 11, 12]); assert.deepEqual(acknowledgements(), [12]);
    events.receive(batch(12, 10)); events.receive(batch());
    assert.deepEqual(acknowledgements(), [12, 12], "Duplicate-only batches ACK their highest handled ID once; empty batches do not ACK");
    events.receive(batch(14));
    assert.throws(() => events.receive(batch(15, 16, 17)), /handler failed/);
    assert.deepEqual(handled, [10, 11, 12, 14, 15]);
    assert.deepEqual(acknowledgements(), [12, 12, 14], "An unprocessed suffix must not be cumulatively retired");
    events.receive(batch(15, 16, 17));
    assert.deepEqual(handled, [10, 11, 12, 14, 15, 16, 17]);
    assert.deepEqual(acknowledgements(), [12, 12, 14, 17]);
    const pending = new Set([10, 11, 12, 14, 15, 16, 17]);
    for (const id of acknowledgements()) for (const eventId of pending) if (eventId <= id) pending.delete(eventId);
    assert.equal(pending.size, 0, "One cumulative batch ACK retires the complete handled prefix");
    assert.equal(events.metrics.eventGaps, 1);
    failSend = true; assert.throws(() => events.receive(batch(18)), /send failed/);
    events.receive(batch(18));
    assert.equal(handled.filter(id => id === 18).length, 1, "An ACK send failure cannot replay a successful effect");
    assert.equal(acknowledgements().at(-1), 18);
  } finally { events.dispose(); }
});

test("matching pong RTT reductions and same-boundary correction replay cannot reverse the remote playout phase", async () => {
  const fixture = await playoutFixture(60), { session } = fixture;
  try {
    let packet = fixture.batch();
    for (let elapsed = 0; elapsed <= 973; elapsed++) {
      fixture.now = 30 + elapsed;
      while (packet.at <= fixture.now + 1e-7) { fixture.deliver(packet); packet = fixture.batch(); }
      session.present();
    }
    fixture.now = 1003; session.advance(() => fixture.input);
    const sampledViewTick = session.metrics.viewTick;
    const inputs = fixture.sent.filter(message => message.type === "input").flatMap(message => message.frames);
    assert.ok(inputs.length > 0);
    for (const frame of inputs) {
      assert.equal(frame.viewTick, sampledViewTick, "Input viewTick must report the actual presented history phase");
      assert.ok(Number.isInteger(frame.viewTick) && frame.viewTick <= frame.tick && frame.viewTick <= session.metrics.confirmedTick);
    }
    const ping = fixture.sent.filter(message => message.type === "ping").at(-1)!;
    assert.ok(ping.type === "ping");
    fixture.now = 1004;
    const before = session.present().sprites[1]!.x, phase = session.metrics.playoutPhase;
    session.receive({ type: "pong", timestamp: ping.timestamp });
    const after = session.present().sprites[1]!.x;
    assert.ok(Math.abs(session.metrics.rttMs - 48.2) < 1e-9);
    assert.equal(session.metrics.playoutPhase, phase); assert.equal(after, before);
    const boundary = session.metrics.confirmedTick, reserve = session.metrics.playoutReserveMs;
    session.receive({ type: "ticks", lastConsumedInputSeq: 0, records: [
      { type: "correct", tick: boundary - 1, slot: 2, input: fixture.input },
      { type: "hash", tick: boundary, hash: BigInt(`0x${fixture.confirmed.hash()}`) },
    ] });
    session.present();
    assert.equal(session.metrics.playoutPhase, phase); assert.equal(session.metrics.playoutReserveMs, reserve);
    assert.equal(session.metrics.rollbacks, 1); assert.equal(session.metrics.hashMismatches, 0);
  } finally { fixture.dispose(); }
});

test("two-tick remote playout retains actual history reserve independently of RTT", async () => {
  const minima: number[] = [];
  for (const rtt of [0, 30, 60, 120]) {
    const fixture = await playoutFixture(rtt), { session } = fixture;
    try {
      let packet = fixture.batch(), previous = session.metrics.playoutPhase, minimum = Infinity;
      for (let elapsed = 0; elapsed <= 2000; elapsed++) {
        fixture.now = rtt / 2 + elapsed;
        while (packet.at <= fixture.now + 1e-7) { fixture.deliver(packet); packet = fixture.batch(); }
        session.present();
        assert.ok(session.metrics.playoutPhase >= previous - 1e-9); previous = session.metrics.playoutPhase;
        if (elapsed >= 1000) {
          minimum = Math.min(minimum, session.metrics.playoutReserveMs);
          assert.ok(session.metrics.playoutPhase < session.metrics.confirmedTick, `RTT ${rtt} must not consume the interpolation reserve`);
          assert.ok(session.metrics.playoutRate >= 0.9 && session.metrics.playoutRate <= 1.1);
        }
      }
      minima.push(minimum);
      assert.ok(minimum > 8, `RTT ${rtt} must retain at least half a native tick before the next receipt`);
      assert.equal(session.metrics.playoutUnderruns, 0); assert.equal(session.metrics.hashMismatches, 0);
      assert.equal(session.metrics.playoutRebases, 0, "Steady receipt timing must slew, never seek");
    } finally { fixture.dispose(); }
  }
  assert.ok(Math.max(...minima) - Math.min(...minima) < 1e-6, "RTT cannot steer received-history occupancy");
});

for (const stallMs of [100, 250, 500]) test(`a ${stallMs} ms ordered remote stall re-buffers once and sheds backlog at the first resumed presentation`, async () => {
  const fixture = await playoutFixture(), { session } = fixture;
  const queued: PlayoutPacket[] = [];
  try {
    let packet = fixture.batch(), previous = session.metrics.playoutPhase, previousRebases = 0;
    let underrunsAtRecovery = 0;
    for (let elapsed = 0; elapsed <= 7000; elapsed += 5) {
      fixture.now = elapsed;
      while (packet.at <= elapsed + 1e-7) { queued.push(packet); packet = fixture.batch(); }
      if (elapsed < 500 || elapsed >= 500 + stallMs) while (queued.length) fixture.deliver(queued.shift()!);
      session.present();
      const phase = session.metrics.playoutPhase;
      assert.ok(phase >= previous - 1e-9);
      if (session.metrics.playoutRebases === previousRebases) {
        assert.ok(phase - previous <= 5 / (1000 / 60) * 1.1 + 1e-7, "Ordinary recovery must obey the elapsed-time rate bound");
      } else {
        assert.equal(elapsed, 500 + stallMs, "A forward rebase belongs only to the first resumed render, after the complete receive burst");
        assert.equal(session.metrics.playoutRebases, previousRebases + 1);
        assert.ok(session.metrics.playoutReserveMs <= session.metrics.interpolationMs + 1e-7);
      }
      previousRebases = session.metrics.playoutRebases;
      previous = phase;
      if (elapsed === 500 + stallMs - 5) {
        assert.equal(session.metrics.playoutBuffering, true); assert.equal(session.metrics.playoutReserveMs, 0);
        assert.equal(session.metrics.playoutRate, 0); assert.equal(session.metrics.playoutUnderruns, 1);
      }
      if (elapsed === 500 + stallMs) {
        underrunsAtRecovery = session.metrics.playoutUnderruns;
        assert.equal(session.metrics.playoutRebases, 1);
        assert.ok(session.metrics.playoutReserveMs < 60, "Outage backlog must not linger for seconds at a 1.1x catch-up rate");
      }
    }
    assert.equal(underrunsAtRecovery, 1); assert.equal(session.metrics.playoutUnderruns, 1);
    assert.equal(session.metrics.playoutRebases, 1);
    assert.equal(session.metrics.playoutBuffering, false);
    assert.ok(session.metrics.playoutReserveMs < 90, "Buffered stall debt must converge back to the normal reserve");
    assert.equal(session.metrics.hashMismatches, 0); assert.equal(session.metrics.resyncs, 0);
  } finally { fixture.dispose(); }
});

test("native 60/20/60 scheduling preserves phase and reserves the actual slow two-tick relay duration", async () => {
  const fixture = await playoutFixture(120, { bulletTime: true }), { session } = fixture;
  try {
    const packets: PlayoutPacket[] = [];
    for (let batch = 0; batch < 100; batch++) packets.push(fixture.batch(batch === 15 ? [{ kind: "kill", slot: 2 }] : []));
    let index = 0, previous = session.metrics.playoutPhase, slowSamples = 0, normalAfterSlow = 0;
    const last = Math.ceil(packets.at(-1)!.at);
    for (let at = 60; at <= last; at++) {
      fixture.now = at;
      while (packets[index] && packets[index]!.at <= at + 1e-7) fixture.deliver(packets[index++]!);
      session.present();
      assert.ok(session.metrics.playoutPhase >= previous - 1e-9); previous = session.metrics.playoutPhase;
      assert.ok(session.metrics.playoutPhase <= session.metrics.confirmedTick);
      const scale = session.authoritativeRenderView().globals.tickScale;
      if (scale < 1) {
        slowSamples++;
        assert.ok(session.metrics.interpolationMs >= 149.99, "Two 20 Hz ticks need 100 ms plus a native-step reserve");
        if (at > packets[18]!.at) assert.ok(session.metrics.playoutReserveMs > 0, "Slow relay playback must not endpoint-clamp");
      } else if (slowSamples) normalAfterSlow++;
    }
    assert.ok(slowSamples >= 1000, "Fixture must exercise native bullet time, not an artificial client timer");
    assert.ok(normalAfterSlow >= 500, "Native timer must actually return scheduling to 60 Hz");
    assert.ok(session.metrics.interpolationMs < 51);
    assert.equal(session.metrics.hashMismatches, 0); assert.equal(session.metrics.resyncs, 0);
  } finally { fixture.dispose(); }
});

test("playout bootstrap, full-state recovery and resync reset phase without retaining old elapsed-time debt", async () => {
  const fixture = await playoutFixture(), { session } = fixture;
  try {
    assert.equal(session.metrics.playoutPhase, 30); assert.equal(session.metrics.playoutBuffering, true);
    fixture.now = 20; session.present(); assert.equal(session.metrics.playoutPhase, 30);
    const first = fixture.batch(); fixture.now = first.at; fixture.deliver(first); session.present();
    assert.equal(session.metrics.playoutPhase, 30); assert.equal(session.metrics.playoutBuffering, true);
    const second = fixture.batch(); fixture.now = second.at; fixture.deliver(second); session.present();
    assert.equal(session.metrics.playoutBuffering, false);
    fixture.now += 10; session.present(); assert.ok(session.metrics.playoutPhase > 30);
    const snapshot = state(fixture.confirmed, second.tick);
    session.receive(snapshot);
    assert.equal(session.metrics.playoutPhase, second.tick); assert.equal(session.metrics.playoutReserveMs, 0);
    assert.equal(session.metrics.playoutBuffering, true);
    fixture.now += 100; session.present(); assert.equal(session.metrics.playoutPhase, second.tick);
    session.receive({ type: "ticks", lastConsumedInputSeq: 0, records: [
      { type: "hash", tick: second.tick, hash: snapshot.hash ^ 1n },
    ] });
    fixture.now += 100; session.present();
    assert.equal(session.metrics.status, "resynchronizing"); assert.equal(session.metrics.playoutPhase, second.tick);
    assert.equal(session.metrics.playoutRate, 0);
    session.receive(fixture.initial);
    assert.equal(session.metrics.playoutPhase, 30, "Only an explicit full-state epoch can reset phase backwards");
    assert.equal(session.metrics.playoutReserveMs, 0); assert.equal(session.metrics.playoutBuffering, true);
    fixture.now += 10; session.present(); assert.equal(session.metrics.playoutPhase, 30);
  } finally { fixture.dispose(); }
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
    assert.equal(session.metrics.playoutPhase, 12); assert.equal(session.metrics.playoutReserveMs, 0);
    assert.equal(session.metrics.playoutBuffering, true);
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
    assert.equal(session.metrics.playoutPhase, 0); assert.equal(session.metrics.playoutRate, 0);
    assert.equal(session.metrics.playoutReserveMs, 0); assert.equal(session.metrics.playoutBuffering, true);
    session.receive(state(authoritative, 0));
    session.receive({ type: "control-state", state: { host: true, admin: false, paused: false, muted: false, vote: null } });
    now += 17; session.advance(() => encodeInput({}));
    assert.ok(session.predictionWorld.tick <= 4); assert.equal(sent.filter(m => m.type === "resync").length, 0);
    assert.equal(session.metrics.playoutPhase, 0); assert.equal(session.metrics.playoutBuffering, true);
    session.sendFeature({ type: "gesture", gesture: "victory" }); assert.equal(sent.at(-1)!.type, "gesture");
    assert.throws(() => session.receive({ type: "self-kill" }), /Client-originated/);
  } finally { session.dispose(); authoritative.dispose(); }
});

for (const hz of [60, 120, 144]) test(`real WASM local presentation keeps root and skeleton on one render phase at ${hz} Hz with delayed burst delivery`, async () => {
    const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
    const sent: Extract<Message, { type: "input" }>[] = []; let now = 0;
    const session = new OnlineSession({ prediction, confirmed, slot: 1, now: () => now,
      send(message) { if (message.type === "input") sent.push(message); } });
    try {
      requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative", team: 0 }), "join");
      for (let tick = 0; tick < 30; tick++) {
        requireStatus(authoritative.setInput(1, tick, { Right: true }), "warm input");
        requireStatus(authoritative.step(), "warm step"); authoritative.events();
      }
      session.receive(state(authoritative, 30));
      const input = encodeInput({ Right: true });
      const camera = createCamera(1280, 720), referenceCamera = createCamera(1280, 720);
      const cameraPresentation = new CameraPresentation(camera);
      const pending: TickRecord[] = [];
      let serverTick = 30, previousX = session.predictionWorld.sprites[0]!.x, previousY = session.predictionWorld.sprites[0]!.y;
      let movingFrames = 0, fixedSteps = 0;
      let maxRootPhaseError = 0, maxPosePhaseError = 0, maxCameraPhaseError = 0, maxFrameRootDelta = 0;
      let lastDisplayX: number | undefined, lastDisplayY = 0;
      for (let frame = 0; frame <= hz / 2; frame++) {
        now = frame * 1000 / hz;
        while (serverTick < 30 + Math.floor(now * 60 / 1000)) {
          requireStatus(authoritative.setInput(1, serverTick, { Right: true }), "server input");
          requireStatus(authoritative.step(), "server step"); authoritative.events();
          pending.push({ type: "step", tick: serverTick++, commands: [], inputs: [{ slot: 1, input }] });
        }
        // Keep authoritative simulation steady while delivering 4-tick bursts.
        if (pending.length >= 4) {
          const boundary = serverTick;
          const consumed = sent.flatMap(message => message.frames).filter(frame => frame.tick < boundary).reduce((seq, frame) => Math.max(seq, frame.seq), 0);
          session.receive({ type: "ticks", records: pending.splice(0), lastConsumedInputSeq: consumed });
          assert.equal(confirmed.hash(), authoritative.hash());
        }
        session.advance(() => input, () => {
          cameraPresentation.capture();
          const local = session.predictionWorld.sprites[0]!;
          previousX = local.x; previousY = local.y;
        }, () => {
          const local = session.predictionWorld.sprites[0]!;
          updateCamera(camera, local.x, local.y, camera.x, camera.y);
          updateCamera(referenceCamera, local.x, local.y, referenceCamera.x, referenceCamera.y);
          fixedSteps++;
        });
        const local = session.predictionWorld.sprites[0]!, hash = prediction.hash();
        const readyX = session.world.sprites[0]!.x, readyY = session.world.sprites[0]!.y;
        const displayFraction = session.presentationFraction, ready = session.world.sprites[0]!;
        for (let point = 0; point < local.current.length; point++) {
          const expected = local.previous[point]! + (local.current[point]! - local.previous[point]!) * displayFraction;
          maxPosePhaseError = Math.max(maxPosePhaseError, Math.abs(ready.current[point]! - expected));
          assert.ok(Math.abs(ready.current[point]! - expected) < 0.0001, "Native skeleton must publish the current display phase before rendering");
        }
        if (lastDisplayX !== undefined) maxFrameRootDelta = Math.max(maxFrameRootDelta, Math.hypot(readyX - lastDisplayX, readyY - lastDisplayY));
        lastDisplayX = readyX; lastDisplayY = readyY;
        const presented = session.present(0.5).sprites[0]!;
        if (Math.hypot(local.x - previousX, local.y - previousY) > 0.001) {
          movingFrames++;
          maxRootPhaseError = Math.max(maxRootPhaseError, Math.abs(presented.x - (previousX + local.x) / 2), Math.abs(presented.y - (previousY + local.y) / 2));
          assert.ok(Math.abs(presented.x - (previousX + local.x) / 2) < 0.0001, "Root must interpolate between the same native ticks as the skeleton");
          assert.ok(Math.abs(presented.y - (previousY + local.y) / 2) < 0.0001);
          for (let point = 0; point < local.current.length; point++) {
            maxPosePhaseError = Math.max(maxPosePhaseError, Math.abs(presented.current[point]! - (local.previous[point]! + local.current[point]!) / 2));
            assert.ok(Math.abs(presented.current[point]! - (local.previous[point]! + local.current[point]!) / 2) < 0.0001);
          }
        }
        maxRootPhaseError = Math.max(maxRootPhaseError, Math.abs(readyX - (previousX + (local.x - previousX) * displayFraction)),
          Math.abs(readyY - (previousY + (local.y - previousY) * displayFraction)));
        assert.ok(Math.abs(readyX - (previousX + (local.x - previousX) * displayFraction)) < 0.0001, "advance must publish the completed prediction at this frame's clock phase");
        assert.ok(Math.abs(readyY - (previousY + (local.y - previousY) * displayFraction)) < 0.0001);
        const halfCamera = { ...cameraPresentation.present(0.5) };
        const leftCamera = { ...cameraPresentation.present(0) };
        const displayCamera = { ...cameraPresentation.present(displayFraction) };
        maxCameraPhaseError = Math.max(maxCameraPhaseError, Math.abs(displayCamera.x - (leftCamera.x + (camera.x - leftCamera.x) * displayFraction)),
          Math.abs(displayCamera.y - (leftCamera.y + (camera.y - leftCamera.y) * displayFraction)));
        assert.ok(Math.abs(halfCamera.x - (leftCamera.x + camera.x) / 2) < 1e-9);
        assert.ok(Math.abs(halfCamera.y - (leftCamera.y + camera.y) / 2) < 1e-9);
        assert.equal(prediction.hash(), hash, "Presentation cannot mutate native gameplay");
        assert.equal(session.metrics.hashMismatches, 0);
        assert.deepEqual(camera, referenceCamera, "Camera must advance only at native fixed steps");
      }
      assert.ok(movingFrames >= 5, "Fixture must exercise actual native movement");
      assert.ok(fixedSteps >= 25);
      assert.ok(maxCameraPhaseError < 1e-9, "Rendered camera must share the local native pose's display phase");
      assert.equal(session.metrics.resyncs, 0);
      assert.equal(session.metrics.lastConsumedInputSeq > 0, true);
      console.info("online-presentation", JSON.stringify({ hz, frames: Math.floor(hz / 2) + 1, movingFrames, fixedSteps,
        maxRootPhaseError, maxPosePhaseError, maxCameraPhaseError, maxFrameRootDelta }));
    } finally { session.dispose(); authoritative.dispose(); }
});

test("real WASM reconciliation preserves the displayed fractional root and complete pose", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  let now = 0;
  const session = new OnlineSession({ prediction, confirmed, slot: 1, now: () => now, send() {} });
  try {
    requireStatus(authoritative.command(0, { kind: "join", slot: 1, control: "authoritative", team: 0 }), "join");
    for (let tick = 0; tick < 30; tick++) {
      requireStatus(authoritative.setInput(1, tick, { Right: true }), "warm input");
      requireStatus(authoritative.step(), "warm step"); authoritative.events();
    }
    session.receive(state(authoritative, 30));
    now = 10;
    session.advance(() => encodeInput({ Right: true }));
    const rendered = session.present().sprites[0]!;
    const before = { x: rendered.x, y: rendered.y, pose: rendered.current.slice() };
    requireStatus(authoritative.setInput(1, 30, { Left: true }), "changed authoritative input");
    requireStatus(authoritative.step(), "authoritative correction"); authoritative.events();
    session.receive({ type: "ticks", lastConsumedInputSeq: 1, records: [
      { type: "step", tick: 30, commands: [], inputs: [{ slot: 1, input: encodeInput({ Left: true }) }] },
      { type: "hash", tick: 31, hash: BigInt(`0x${authoritative.hash()}`) },
    ] });
    assert.ok(session.metrics.correction > 0.001, "Fixture must actually reconcile native movement");
    const hash = prediction.hash(), corrected = session.present().sprites[0]!;
    assert.ok(Math.abs(corrected.x - before.x) < 0.0001, "A packet must not move the visible root backwards");
    assert.ok(Math.abs(corrected.y - before.y) < 0.0001);
    for (let point = 0; point < before.pose.length; point++) {
      assert.ok(Math.abs(corrected.current[point]! - before.pose[point]!) < 0.0001, `Pose point ${point} must remain continuous through rollback`);
    }
    const sameFrame = corrected.current.slice();
    session.present(); session.present();
    assert.deepEqual(session.world.sprites[0]!.current, sameFrame, "Multiple render consumers must not decay a correction twice");
    assert.equal(prediction.hash(), hash); assert.equal(confirmed.hash(), authoritative.hash());
    assert.equal(session.metrics.hashMismatches, 0); assert.equal(session.metrics.lastConsumedInputSeq, 1);
    assert.equal(session.metrics.resyncs, 0);
    now += 40;
    const fraction = session.presentationFraction, decay = Math.exp(-40 / 80), native = session.predictionWorld.sprites[0]!;
    const eased = session.present().sprites[0]!;
    for (let point = 0; point < before.pose.length; point++) {
      const raw = native.previous[point]! + (native.current[point]! - native.previous[point]!) * fraction;
      assert.ok(Math.abs(eased.current[point]! - (raw + (before.pose[point]! - raw) * decay)) < 0.0001, "Correction easing must use elapsed time, not render-call count");
    }
    assert.equal(prediction.hash(), hash);
    const nextBefore = { x: eased.x, y: eased.y, pose: eased.current.slice() };
    requireStatus(authoritative.setInput(1, 31, { Left: true }), "second changed input");
    requireStatus(authoritative.step(), "second authoritative correction"); authoritative.events();
    session.receive({ type: "ticks", lastConsumedInputSeq: 2, records: [
      { type: "step", tick: 31, commands: [], inputs: [{ slot: 1, input: encodeInput({ Left: true }) }] },
      { type: "hash", tick: 32, hash: BigInt(`0x${authoritative.hash()}`) },
    ] });
    const second = session.present().sprites[0]!;
    assert.ok(Math.abs(second.x - nextBefore.x) < 0.0001); assert.ok(Math.abs(second.y - nextBefore.y) < 0.0001);
    for (let point = 0; point < nextBefore.pose.length; point++) assert.ok(Math.abs(second.current[point]! - nextBefore.pose[point]!) < 0.0001);
    assert.notEqual(prediction.hash(), hash, "Second authoritative movement actually changes native prediction");
    assert.equal(confirmed.hash(), authoritative.hash()); assert.equal(session.metrics.lastConsumedInputSeq, 2);
    assert.equal(session.metrics.hashMismatches, 0); assert.equal(session.metrics.resyncs, 0);
  } finally { session.dispose(); authoritative.dispose(); }
});

test("real WASM respawn, spectator team, slot reuse and round snapshots do not blend unrelated lives", async () => {
  const authoritative = await realHost(), prediction = await realHost(), confirmed = await realHost();
  let now = 0;
  const session = new OnlineSession({ prediction, confirmed, slot: 1, now: () => now, send() {} });
  try {
    for (const slot of [1, 2]) requireStatus(authoritative.command(0, { kind: "join", slot, control: "authoritative", team: 0 }), "join");
    session.receive(state(authoritative, 0));
    now = 10; session.advance(() => encodeInput({ Right: true }));
    let tick = 0;
    const deliver = (commands: SimCommand[]) => {
      for (const command of commands) requireStatus(authoritative.command(tick, command), "boundary command");
      const input = encodeInput({});
      for (const slot of [1, 2]) requireStatus(authoritative.setInput(slot, tick, {}), "boundary input");
      requireStatus(authoritative.step(), "boundary step"); authoritative.events();
      const stepTick = tick++;
      session.receive({ type: "ticks", lastConsumedInputSeq: 0, records: [
        { type: "step", tick: stepTick, commands: commands.map(command => new TextEncoder().encode(JSON.stringify(command))), inputs: [{ slot: 1, input }, { slot: 2, input }] },
        { type: "hash", tick, hash: BigInt(`0x${authoritative.hash()}`) },
      ] });
      assert.equal(confirmed.hash(), authoritative.hash());
    };
    const oldRemoteX = session.present().sprites[1]!.x;
    const oldRemotePhase = session.metrics.playoutPhase;
    deliver([{ kind: "spawn", slot: 1, x: 500, y: -100 }, { kind: "spawn", slot: 2, x: 600, y: -100 }]);
    assert.equal(session.metrics.playoutPhase, oldRemotePhase, "A per-soldier life reset cannot reset the shared remote clock");
    const newLife = session.present(0).sprites[1]!;
    assert.equal(newLife.x, session.authoritativeRenderView().sprite(1).posX, "A new remote life starts at its received spawn, even while old history is buffering");
    now += session.metrics.interpolationMs - 1000 / 120;
    const snapped = session.present(0).sprites;
    const authoritativeRemote = confirmed.renderView();
    if (typeof authoritativeRemote === "number") throw new Error(`render ${authoritativeRemote}`);
    assert.notEqual(authoritativeRemote.sprite(1).posX, oldRemoteX, "Fixture must relocate the remote soldier");
    assert.equal(snapped[1]!.x, authoritativeRemote.sprite(1).posX, "Remote interpolation cannot cross a spawn command");
    assert.deepEqual(snapped[1]!.current, authoritativeRemote.sprite(1).currentSkeleton);
    assert.equal(snapped[0]!.x, authoritativeRemote.sprite(0).posX, "Local interpolation starts at the new life's native root");
    deliver([{ kind: "kill", slot: 1 }]);
    assert.equal((session.present(0).sprites[0]!.flags & 2) !== 0, true);
    deliver([{ kind: "spawn", slot: 1, x: -500, y: -100 }]);
    assert.equal(session.present(0).sprites[0]!.x, -500, "Dead-to-live correction must start at the new spawn");
    deliver([{ kind: "team", slot: 1, team: 5 }]);
    assert.equal(session.present(0).sprites[0]!.team, 5);
    deliver([{ kind: "leave", slot: 2 }, { kind: "join", slot: 2, control: "authoritative", team: 0, x: -700, y: -100 }]);
    now += session.metrics.interpolationMs - 1000 / 120;
    const reused = confirmed.renderView();
    if (typeof reused === "number") throw new Error(`render ${reused}`);
    assert.equal(session.present().sprites[1]!.x, reused.sprite(1).posX, "A reused slot cannot inherit the old occupant's interpolation");
    session.resetRound();
    for (const host of [authoritative, prediction, confirmed]) requireStatus(host.loadMap("Arena"), "round map");
    session.receive(state(authoritative, tick));
    const boundary = session.present(0);
    for (const sprite of boundary.sprites) if (sprite.active) {
      const native = session.predictionWorld.sprites[sprite.slot - 1]!;
      assert.equal(sprite.x, native.x); assert.equal(sprite.y, native.y);
      assert.deepEqual(sprite.current, native.current);
    }
    assert.equal(session.metrics.hashMismatches, 0); assert.equal(session.metrics.resyncs, 0);
  } finally { session.dispose(); authoritative.dispose(); }
});
