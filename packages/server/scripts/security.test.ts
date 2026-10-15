import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { resolve } from "node:path";
import { encodeMessage, ProtocolError, type InputFrame, type Message } from "@soldat-web/protocol";
import { encodeInput } from "@soldat-web/sim-host";
import { RawPeer, delay, qualificationServer, type QualificationServer } from "./support.ts";

let rig: QualificationServer;
const out = resolve(process.env.NET_G4_SECURITY_OUT ?? "build-out/net-g4/security");
before(async () => { rig = await qualificationServer(out); });
after(async () => { await rig?.close(); });

async function activePeer() {
  const peer = new RawPeer(rig.url);
  await peer.connect(rig.manifest.sha256);
  const snapshot = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot");
  return { peer, snapshot };
}

for (const [name, packet] of [
  ["truncated header", Uint8Array.of(2, 0, 3)],
  ["unknown type", Uint8Array.of(2, 0, 255, 0, 0, 0, 0, 0)],
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
      const packet = encodeMessage({ type: "input", frames: [{ seq: 1, tick: snapshot.serverTick + 2, viewTick: snapshot.serverTick, input: encodeInput({}) }] });
      // Last four input bytes contain press-order + reserved, not floats.
      new DataView(packet.buffer, packet.byteOffset, packet.byteLength).setUint32(packet.length - 4, pattern, true);
      const closed = once(peer.socket, "close"); peer.socket.send(packet);
      const [code] = await closed; assert.equal(code, 1008);
      rig.evidence.record({ type: "security", case: "raw-float-bits", pattern, closeCode: code });
    } finally { await peer.close(); }
  }
});

for (const attack of ["sequence-jump", "future-target", "stale-target", "future-view-fire", "stale-view-fire", "stale-fire"] as const) {
  test(`real worker never consumes ${attack}`, async () => {
    const { peer, snapshot } = await activePeer();
    try {
      const frame: InputFrame = { seq: 1, tick: snapshot.serverTick + 3, viewTick: snapshot.serverTick, input: encodeInput({ Fire: attack.includes("fire") }) };
      if (attack === "sequence-jump") frame.seq = 1_000_000;
      if (attack === "future-target") frame.tick = snapshot.serverTick + 16;
      if (attack === "stale-target") { frame.tick = Math.max(0, snapshot.serverTick - 30); frame.viewTick = frame.tick; }
      if (attack === "future-view-fire") frame.viewTick = frame.tick + 1000;
      if (attack === "stale-view-fire") { frame.tick = Math.max(30, frame.tick); frame.viewTick = frame.tick - 30; }
      if (attack === "stale-fire") { frame.tick = Math.max(0, snapshot.serverTick - 30); frame.viewTick = frame.tick; }
      const start = peer.messages.length; peer.send({ type: "input", frames: [frame] });
      const later = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.serverTick >= snapshot.serverTick + 8, start);
      assert.equal(later.lastConsumedInputSeq, 0);
      assert.equal(later.inputs.find(entry => entry.slot === 1)?.input[0] ?? 0, 0);
      rig.evidence.record({ type: "security", case: attack, frame: { seq: frame.seq, tick: frame.tick, viewTick: frame.viewTick }, snapshotTick: later.serverTick, consumedSequence: later.lastConsumedInputSeq });
    } finally { await peer.close(); }
  });
}

test("flooding closes only attacker while healthy player advances", async () => {
  const attacker = await activePeer(), healthy = await activePeer();
  try {
    const closed = once(attacker.peer.socket, "close");
    const packet = encodeMessage({ type: "input", frames: [{ seq: 1, tick: attacker.snapshot.serverTick + 1000, viewTick: attacker.snapshot.serverTick, input: encodeInput({}) }] });
    for (let i = 0; i < 256; i++) attacker.peer.socket.send(packet);
    const [code, reason] = await closed; assert.equal(code, 1008);
    const snapshot = await healthy.peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.serverTick > healthy.snapshot.serverTick + 6);
    rig.evidence.record({ type: "security", case: "flood", closeCode: code, reason: String(reason), healthyTick: snapshot.serverTick });
    assert.equal(healthy.peer.closed, undefined);
  } finally { await attacker.peer.close(); await healthy.peer.close(); }
});

test("stalled input neutralizes held fire/jet and gains no simulation time", async () => {
  const { peer, snapshot } = await activePeer();
  try {
    const startAt = performance.now(), start = peer.messages.length;
    peer.send({ type: "input", frames: [{ seq: 1, tick: snapshot.serverTick + 2, viewTick: snapshot.serverTick, input: encodeInput({ Right: true, Jetpack: true, Fire: true }) }] });
    const consumed = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.lastConsumedInputSeq === 1, start);
    const stalled = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.serverTick > consumed.serverTick + 20, start);
    const own = stalled.inputs.find(entry => entry.slot === consumed.inputs.find(entry => entry.input[0])?.slot);
    assert.ok(stalled.inputs.every(entry => entry.input.every(byte => byte === 0)), `held controls survived input stall: ${own?.input}`);
    const elapsed = performance.now() - startAt;
    assert.ok(stalled.serverTick - snapshot.serverTick <= Math.ceil(elapsed * 0.06) + 5);
    peer.send({ type: "input", frames: [{ seq: 2, tick: stalled.serverTick + 60_000, viewTick: stalled.serverTick, input: encodeInput({ Fire: true }) }] });
    const later = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.serverTick > stalled.serverTick + 4, peer.messages.length);
    assert.equal(later.lastConsumedInputSeq, 1);
    rig.evidence.record({ type: "security", case: "stalled-time", elapsedMs: elapsed, startTick: snapshot.serverTick, stalledTick: stalled.serverTick, finalTick: later.serverTick, consumedSequence: later.lastConsumedInputSeq, controlsNeutral: true });
  } finally { await peer.close(); }
});

test("explicit resync rebases sequence once without granting extra simulation ticks", async () => {
  const { peer, snapshot } = await activePeer();
  try {
    peer.send({ type: "input", frames: [{ seq: 10_000, tick: snapshot.serverTick + 3, viewTick: snapshot.serverTick, input: encodeInput({ Right: true }) }] });
    const rejected = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.serverTick >= snapshot.serverTick + 6);
    assert.equal(rejected.lastConsumedInputSeq, 0);
    peer.send({ type: "resync", baselineId: 0 });
    const full = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.baselineId === 0, peer.messages.length);
    const started = performance.now();
    peer.send({ type: "input", frames: [{ seq: 10_000, tick: full.serverTick + 2, viewTick: full.serverTick, input: encodeInput({ Right: true }) }] });
    const rebased = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.lastConsumedInputSeq === 10_000, peer.messages.length);
    assert.ok(rebased.serverTick - full.serverTick <= Math.ceil((performance.now() - started) * 0.06) + 5);
    peer.send({ type: "input", frames: [{ seq: 20_000, tick: rebased.serverTick + 3, viewTick: rebased.serverTick, input: encodeInput({ Right: true }) }] });
    const rejectedAgain = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.serverTick >= rebased.serverTick + 6, peer.messages.length);
    assert.equal(rejectedAgain.lastConsumedInputSeq, 10_000);
    rig.evidence.record({ type: "security", case: "explicit-resync-sequence", before: rejected.lastConsumedInputSeq, after: rebased.lastConsumedInputSeq, rejectedSecondJump: rejectedAgain.lastConsumedInputSeq, elapsedMs: performance.now() - started });
  } finally { await peer.close(); }
});

test("unacknowledged bootstrap has one fullstate in flight and ACK resumes current server-time deltas", async () => {
  const peer = new RawPeer(rig.url, false);
  try {
    await peer.connect(rig.manifest.sha256);
    const full = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot");
    assert.equal(full.baselineId, 0);
    const started = performance.now();
    for (let i = 0; i < 4; i++) peer.send({ type: "resync", baselineId: 0 });
    await delay(1250);
    assert.equal(peer.messages.filter(message => message.type === "snapshot").length, 1);
    assert.equal(peer.messages.filter(message => message.type === "ping").length, 0);
    assert.equal(peer.closed, undefined);
    const index = peer.messages.length;
    peer.send({ type: "snapshotAck", snapshotId: full.snapshotId });
    const next = await peer.waitFor((m): m is Extract<Message, { type: "snapshot" }> => m.type === "snapshot" && m.snapshotId > full.snapshotId, index);
    assert.equal(next.baselineId, full.snapshotId);
    assert.ok(next.serverTick > full.serverTick);
    assert.ok(next.serverTick - full.serverTick <= Math.ceil((performance.now() - started) * 0.06) + 5);
    await peer.waitFor((m): m is Extract<Message, { type: "ping" }> => m.type === "ping", index);
    rig.evidence.record({ type: "security", case: "bootstrap-one-outstanding-fullstate", outstandingBeforeAck: 1, firstTick: full.serverTick, resumedTick: next.serverTick, resumedBaselineId: next.baselineId });
  } finally { await peer.close(); }
});

test("malformed peers leave only expected protocol diagnostics and worker stays healthy", async () => {
  await delay(50);
  assert.ok(rig.errors.every(error => error.startsWith("ProtocolError:")), rig.errors.join("\n"));
  const { peer } = await activePeer();
  try { assert.equal(peer.closed, undefined); }
  finally { await peer.close(); }
});
