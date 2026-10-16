import { describe, expect, test } from "bun:test";
import { decodeMessage, encodeMessage, encodeTickRecords, encodeTicksMessage, readChannel, validateInput, ProtocolError, PROTOCOL_VERSION, LIMITS, MAX_CLIENT_PACKET_BYTES, MAX_STATE_BYTES, type Message, type ReliableEvent, type TickRecord } from "../src/index.ts";

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
  { type: "ticks", lastConsumedInputSeq: 0, records: [{ type: "step", tick: 0, commands: [], inputs: [] }] },
  { type: "state", tick: 0, hash: 0n, lastConsumedInputSeq: 0, bytes: new Uint8Array() },
  { type: "events", events: [event(1, 0)] }, { type: "eventAck", eventId: 1 },
  { type: "chat", text: "a" }, { type: "ping", timestamp: 0n }, { type: "pong", timestamp: 0n },
  { type: "resync" }, { type: "disconnect", code: 0, reason: "" },
  { type: "weapon-choice", primary: 1, secondary: 0, selection: "primary" },
];
const maximum: Message[] = [
  { type: "hello", protocolVersion: 65535, contentSetHash: new Uint8Array(32).fill(255), simAbiVersion: 0xffffffff, nickname: "é".repeat(24), weapon: 255, secondaryWeapon: 255 },
  { type: "welcome", slot: 32, serverTick: 0xffffffff, tickRate: 60, matchSeed: 0xffffffffffffffffn, map: "m".repeat(LIMITS.map), rules: new Uint8Array(LIMITS.rules).fill(255) },
  { type: "input", frames: Array.from({ length: 3 }, (_, i) => ({ seq: 0xffffffff - i, tick: 0xffffffff - i, viewTick: 0xffffffff - i, input: input(true) })) },
  { type: "ticks", lastConsumedInputSeq: 0xffffffff, records: [
    { type: "step", tick: 0xffffffff, commands: [new TextEncoder().encode(`"${"x".repeat(LIMITS.commandBytes - 2)}"`)], inputs: Array.from({ length: 32 }, (_, i) => ({ slot: i + 1, input: input(true) })) },
    { type: "correct", tick: 0xffffffff, slot: 32, input: input(true) },
    { type: "hash", tick: 0xffffffff, hash: 0xffffffffffffffffn },
  ] },
  { type: "state", tick: 0xffffffff, hash: 0xffffffffffffffffn, lastConsumedInputSeq: 0xffffffff, bytes: new Uint8Array(MAX_STATE_BYTES).fill(255) },
  { type: "events", events: Array.from({ length: LIMITS.events }, (_, i) => event(i + 1, 0)) },
  { type: "events", events: [event(0xffffffff, LIMITS.eventPayload)] },
  { type: "eventAck", eventId: 0xffffffff }, { type: "chat", text: "🙂".repeat(LIMITS.chat / 4) },
  { type: "ping", timestamp: 0xffffffffffffffffn }, { type: "pong", timestamp: 0xffffffffffffffffn },
  { type: "resync" }, { type: "disconnect", code: 65535, reason: "r".repeat(LIMITS.reason) },
  { type: "weapon-choice", primary: 10, secondary: 13, selection: "secondary" },
];
function mustDecodeOrTyped(bytes: Uint8Array): void {
  try { const decoded = decodeMessage(bytes); expect(decodeMessage(encodeMessage(decoded))).toEqual(decoded); }
  catch (error) { expect(error).toBeInstanceOf(ProtocolError); }
}

test("every maximum legal client message fits the direction-specific limit of at most 4 KiB", () => {
  const clientTypes: Partial<Record<Message["type"], true>> = { hello: true, input: true, eventAck: true, chat: true, ping: true, pong: true, resync: true, disconnect: true, "weapon-choice": true };
  const messages: Message[] = [
    ...maximum.filter(message => clientTypes[message.type]),
    { type: "lobby-join", nickname: "n".repeat(LIMITS.nickname), hostToken: "h".repeat(LIMITS.hostToken) },
    { type: "lobby-update", mode: "ctf", map: "m".repeat(LIMITS.map), targetPlayers: 32 },
    { type: "lobby-ready", ready: true }, { type: "lobby-start" }, { type: "lobby-leave" },
    { type: "lobby-kick", id: "i".repeat(LIMITS.lobbyId) },
  ];
  const packets = messages.map(message => encodeMessage(message));
  const largest = Math.max(...packets.map(packet => packet.byteLength));
  expect(largest).toBe(8 + 2 + LIMITS.chat);
  expect(MAX_CLIENT_PACKET_BYTES).toBe(Math.ceil(largest / 1024) * 1024);
  expect(MAX_CLIENT_PACKET_BYTES).toBeLessThanOrEqual(4096);
  for (let i = 0; i < packets.length; i++) {
    expect(packets[i]!.byteLength).toBeLessThanOrEqual(MAX_CLIENT_PACKET_BYTES);
    expect(decodeMessage(packets[i]!)).toEqual(messages[i]!);
  }
  const state = maximum.find(message => message.type === "state")!;
  expect(encodeMessage(state).byteLength).toBeGreaterThan(MAX_CLIENT_PACKET_BYTES);
});

describe("versioned little-endian codec", () => {
  for (const [label, messages] of [["minimum", minimum], ["maximum", maximum]] as const) {
    for (const [i, message] of messages.entries()) test(`${message.type} ${label} ${i}`, () => {
      const encoded = encodeMessage(message);
      expect(decodeMessage(encoded)).toEqual(message);
      expect(readChannel(encoded)).toBe(message.type === "ticks" || message.type === "state" ? "latestState" : "reliableControl");
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
  test("weapon choices validate both encoding and untrusted bytes", () => {
    for (let primary = 1; primary <= 10; primary++) for (const secondary of [0, 11, 12, 13]) for (const selection of ["primary", "secondary"] as const) {
      const message: Message = { type: "weapon-choice", primary, secondary, selection };
      const packet = encodeMessage(message);
      expect(packet[2]).toBe(13);
      expect([...packet.subarray(8)]).toEqual([primary, secondary, selection === "primary" ? 0 : 1]);
      expect(decodeMessage(packet)).toEqual(message);
    }
    for (const primary of [0, 11, 255, -1, NaN, Infinity, 1.5]) {
      expect(() => encodeMessage({ type: "weapon-choice", primary, secondary: 0, selection: "primary" })).toThrow(ProtocolError);
    }
    for (const secondary of [1, 10, 14, 255, -1, NaN, Infinity, 0.5]) {
      expect(() => encodeMessage({ type: "weapon-choice", primary: 4, secondary, selection: "secondary" })).toThrow(ProtocolError);
    }
    for (const [offset, value] of [[8, 0], [8, 11], [9, 1], [9, 255], [10, 2], [10, 255]] as const) {
      const packet = encodeMessage({ type: "weapon-choice", primary: 4, secondary: 0, selection: "primary" });
      packet[offset] = value;
      expect(() => decodeMessage(packet)).toThrow(ProtocolError);
    }
    for (const selection of [undefined, null, 0, "other"]) {
      expect(() => encodeMessage({ type: "weapon-choice", primary: 4, secondary: 0, selection } as Message)).toThrow(ProtocolError);
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
      { type: "state", tick: 0, hash: 0n, lastConsumedInputSeq: 0, bytes: new Uint8Array(MAX_STATE_BYTES + 1) },
      { type: "events", events: [] }, { type: "events", events: [event(1, LIMITS.eventPayload + 1)] },
      { type: "events", events: Array.from({ length: LIMITS.events + 1 }, (_, i) => event(i + 1, 0)) },
      { type: "chat", text: "x".repeat(LIMITS.chat + 1) }, { type: "chat", text: "" },
      { type: "disconnect", code: 1, reason: "x".repeat(LIMITS.reason + 1) },
      { type: "ping", timestamp: -1n }, { type: "eventAck", eventId: 0 },
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

describe("v4 input relay records", () => {
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const step = (tick: number, inputs = [{ slot: 1, input: input() }]): TickRecord => ({ type: "step", tick, commands: [], inputs });
  function rawTicks(records: number[]): Uint8Array {
    const bytes = new Uint8Array(12 + records.length), view = new DataView(bytes.buffer);
    view.setUint16(0, PROTOCOL_VERSION, true); bytes[2] = 4; bytes[3] = 1;
    view.setUint32(4, bytes.length - 8, true); bytes.set(records, 12); return bytes;
  }
  test("shared encoding frames recipient sequences without mutating record bytes", () => {
    const records: TickRecord[] = [
      { type: "step", tick: 100, commands: [json({ kind: "join", slot: 1, name: "é" })], inputs: [{ slot: 1, input: input() }, { slot: 32, input: input(true) }] },
      { type: "correct", tick: 99, slot: 32, input: input() },
      { type: "hash", tick: 101, hash: 0x0102030405060708n },
      step(101, [{ slot: 1, input: input() }, { slot: 32, input: input(true) }]),
      step(102, [{ slot: 2, input: input() }, { slot: 32, input: input() }]),
      step(103, []), step(104, [{ slot: 32, input: input() }]),
    ];
    const recordBytes = encodeTickRecords(records), saved = recordBytes.slice();
    for (const seq of [0, 1, 0xffffffff]) {
      const packet = encodeTicksMessage(seq, recordBytes);
      expect(packet).toEqual(encodeMessage({ type: "ticks", lastConsumedInputSeq: seq, records }));
      expect(decodeMessage(packet)).toEqual({ type: "ticks", lastConsumedInputSeq: seq, records });
      expect([...packet.subarray(8, 12)]).toEqual(seq === 0xffffffff ? [255, 255, 255, 255] : [seq, 0, 0, 0]);
      const backing = new Uint8Array(packet.length + 7); backing.set(packet, 3);
      expect(decodeMessage(backing.subarray(3, 3 + packet.length))).toEqual(decodeMessage(packet));
    }
    expect(recordBytes).toEqual(saved);
  });
  test("only changed inputs follow the first complete human roster", () => {
    const records = [step(1), step(2), step(3, [{ slot: 1, input: input(true) }])];
    const packet = encodeTicksMessage(0, encodeTickRecords(records));
    // Header + recipient sequence + record count + three step envelopes + two inputs.
    expect(packet.length).toBe(8 + 4 + 2 + 3 * 11 + 2 * 13);
    expect(packet[24]).toBe(1); expect(packet[48]).toBe(0); expect(packet[59]).toBe(1);
    expect(decodeMessage(packet)).toEqual({ type: "ticks", lastConsumedInputSeq: 0, records });
    const separate = encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records: [records[1]!] });
    expect(separate[24]).toBe(1);
  });
  test("all v4 record truncations and exact state framing are rejected", () => {
    const messages: Message[] = [
      { type: "ticks", lastConsumedInputSeq: 42, records: [
        { type: "step", tick: 8, commands: [json({ kind: "leave", slot: 2 })], inputs: [{ slot: 32, input: input(true) }] },
        { type: "correct", tick: 7, slot: 32, input: input() }, { type: "hash", tick: 9, hash: 3n },
      ] },
      { type: "state", tick: 8, hash: 0x0102030405060708n, lastConsumedInputSeq: 42, bytes: new Uint8Array([1, 2, 3]) },
    ];
    for (const message of messages) {
      const packet = encodeMessage(message);
      for (let n = 0; n < packet.length; n++) {
        const short = packet.slice(0, n);
        if (short.length >= 8) new DataView(short.buffer).setUint32(4, short.length - 8, true);
        expect(() => decodeMessage(short)).toThrow(ProtocolError);
      }
      const trailing = new Uint8Array(packet.length + 1); trailing.set(packet);
      new DataView(trailing.buffer).setUint32(4, trailing.length - 8, true);
      expect(() => decodeMessage(trailing)).toThrow(ProtocolError);
      const wrongChannel = packet.slice(); wrongChannel[3] = 0;
      expect(() => decodeMessage(wrongChannel)).toThrow(ProtocolError);
    }
    const state = encodeMessage(messages[1]!);
    expect([...state.subarray(12, 20)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    for (const size of [2, 4, MAX_STATE_BYTES + 1]) {
      const bad = state.slice(); new DataView(bad.buffer).setUint32(24, size, true);
      expect(() => decodeMessage(bad)).toThrow(ProtocolError);
    }
    expect(encodeMessage({ type: "resync" }).length).toBe(8);
    const oldResync = new Uint8Array(12); oldResync.set(encodeMessage({ type: "resync" }));
    new DataView(oldResync.buffer).setUint32(4, 4, true);
    expect(() => decodeMessage(oldResync)).toThrow(ProtocolError);
  });
  test("reject malformed counts, record tags, sorted slots, roster changes and reserved inputs", () => {
    for (const records of [
      [0, 0], [129, 0], [1, 0, 0, 0, 0, 0, 0],
      // Step with a newly introduced human but no input.
      [1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
      // More commands or changed inputs than allowed.
      [1, 0, 1, 0, 0, 0, 0, 65],
      [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33],
    ]) expect(() => decodeMessage(rawTicks(records))).toThrow(ProtocolError);
    const records = [step(1, [{ slot: 1, input: input() }, { slot: 32, input: input() }])];
    for (const [offset, value] of [[14, 4], [25, 0], [25, 33], [38, 1], [24, 33], [27, 0x10]] as const) {
      const packet = encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records }); packet[offset] = value;
      expect(() => decodeMessage(packet)).toThrow(ProtocolError);
    }
    const absent = encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records });
    new DataView(absent.buffer).setUint32(20, 1, true);
    expect(() => decodeMessage(absent)).toThrow(ProtocolError);
    const newSlot = encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records: [step(1), step(2)] });
    new DataView(newSlot.buffer).setUint32(44, 3, true);
    expect(() => decodeMessage(newSlot)).toThrow(ProtocolError);
    for (const slot of [0, 33]) {
      const correct = encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records: [{ type: "correct", tick: 0, slot: 1, input: input() }] });
      correct[19] = slot; expect(() => decodeMessage(correct)).toThrow(ProtocolError);
    }
  });
  test("reject invalid JSON, UTF8, command bounds and invalid encoder values", () => {
    const valid = { type: "step", tick: 0, commands: [json({})], inputs: [] } satisfies TickRecord;
    const invalidRecords: TickRecord[][] = [
      [], Array.from({ length: LIMITS.tickRecords + 1 }, () => step(0)),
      [{ ...valid, commands: Array.from({ length: LIMITS.commands + 1 }, () => json({})) }],
      ...[new Uint8Array(), new Uint8Array(LIMITS.commandBytes + 1), new Uint8Array([0xff]), new TextEncoder().encode("{"), new TextEncoder().encode("{}{}")].map(command => [{ ...valid, commands: [command] }]),
      [step(-1)], [step(0, [{ slot: 0, input: input() }])], [step(0, [{ slot: 33, input: input() }])],
      [step(0, [{ slot: 1, input: input() }, { slot: 1, input: input() }])],
      [step(0, [{ slot: 32, input: input() }, { slot: 1, input: input() }])],
      [step(0, [{ slot: 1, input: new Uint8Array(11) }])],
      [{ type: "correct", tick: 0, slot: 0, input: input() }],
      [{ type: "hash", tick: 0, hash: -1n }],
      [{ ...valid, type: "unknown" } as unknown as TickRecord],
    ];
    for (const records of invalidRecords) expect(() => encodeTickRecords(records)).toThrow(ProtocolError);
    for (const seq of [-1, NaN, 0x100000000]) expect(() => encodeTicksMessage(seq, encodeTickRecords([valid]))).toThrow(ProtocolError);
    for (const bytes of [new Uint8Array(), new Uint8Array([0, 0]), new Uint8Array([129, 0]), new Uint8Array(LIMITS.tickBatch - 3)]) {
      expect(() => encodeTicksMessage(0, bytes)).toThrow(ProtocolError);
    }
    for (const [offset, value] of [[20, 0], [20, 1], [20, 0xff], [21, 0x10], [22, 0xff], [23, 0x7b]] as const) {
      const packet = encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records: [valid] });
      packet[offset] = value; expect(() => decodeMessage(packet)).toThrow(ProtocolError);
    }
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    expect(() => encodeTickRecords([{ ...valid, commands: [bom] }])).toThrow(ProtocolError);
  });
  test("record and aggregate byte limits include all framing overhead", () => {
    const hashes: TickRecord[] = Array.from({ length: LIMITS.tickRecords }, (_, tick) => ({ type: "hash", tick, hash: 0n }));
    expect(decodeMessage(encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records: hashes }))).toEqual({ type: "ticks", lastConsumedInputSeq: 0, records: hashes });
    const records: TickRecord[] = Array.from({ length: 4 }, (_, tick) => ({
      type: "step", tick, inputs: [],
      commands: Array.from({ length: 64 }, (_, c) => json("x".repeat((tick === 3 && c === 63 ? 3534 : 4096) - 2))),
    }));
    expect(encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records }).length).toBe(LIMITS.tickBatch + 8);
    const last = records[3] as Extract<TickRecord, { type: "step" }>;
    last.commands[63] = json("x".repeat(3533));
    expect(() => encodeTickRecords(records)).toThrow(ProtocolError);
  });
  test("structured v4 fuzz only decodes bounded complete records or throws ProtocolError", () => {
    const records: TickRecord[] = [
      { type: "step", tick: 1, commands: [json({ kind: "join", slot: 1 })], inputs: [{ slot: 1, input: input() }, { slot: 32, input: input(true) }] },
      step(2, [{ slot: 1, input: input() }, { slot: 32, input: input(true) }]),
      { type: "correct", tick: 1, slot: 1, input: input(true) }, { type: "hash", tick: 3, hash: 123n },
    ];
    for (let i = 0; i < 3000; i++) {
      const packet = encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records });
      for (let j = 0; j <= i % 4; j++) packet[12 + random() % (packet.length - 12)] = random() & 255;
      mustDecodeOrTyped(packet);
    }
  });
});
