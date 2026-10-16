import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { resolve } from "node:path";
import { MAX_CLIENT_PACKET_BYTES, encodeMessage, PROTOCOL_VERSION, ProtocolError, type InputFrame, type Message } from "@soldat-web/protocol";
import { encodeInput } from "@soldat-web/sim-host";
import { RawPeer, delay, qualificationServer, type QualificationServer } from "./support.ts";

let rig: QualificationServer;
const out = resolve(process.env.NET_G4_SECURITY_OUT ?? "build-out/net-g4/security");
before(async () => { rig = await qualificationServer(out); });
after(async () => { await rig?.close(); });

function boundaryTick(message: Extract<Message, { type: "ticks" | "state" }>): number {
  if (message.type === "state") return message.tick;
  const last = message.records.at(-1);
  if (!last) throw new Error("Empty relay");
  return last.tick + (last.type === "step" ? 1 : 0);
}
function humanInputs(message: Extract<Message, { type: "ticks" }>): {slot: number; input: Uint8Array}[] {
  const step = message.records.findLast(record => record.type === "step");
  if (!step || step.type !== "step") throw new Error("Expected confirmed step");
  return step.inputs;
}

async function activePeer() {
  const peer = new RawPeer(rig.url);
  const welcome = await peer.connect(rig.manifest.sha256);
  const snapshot = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks");
  return { peer, snapshot, welcome };
}

for (const [name, packet] of [
  ["truncated header", Uint8Array.of(PROTOCOL_VERSION, 0, 3)],
  ["unknown type", Uint8Array.of(PROTOCOL_VERSION, 0, 255, 0, 0, 0, 0, 0)],
  ["JSON NaN injection", new TextEncoder().encode('{"type":"input","tick":NaN,"x":NaN}')],
  ["JSON infinity injection", new TextEncoder().encode('{"type":"input","tick":Infinity,"y":-Infinity}')],
] as const) {
  test(`real WSS rejects ${name} without worker failure`, async () => {
    const { peer } = await activePeer();
    try {
      const closed = once(peer.socket, "close"); peer.socket.send(packet);
      const [code, reason] = await closed;
      rig.evidence.record({ type: "security", case: name, closeCode: code, reason: String(reason) });
      assert.equal(code, 1002, "Framing violations close at transport protocol boundary");
    } finally { await peer.close(); }
  });
}

test("wire integer-only fields reject NaN/infinity before serialization", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const field of ["seq", "tick", "viewTick"] as const) {
      const frame: InputFrame = { seq: 1, tick: 1, viewTick: 0, input: encodeInput({}), [field]: value };
      assert.throws(() => encodeMessage({ type: "input", frames: [frame] }), ProtocolError);
    }
    for (const field of ["MouseAimX", "MouseAimY", "MouseDist"] as const) assert.throws(() => encodeInput({ [field]: value }), RangeError);
  }
  rig.evidence.record({ type: "security", case: "NaN/Inf", result: "all numeric ingress fields rejected; wire has no floating-point numeric fields" });
});

test("raw IEEE NaN/inf bit patterns cannot smuggle float controls", async () => {
  for (const pattern of [0x7fc00000, 0x7f800000, 0xff800000]) {
    const { peer, snapshot } = await activePeer();
    try {
      const packet = encodeMessage({ type: "input", frames: [{ seq: 1, tick: boundaryTick(snapshot) + 2, viewTick: boundaryTick(snapshot), input: encodeInput({}) }] });
      // Last four input bytes contain press-order + reserved, not floats.
      new DataView(packet.buffer, packet.byteOffset, packet.byteLength).setUint32(packet.length - 4, pattern, true);
      const closed = once(peer.socket, "close"); peer.socket.send(packet);
      const [code] = await closed; assert.equal(code, 1008);
      rig.evidence.record({ type: "security", case: "raw-float-bits", pattern, closeCode: code });
    } finally { await peer.close(); }
  }
});

for (const attack of ["sequence-jump", "future-target", "stale-target", "future-view-fire"] as const) {
  test(`real worker never consumes ${attack}`, async () => {
    const { peer, snapshot, welcome } = await activePeer();
    try {
      const frame: InputFrame = { seq: 1, tick: boundaryTick(snapshot) + 3, viewTick: boundaryTick(snapshot), input: encodeInput({ Fire: attack.includes("fire") }) };
      if (attack === "sequence-jump") frame.seq = 1_000_000;
      if (attack === "future-target") frame.tick = boundaryTick(snapshot) + 16;
      if (attack === "stale-target") { frame.tick = Math.max(0, boundaryTick(snapshot) - 30); frame.viewTick = frame.tick; }
      if (attack === "future-view-fire") frame.viewTick = frame.tick + 1000;
      const start = peer.messages.length; peer.send({ type: "input", frames: [frame] });
      const later = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && boundaryTick(m) >= boundaryTick(snapshot) + 8, start);
      assert.equal(later.lastConsumedInputSeq, 0);
      assert.equal(humanInputs(later).find(entry => entry.slot === welcome.slot)?.input[0] ?? 0, 0);
      rig.evidence.record({ type: "security", case: attack, frame: { seq: frame.seq, tick: frame.tick, viewTick: frame.viewTick }, snapshotTick: boundaryTick(later), consumedSequence: later.lastConsumedInputSeq });
    } finally { await peer.close(); }
  });
}

for (const expired of ["stale-view-fire", "stale-fire"] as const) {
  test(`real worker applies ${expired} at present without historical compensation`, async () => {
    const { peer, snapshot: initial, welcome } = await activePeer();
    try {
      const snapshot = boundaryTick(initial) >= 40 ? initial : await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && boundaryTick(m) >= 40);
      const start = peer.messages.length, metricsStart = rig.metrics.length;
      const tick = expired === "stale-fire" ? Math.max(0, boundaryTick(snapshot) - 30) : boundaryTick(snapshot);
      peer.send({ type: "input", frames: [{ seq: 1, tick, viewTick: expired === "stale-fire" ? tick : Math.max(0, tick - 30), input: encodeInput({ Fire: true }) }] });
      const later = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && boundaryTick(m) >= boundaryTick(snapshot) + 8, start);
      assert.equal(later.lastConsumedInputSeq, 1);
      assert.equal(humanInputs(later).find(entry => entry.slot === welcome.slot)?.input[0] ?? 0, 16);
      await delay(1100);
      const metrics = rig.metrics.slice(metricsStart);
      assert.ok(metrics.reduce((sum, sample) => sum + sample.uncompensatedShots, 0) >= 1);
      assert.equal(metrics.reduce((sum, sample) => sum + sample.replayTicks, 0), 0);
      rig.evidence.record({ type: "security", case: expired, result: "present-only original Fire, no historical insertion", snapshotTick: boundaryTick(later), consumedSequence: later.lastConsumedInputSeq });
    } finally { await peer.close(); }
  });
}

test("flooding closes only attacker while healthy player advances", async () => {
  const attacker = await activePeer(), healthy = await activePeer();
  try {
    const closed = once(attacker.peer.socket, "close");
    const packet = encodeMessage({ type: "input", frames: [{ seq: 1, tick: boundaryTick(attacker.snapshot) + 1000, viewTick: boundaryTick(attacker.snapshot), input: encodeInput({}) }] });
    for (let i = 0; i < 256; i++) attacker.peer.socket.send(packet);
    const [code, reason] = await closed; assert.equal(code, 1008);
    const snapshot = await healthy.peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && boundaryTick(m) > boundaryTick(healthy.snapshot) + 6);
    rig.evidence.record({ type: "security", case: "flood", closeCode: code, reason: String(reason), healthyTick: boundaryTick(snapshot) });
    assert.equal(healthy.peer.closed, undefined);
  } finally { await attacker.peer.close(); await healthy.peer.close(); }
});

test("stalled input neutralizes held fire/jet and gains no simulation time", async () => {
  const { peer, snapshot } = await activePeer();
  try {
    const startAt = performance.now(), start = peer.messages.length;
    peer.send({ type: "input", frames: [{ seq: 1, tick: boundaryTick(snapshot) + 2, viewTick: boundaryTick(snapshot), input: encodeInput({ Right: true, Jetpack: true, Fire: true }) }] });
    const consumed = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && m.lastConsumedInputSeq === 1, start);
    const stalled = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && boundaryTick(m) > boundaryTick(consumed) + 20, start);
    const own = humanInputs(stalled).find(entry => entry.slot === humanInputs(consumed).find(entry => entry.input[0])?.slot);
    assert.ok(humanInputs(stalled).every(entry => entry.input.every(byte => byte === 0)), `held controls survived input stall: ${own?.input}`);
    const elapsed = performance.now() - startAt;
    assert.ok(boundaryTick(stalled) - boundaryTick(snapshot) <= Math.ceil(elapsed * 0.06) + 5);
    peer.send({ type: "input", frames: [{ seq: 2, tick: boundaryTick(stalled) + 60_000, viewTick: boundaryTick(stalled), input: encodeInput({ Fire: true }) }] });
    const later = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && boundaryTick(m) > boundaryTick(stalled) + 4, peer.messages.length);
    assert.equal(later.lastConsumedInputSeq, 1);
    rig.evidence.record({ type: "security", case: "stalled-time", elapsedMs: elapsed, startTick: boundaryTick(snapshot), stalledTick: boundaryTick(stalled), finalTick: boundaryTick(later), consumedSequence: later.lastConsumedInputSeq, controlsNeutral: true });
  } finally { await peer.close(); }
});

test("explicit resync rebases sequence once without granting extra simulation ticks", async () => {
  const { peer, snapshot } = await activePeer();
  try {
    peer.send({ type: "input", frames: [{ seq: 10_000, tick: boundaryTick(snapshot) + 3, viewTick: boundaryTick(snapshot), input: encodeInput({ Right: true }) }] });
    const rejected = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && boundaryTick(m) >= boundaryTick(snapshot) + 6);
    assert.equal(rejected.lastConsumedInputSeq, 0);
    await delay(550); // Explicit resync is rate-limited, never an ACK handshake.
    peer.send({ type: "resync" });
    const full = await peer.waitFor((m): m is Extract<Message, { type: "state" }> => m.type === "state", peer.messages.length);
    const started = performance.now();
    peer.send({ type: "input", frames: [{ seq: 10_000, tick: boundaryTick(full) + 2, viewTick: boundaryTick(full), input: encodeInput({ Right: true }) }] });
    const rebased = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && m.lastConsumedInputSeq === 10_000, peer.messages.length);
    assert.ok(boundaryTick(rebased) - boundaryTick(full) <= Math.ceil((performance.now() - started) * 0.06) + 5);
    peer.send({ type: "input", frames: [{ seq: 20_000, tick: boundaryTick(rebased) + 3, viewTick: boundaryTick(rebased), input: encodeInput({ Right: true }) }] });
    const rejectedAgain = await peer.waitFor((m): m is Extract<Message, { type: "ticks" }> => m.type === "ticks" && boundaryTick(m) >= boundaryTick(rebased) + 6, peer.messages.length);
    assert.equal(rejectedAgain.lastConsumedInputSeq, 10_000);
    rig.evidence.record({ type: "security", case: "explicit-resync-sequence", before: rejected.lastConsumedInputSeq, after: rebased.lastConsumedInputSeq, rejectedSecondJump: rejectedAgain.lastConsumedInputSeq, elapsedMs: performance.now() - started });
  } finally { await peer.close(); }
});

test("bootstrap streams without ACK and coalesces repeated resync requests", async () => {
  const peer = new RawPeer(rig.url);
  try {
    await peer.connect(rig.manifest.sha256);
    const full = await peer.waitFor((m): m is Extract<Message, {type: "state"}> => m.type === "state");
    const started = performance.now();
    for (let i = 0; i < 4; i++) peer.send({type: "resync"});
    await delay(1250);
    assert.equal(peer.messages.filter(message => message.type === "state").length, 2, "initial rate-window burst must coalesce to one deferred state");
    const next = await peer.waitFor((m): m is Extract<Message, {type: "ticks"}> => m.type === "ticks" && boundaryTick(m) > full.tick + 10);
    assert.ok(boundaryTick(next) - full.tick <= Math.ceil((performance.now() - started) * 0.06) + 5);
    await peer.waitFor((m): m is Extract<Message, {type: "ping"}> => m.type === "ping");
    const index = peer.messages.length;
    for (let i = 0; i < 4; i++) peer.send({type: "resync"});
    await peer.waitFor((m): m is Extract<Message, {type: "state"}> => m.type === "state", index);
    await delay(50);
    assert.equal(peer.messages.filter(message => message.type === "state").length, 3);
    assert.equal(peer.closed, undefined);
  } finally { await peer.close(); }
});

test("malformed peers leave only expected protocol diagnostics and worker stays healthy", async () => {
  await delay(50);
  assert.ok(rig.errors.every(error => error.startsWith("ProtocolError:")), rig.errors.join("\n"));
  const { peer } = await activePeer();
  try { assert.equal(peer.closed, undefined); }
  finally { await peer.close(); }
});

test("F-04 oversized client message is rejected at WSS maxPayload before adapter delivery", async () => {
  const { peer } = await activePeer();
  try {
    const closed = once(peer.socket, "close");
    peer.socket.send(new Uint8Array(MAX_CLIENT_PACKET_BYTES + 1));
    const [code] = await closed; assert.equal(code, 1009);
  } finally { await peer.close(); }
});

test("F-06 aggregate control flood closes the session with an explicit reason", async () => {
  const { peer } = await activePeer();
  try {
    const closed = once(peer.socket, "close");
    for (let index = 0; index < 100; index++) peer.send({ type: "resync" });
    const [code, reason] = await closed;
    assert.equal(code, 1008); assert.match(String(reason), /Control rate limit/);
  } finally { await peer.close(); }
});

test("F-06 client ping burst receives only one response in a 250ms window", async () => {
  const { peer, snapshot } = await activePeer();
  try {
    const start = peer.messages.length;
    for (let index = 0; index < 20; index++) peer.send({ type: "ping", timestamp: BigInt(index) });
    await peer.waitFor((message): message is Extract<Message, { type: "ticks" }> => message.type === "ticks" && boundaryTick(message) >= boundaryTick(snapshot) + 8, start);
    assert.equal(peer.messages.slice(start).filter(message => message.type === "pong").length, 1);
    assert.equal(peer.closed, undefined);
  } finally { await peer.close(); }
});
