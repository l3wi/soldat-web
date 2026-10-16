import assert from "node:assert/strict";
import { test } from "node:test";
import { SIM_PRESENTATION_EVENTS } from "@soldat-web/sim-host";
import { calculateBink, CursorBink, roundEven } from "./bink";

function events(...records: { amount: number; slot?: number; kind?: number }[]): Uint8Array {
  const bytes = new Uint8Array(records.length * 24), data = new DataView(bytes.buffer);
  records.forEach((record, index) => {
    const offset = index * 24;
    data.setUint32(offset, record.kind ?? SIM_PRESENTATION_EVENTS.BINK, true);
    data.setUint32(offset + 8, record.slot ?? 1, true);
    data.setUint32(offset + 16, 4, true);
    data.setInt32(offset + 20, record.amount, true);
  });
  return bytes;
}

test("native FPC rounding and CalculateBink diminishing returns", () => {
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, -0.5, -1.5].map(roundEven), [0, 2, 2, 4, 0, -2]);
  assert.equal(calculateBink(0, 50), 50);
  assert.equal(calculateBink(50, 50), 95);
  assert.equal(calculateBink(100, 50), 133);
  assert.equal(calculateBink(95, 0), 95);
});

test("live bink applies each eligible increment then native once-per-tick decay", () => {
  const bink = new CursorBink();
  bink.liveStep(1, events({ amount: 50 }, { amount: 50 }), 1);
  assert.equal(bink.counter, 94);
  bink.liveStep(2, new Uint8Array(), 1);
  assert.equal(bink.counter, 93);
  bink.liveStep(5, new Uint8Array(), 1);
  assert.equal(bink.counter, 90);
});

test("remote/semantic records do not bink; duplicate and rollback ticks never double-count", () => {
  const bink = new CursorBink(), batch = events({ amount: 50 }, { amount: 100, slot: 2 }, { amount: 100, kind: 0x1001 });
  bink.liveStep(10, batch, 1);
  assert.equal(bink.counter, 49);
  bink.liveStep(10, batch, 1);
  bink.liveStep(9, batch, 1);
  assert.equal(bink.counter, 49);
  bink.liveStep(11, events({ amount: 0 }), 1);
  assert.equal(bink.counter, 0);
  bink.liveStep(12, new Uint8Array(), 1);
  assert.equal(bink.counter, 0);
  bink.clear();
  bink.liveStep(1, events({ amount: 50 }), 1);
  assert.equal(bink.counter, 49);
});

test("malformed bink batches fail rather than silently suppressing feedback", () => {
  assert.throws(() => new CursorBink().liveStep(1, new Uint8Array(19), 1), /Truncated/);
  assert.throws(() => new CursorBink().liveStep(1, events({ amount: -1 }), 1), /Invalid/);
});
