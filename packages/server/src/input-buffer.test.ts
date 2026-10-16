import assert from "node:assert/strict";
import test from "node:test";
import { encodeInput } from "@soldat-web/sim-host";
import type { InputFrame } from "@soldat-web/protocol";
import { INPUT_PACKET_BURST, PlayerInputBuffer } from "./input-buffer.ts";

function frame(seq: number, tick: number, input = encodeInput({ Right: true })): InputFrame {
  return { seq, tick, viewTick: Math.max(0, tick - 3), input };
}

test("input lead is bounded to eight queued future ticks without granting time", () => {
  const buffer = new PlayerInputBuffer(0n);
  assert.deepEqual(buffer.offer([frame(3, 12), frame(2, 11), frame(1, 10)], 10, 0n), []);
  assert.equal(buffer.size, 3);
  for (let tick = 13; tick <= 18; tick++) assert.deepEqual(buffer.offer([{ ...frame(tick - 9, tick), viewTick: 10 }], 10, 0n), []);
  assert.equal(buffer.size, 9);
  assert.equal(buffer.leadTicks(10), 8);
  assert.equal(buffer.lastConsumedSequence, 0);
  assert.deepEqual(buffer.offer([{ ...frame(10, 19), viewTick: 10 }], 10, 0n), ["lead"]);
  assert.equal(buffer.size, 9);
  for (let tick = 10; tick <= 18; tick++) assert.equal(buffer.consume(tick).seq, tick - 9);
  assert.equal(buffer.size, 0);
});

test("gaps hold movement, aim, Fire and Jetpack, without repeating one-shot actions", () => {
  const buffer = new PlayerInputBuffer(0n);
  const control = encodeInput({ Right: true, Fire: true, Jetpack: true, ThrowNade: true, ChangeWeapon: true, ThrowWeapon: true, Reload: true, Prone: true, FlagThrow: true, MouseAimX: 123, MouseAimY: -456, MouseDist: 77, pressOrder: 2 });
  buffer.offer([frame(1, 0, control)], 0, 0n);
  const actual = buffer.consume(0);
  assert.equal(actual.repeated, false);
  assert.deepEqual(actual.input, control);
  const repeat = buffer.consume(1);
  const view = new DataView(repeat.input.buffer, repeat.input.byteOffset, repeat.input.byteLength);
  assert.equal(repeat.repeated, true);
  assert.equal(repeat.seq, 1);
  assert.equal(view.getUint16(0, true), (1 << 1) | (1 << 4) | (1 << 5));
  assert.equal(view.getInt16(2, true), 123);
  assert.equal(view.getInt16(4, true), -456);
  assert.equal(view.getInt16(6, true), 77);
  assert.equal(view.getUint16(8, true), 2);
  assert.equal(buffer.consume(2).seq, 1);
});

test("duplicates, replay, sequence jumps and consumed-tick action timestamps are rejected", () => {
  const buffer = new PlayerInputBuffer(0n);
  const shot = frame(1, 0, encodeInput({ ThrowNade: true }));
  assert.deepEqual(buffer.offer([shot], 0, 0n), []);
  buffer.consume(0);
  assert.deepEqual(buffer.offer([shot], 1, 0n), ["sequence"]);
  assert.deepEqual(buffer.offer([frame(2, 0, shot.input)], 1, 0n), ["stale"]);
  assert.deepEqual(buffer.offer([frame(130, 1)], 1, 0n), ["jump"]);
  assert.deepEqual(buffer.offer([frame(2, 1)], 1, 0n), []);
  assert.equal(buffer.consume(1).seq, 2);
});

test("sequence acknowledgements cannot regress through tick reordering", () => {
  const buffer = new PlayerInputBuffer(0n);
  buffer.offer([frame(1, 2)], 0, 0n);
  assert.deepEqual(buffer.offer([frame(2, 1)], 0, 0n), ["sequence"]);
  assert.deepEqual(buffer.offer([frame(2, 2)], 0, 0n), ["occupied"]);
  assert.equal(buffer.consume(2).seq, 1);
});

test("newest-first redundancy admits new frames without replaying consumed actions", () => {
  const buffer = new PlayerInputBuffer(0n);
  buffer.offer([frame(1, 0)], 0, 0n);
  buffer.consume(0);
  assert.deepEqual(buffer.offer([frame(3, 2), frame(2, 1), frame(1, 0)], 1, 0n), ["sequence"]);
  assert.equal(buffer.consume(1).seq, 2);
  assert.equal(buffer.consume(2).seq, 3);
});

test("duplicate floods consume the bounded packet burst and recover with monotonic time", () => {
  const buffer = new PlayerInputBuffer(0n);
  for (let i = 0; i < INPUT_PACKET_BURST; i++) assert.ok(!buffer.offer([frame(1, 0)], 0, 0n).includes("rate"));
  assert.deepEqual(buffer.offer([frame(2, 1)], 0, 0n), ["rate"]);
  assert.deepEqual(buffer.offer([frame(2, 1)], 1, 1_000_000_000n), []);
  assert.equal(buffer.size, 1);
  assert.throws(() => buffer.offer([frame(3, 2)], 1, 0n), /backwards/);
});

test("buffer owns admitted bytes and rejects zero/wrapped IDs and malformed batches", () => {
  const buffer = new PlayerInputBuffer(0n);
  const input = encodeInput({ Fire: true });
  buffer.offer([frame(1, 0, input)], 0, 0n);
  input.fill(0);
  assert.equal(buffer.consume(0).input[0], 16);
  assert.deepEqual(buffer.offer([frame(0, 1)], 1, 0n), ["invalid"]);
  assert.deepEqual(buffer.offer([frame(0x1_0000_0000, 1)], 1, 0n), ["invalid"]);
  assert.deepEqual(buffer.offer([frame(2, 1, new Uint8Array(11))], 1, 0n), ["invalid"]);
  assert.deepEqual(buffer.offer([frame(2, 1), frame(3, 2)], 1, 0n), ["invalid"]);
});

test("present movement and jets keep genuine old view time without buying tick lead", () => {
  const buffer = new PlayerInputBuffer(0n);
  const movement = { seq: 1, tick: 100, viewTick: 0, input: encodeInput({ Right: true, Jetpack: true }) };
  assert.deepEqual(buffer.offer([movement], 100, 0n), []);
  assert.equal(buffer.consume(100).input[0], 2 | 32);
  assert.deepEqual(buffer.offer([{ ...movement, seq: 2, tick: 109 }], 100, 0n), ["lead"]);
  assert.deepEqual(buffer.offer([{ ...movement, seq: 2, tick: 101, viewTick: 103 }], 100, 0n), ["invalid"]);
});

test("expired fire applies only present action/aim while preserving held movement", () => {
  const buffer = new PlayerInputBuffer(0n);
  buffer.offer([frame(1, 100, encodeInput({ Right: true }))], 100, 0n);
  buffer.consume(100);
  const old = { seq: 2, tick: 101, viewTick: 0, input: encodeInput({ Left: true, Fire: true, ThrowNade: true, Reload: true, MouseAimX: 321 }) };
  assert.deepEqual(buffer.offer([old], 110, 1_000_000n, () => "present"), []);
  assert.equal(buffer.lastConsumedSequence, 1);
  const present = buffer.consume(110);
  assert.equal(present.seq, 2);
  assert.equal(new DataView(present.input.buffer, present.input.byteOffset, 12).getUint16(0, true), 2 | 16 | 64);
  assert.equal(new DataView(present.input.buffer, present.input.byteOffset, 12).getInt16(2, true), 321);
  assert.deepEqual(buffer.offer([old], 111, 2_000_000n, () => "present"), ["sequence"]);
});
