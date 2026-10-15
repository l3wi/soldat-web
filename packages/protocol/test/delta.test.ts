import { expect, test } from "bun:test";
import { encodeDelta, decodeDelta, MAX_STATE_BYTES, ProtocolError } from "../src/index.ts";

let seed = 0xbea45712;
function random(): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
function bytes(length: number): Uint8Array {
  const result = new Uint8Array(length);
  for (let i = 0; i < length; i++) result[i] = random() & 255;
  return result;
}
test("exact roundtrip for equal, empty, random and different-length states", () => {
  const samples = [new Uint8Array(), new Uint8Array(1), bytes(1), bytes(7), bytes(8), bytes(9), bytes(65536)];
  for (const state of samples) for (const baseline of samples) {
    const encoded = encodeDelta(state, baseline);
    expect(decodeDelta(encoded, baseline)).toEqual(state);
    expect(encoded.length).toBeLessThanOrEqual(state.length + 5);
    expect(encodeDelta(state, baseline)).toEqual(encoded);
  }
  for (let i = 0; i < 200; i++) {
    const state = bytes(random() % 8192), baseline = bytes(random() % 8192);
    expect(decodeDelta(encodeDelta(state, baseline), baseline)).toEqual(state);
    expect(decodeDelta(encodeDelta(state, state), state)).toEqual(state);
    expect(decodeDelta(encodeDelta(state))).toEqual(state);
  }
});
test("zero-run compression, short runs and fallback never expand beyond raw XOR", () => {
  const baseline = bytes(65536), state = baseline.slice(); state[32768] = state[32768]! ^ 0xff;
  const delta = encodeDelta(state, baseline);
  expect(delta[0]).toBe(1); expect(delta.length / state.length).toBeLessThan(0.001);
  expect(decodeDelta(delta, baseline)).toEqual(state);
  const alternating = new Uint8Array(65536);
  for (let i = 0; i < alternating.length; i += 2) alternating[i] = 1;
  const raw = encodeDelta(alternating);
  expect(raw[0]).toBe(0); expect(raw.length).toBe(alternating.length + 5);
  expect(decodeDelta(raw)).toEqual(alternating);
});
test("maximum state and bounded output length", () => {
  const state = new Uint8Array(MAX_STATE_BYTES);
  expect(decodeDelta(encodeDelta(state))).toEqual(state);
  expect(() => encodeDelta(new Uint8Array(MAX_STATE_BYTES + 1))).toThrow(ProtocolError);
  const oversized = new Uint8Array(5); new DataView(oversized.buffer).setUint32(1, MAX_STATE_BYTES + 1, true);
  expect(() => decodeDelta(oversized)).toThrow(ProtocolError);
});
test("offset array views preserve exact bytes", () => {
  const state = bytes(128), baseline = bytes(128), delta = encodeDelta(state.subarray(3, 99), baseline.subarray(7, 70));
  const backing = new Uint8Array(delta.length + 11); backing.set(delta, 5);
  expect(decodeDelta(backing.subarray(5, 5 + delta.length), baseline.subarray(7, 70))).toEqual(state.subarray(3, 99));
});
test("malformed and random deltas always fail typed or decode exactly bounded output", () => {
  const malformed = [new Uint8Array(), new Uint8Array(4), new Uint8Array([2, 0, 0, 0, 0]), new Uint8Array([0, 1, 0, 0, 0]), new Uint8Array([1, 1, 0, 0, 0]), new Uint8Array([1, 1, 0, 0, 0, 0]), new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0]), new Uint8Array([1, 1, 0, 0, 0, 2, 0, 0, 0]), new Uint8Array([1, 1, 0, 0, 0, 1, 0, 0, 128])];
  for (const delta of malformed) expect(() => decodeDelta(delta)).toThrow(ProtocolError);
  for (let i = 0; i < 3000; i++) {
    const delta = bytes(random() % 128);
    if (i % 2 === 0 && delta.length >= 5) { delta[0] = i % 3; new DataView(delta.buffer).setUint32(1, random() % 256, true); }
    try { expect(decodeDelta(delta).length).toBeLessThanOrEqual(MAX_STATE_BYTES); }
    catch (error) { expect(error).toBeInstanceOf(ProtocolError); }
  }
});
