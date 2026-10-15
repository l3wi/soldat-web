import { describe, expect, test } from "bun:test";
import { decodeMessage, encodeMessage, readChannel, validateInput, ProtocolError, PROTOCOL_VERSION, LIMITS, MAX_STATE_BYTES, type Message, type ReliableEvent } from "../src/index.ts";

let seed = 0xa421f27;
function random(): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
function input(boundary = false): Uint8Array {
  const result = new Uint8Array(12), view = new DataView(result.buffer);
  if (boundary) { view.setUint16(0, 0x0fff, true); view.setInt16(2, -32768, true); view.setInt16(4, 32767, true); view.setInt16(6, -32768, true); view.setUint16(8, 10, true); }
  return result;
}
function event(id: number, bytes: number): ReliableEvent {
  const header = new Uint8Array(20), view = new DataView(header.buffer);
  view.setUint32(0, 0x80000003, true); view.setUint32(4, 0xffffffff, true); view.setUint32(8, 32, true); view.setUint32(12, 32, true); view.setUint32(16, bytes, true);
  return { id, tick: 0xffffffff, header, payload: new Uint8Array(bytes).fill(0xab) };
}
const minimum: Message[] = [
  { type: "hello", protocolVersion: PROTOCOL_VERSION, contentSetHash: new Uint8Array(32), simAbiVersion: 0x00010003, nickname: "a", weapon: 4, secondaryWeapon: 0 },
  { type: "welcome", slot: 1, serverTick: 0, tickRate: 60, matchSeed: 0n, map: "a", rules: new Uint8Array() },
  { type: "input", frames: [{ seq: 1, tick: 0, viewTick: 0, input: input() }] },
  { type: "snapshot", serverTick: 0, lastConsumedInputSeq: 0, snapshotId: 1, baselineId: 0, stateHash: 0n, inputs: [], state: new Uint8Array(5) },
  { type: "snapshotAck", snapshotId: 1 }, { type: "events", events: [event(1, 0)] }, { type: "eventAck", eventId: 1 },
  { type: "chat", text: "a" }, { type: "ping", timestamp: 0n }, { type: "pong", timestamp: 0n },
  { type: "resync", baselineId: 0 }, { type: "disconnect", code: 0, reason: "" },
];
const largestDelta = new Uint8Array(LIMITS.delta);
new DataView(largestDelta.buffer).setUint32(1, MAX_STATE_BYTES, true);
const maximum: Message[] = [
  { type: "hello", protocolVersion: 65535, contentSetHash: new Uint8Array(32).fill(255), simAbiVersion: 0xffffffff, nickname: "é".repeat(24), weapon: 255, secondaryWeapon: 255 },
  { type: "welcome", slot: 32, serverTick: 0xffffffff, tickRate: 60, matchSeed: 0xffffffffffffffffn, map: "m".repeat(LIMITS.map), rules: new Uint8Array(LIMITS.rules).fill(255) },
  { type: "input", frames: Array.from({ length: 3 }, (_, i) => ({ seq: 0xffffffff - i, tick: 0xffffffff - i, viewTick: 0xffffffff - i, input: input(true) })) },
  { type: "snapshot", serverTick: 0xffffffff, lastConsumedInputSeq: 0xffffffff, snapshotId: 0xffffffff, baselineId: 0xfffffffe, stateHash: 0xffffffffffffffffn, inputs: Array.from({ length: 32 }, (_, i) => ({ slot: i + 1, input: input(true) })), state: largestDelta },
  { type: "snapshotAck", snapshotId: 0xffffffff }, { type: "events", events: Array.from({ length: LIMITS.events }, (_, i) => event(i + 1, 0)) },
  { type: "events", events: [event(0xffffffff, LIMITS.eventPayload)] },
  { type: "eventAck", eventId: 0xffffffff }, { type: "chat", text: "🙂".repeat(LIMITS.chat / 4) },
  { type: "ping", timestamp: 0xffffffffffffffffn }, { type: "pong", timestamp: 0xffffffffffffffffn },
  { type: "resync", baselineId: 0xffffffff }, { type: "disconnect", code: 65535, reason: "r".repeat(LIMITS.reason) },
];
function mustDecodeOrTyped(bytes: Uint8Array): void {
  try { const decoded = decodeMessage(bytes); expect(decodeMessage(encodeMessage(decoded))).toEqual(decoded); }
  catch (error) { expect(error).toBeInstanceOf(ProtocolError); }
}

describe("versioned little-endian codec", () => {
  for (const [label, messages] of [["minimum", minimum], ["maximum", maximum]] as const) {
    for (const [i, message] of messages.entries()) test(`${message.type} ${label} ${i}`, () => {
      const encoded = encodeMessage(message);
      expect(decodeMessage(encoded)).toEqual(message);
      expect(readChannel(encoded)).toBe(message.type === "snapshot" ? "latestState" : "reliableControl");
      expect(encoded[0]).toBe(PROTOCOL_VERSION); expect(encoded[1]).toBe(0);
    });
  }
  test("offset views and exact endian timestamp bytes", () => {
    const packet = encodeMessage({ type: "ping", timestamp: 0x0102030405060708n });
    expect([...packet.subarray(8)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    const backing = new Uint8Array(packet.length + 5); backing.set(packet, 3);
    expect(decodeMessage(backing.subarray(3, 3 + packet.length))).toEqual({ type: "ping", timestamp: 0x0102030405060708n });
  });
  test("reject every truncation and trailing fields", () => {
    for (const message of minimum) {
      const bytes = encodeMessage(message);
      for (let n = 0; n < bytes.length; n++) expect(() => decodeMessage(bytes.subarray(0, n))).toThrow(ProtocolError);
      const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
      expect(() => decodeMessage(trailing)).toThrow(ProtocolError);
      new DataView(trailing.buffer).setUint32(4, trailing.length - 8, true);
      expect(() => decodeMessage(trailing)).toThrow(ProtocolError);
    }
  });
  test("reject channel/version/type, invalid UTF8, and reserved controls", () => {
    for (const [index, value] of [[0, 1], [2, 0], [3, 1]] as const) {
      const bytes = encodeMessage(minimum[0]!); bytes[index] = value;
      expect(() => decodeMessage(bytes)).toThrow(ProtocolError);
    }
    const bytes = encodeMessage({ type: "chat", text: "ab" }); bytes[10] = 0xc0; bytes[11] = 0xaf;
    expect(() => decodeMessage(bytes)).toThrow(ProtocolError);
    for (const [offset, value] of [[0, 0x1000], [8, 3], [8, 12], [8, 16], [10, 1]]) {
      const invalid = input(); new DataView(invalid.buffer).setUint16(offset!, value!, true);
      expect(() => validateInput(invalid)).toThrow(ProtocolError);
      const packet = encodeMessage(minimum[2]!); packet.set(invalid, 21);
      expect(() => decodeMessage(packet)).toThrow(ProtocolError);
    }
  });
  test("bound every variable payload and reject invalid values", () => {
    const invalid: Message[] = [
      { ...minimum[0] as Extract<Message, { type: "hello" }>, nickname: "x".repeat(LIMITS.nickname + 1) },
      { ...minimum[0] as Extract<Message, { type: "hello" }>, nickname: "\ud800" },
      { ...minimum[0] as Extract<Message, { type: "hello" }>, nickname: "\udc00" },
      { ...minimum[0] as Extract<Message, { type: "hello" }>, nickname: "\ud800x" },
      { type: "input", frames: [] }, { type: "input", frames: Array.from({ length: 4 }, () => ({ seq: 1, tick: 0, viewTick: 0, input: input() })) },
      { ...minimum[1] as Extract<Message, { type: "welcome" }>, rules: new Uint8Array(LIMITS.rules + 1) },
      { ...minimum[1] as Extract<Message, { type: "welcome" }>, map: "m".repeat(LIMITS.map + 1) },
      { ...minimum[1] as Extract<Message, { type: "welcome" }>, slot: 0 },
      { ...minimum[3] as Extract<Message, { type: "snapshot" }>, state: new Uint8Array(LIMITS.delta + 1) },
      { type: "events", events: [] }, { type: "events", events: [event(1, LIMITS.eventPayload + 1)] },
      { type: "events", events: Array.from({ length: LIMITS.events + 1 }, (_, i) => event(i + 1, 0)) },
      { type: "chat", text: "x".repeat(LIMITS.chat + 1) }, { type: "chat", text: "" },
      { type: "disconnect", code: 1, reason: "x".repeat(LIMITS.reason + 1) },
      { type: "ping", timestamp: -1n }, { type: "resync", baselineId: NaN }, { type: "eventAck", eventId: 0 },
    ];
    for (const value of invalid) expect(() => encodeMessage(value)).toThrow(ProtocolError);
    const oversized = encodeMessage(minimum[3]!); new DataView(oversized.buffer).setUint32(4, MAX_STATE_BYTES + 1000, true);
    expect(() => decodeMessage(oversized)).toThrow(ProtocolError);
  });
  test("bound aggregate event payload exactly", () => {
    const remaining = LIMITS.eventBatch - 2 - 28 * LIMITS.events;
    const events = Array.from({ length: LIMITS.events }, (_, i) => event(i + 1, Math.floor(remaining / LIMITS.events) + (i < remaining % LIMITS.events ? 1 : 0)));
    expect(encodeMessage({ type: "events", events }).length).toBe(LIMITS.eventBatch + 8);
    events[0] = event(1, events[0]!.payload.length + 1);
    expect(() => encodeMessage({ type: "events", events })).toThrow(ProtocolError);
  });
  test("random and structured byte fuzz never produces untyped errors", () => {
    for (let i = 0; i < 5000; i++) {
      const bytes = new Uint8Array(random() % 512);
      for (let j = 0; j < bytes.length; j++) bytes[j] = random() & 255;
      mustDecodeOrTyped(bytes);
    }
    for (let i = 0; i < 3000; i++) {
      const bytes = encodeMessage(minimum[random() % minimum.length]!);
      for (let j = 0; j <= i % 4; j++) bytes[random() % bytes.length] = random() & 255;
      mustDecodeOrTyped(bytes);
    }
  });
});
