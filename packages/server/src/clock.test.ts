import assert from "node:assert/strict";
import test from "node:test";
import { FixedStepAccumulator } from "./clock.ts";

test("one second is exactly 60 fixed steps despite fractional nanosecond tick duration", () => {
  const clock = new FixedStepAccumulator(0n);
  let steps = 0;
  for (let millisecond = 1; millisecond <= 1000; millisecond++) clock.advance(BigInt(millisecond) * 1_000_000n, () => { steps++; });
  assert.equal(steps, 60);
  assert.equal(clock.overloads, 0);
  assert.equal(clock.discardedSteps, 0n);
});

test("catch-up runs at most four steps and discards excess whole steps", () => {
  const clock = new FixedStepAccumulator(0n);
  let steps = 0;
  assert.equal(clock.advance(1_005_000_000n, () => { steps++; }), 4);
  assert.equal(steps, 4);
  assert.equal(clock.overloads, 1);
  assert.equal(clock.discardedSteps, 56n);
  // The fractional 5 ms remainder is retained, not discarded or simulated as variable dt.
  assert.ok(clock.delayMilliseconds(1_005_000_000n) > 11.66 && clock.delayMilliseconds(1_005_000_000n) < 11.67);
  assert.equal(clock.advance(1_016_666_667n, () => { steps++; }), 1);
  assert.equal(steps, 5);
  assert.equal(clock.discardedSteps, 56n);
});

test("accumulator uses monotonic time and handles empty/sub-tick wakes", () => {
  const clock = new FixedStepAccumulator(1_000n);
  let steps = 0;
  assert.equal(clock.advance(1_000n, () => { steps++; }), 0);
  assert.equal(clock.advance(16_667_666n, () => { steps++; }), 0);
  assert.equal(clock.advance(16_667_667n, () => { steps++; }), 1);
  assert.equal(steps, 1);
  assert.throws(() => clock.advance(1n, () => {}), /backwards/);
});

test("deadline scheduling subtracts simulation work without granting extra ticks", () => {
  const clock = new FixedStepAccumulator(0n);
  let steps = 0;
  clock.advance(16_666_667n, () => { steps++; });
  assert.ok(clock.delayMilliseconds(24_666_667n) > 8.66);
  assert.ok(clock.delayMilliseconds(24_666_667n) < 8.67);
  assert.equal(clock.delayMilliseconds(40_000_000n), 0);
  assert.equal(steps, 1);
  assert.equal(clock.advance(33_333_334n, () => { steps++; }), 1);
  assert.equal(steps, 2);
  assert.throws(() => clock.delayMilliseconds(1n), /backwards/);
});
