import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotBaselines } from "./baselines.ts";

test("byte budget withholds new ACK candidates without evicting eligible older states", () => {
  const store = new SnapshotBaselines(12, 128), state = new Uint8Array(4);
  assert.equal(store.retain(1, 0, state), true);
  assert.equal(store.retain(2, 0, state), true);
  assert.equal(store.retain(3, 0, state), true);
  assert.equal(store.retain(4, 0, state), false);
  assert.equal(store.bytes, 12); assert.equal(store.get(1), state); assert.equal(store.get(4), undefined);
  // Only the server's observed watermark, not receipt age, releases state 1.
  assert.equal(store.retain(5, 2, state), true);
  assert.equal(store.get(1), undefined); assert.equal(store.get(2), state); assert.equal(store.get(3), state);
  assert.equal(store.bytes, 12); assert.equal(store.size, 3);
});

test("candidate count is bounded independently of bytes", () => {
  const store = new SnapshotBaselines(1024, 2), state = new Uint8Array(1);
  assert.equal(store.retain(1, 0, state), true); assert.equal(store.retain(2, 1, state), true);
  assert.equal(store.retain(3, 1, state), false); assert.equal(store.get(1), state);
  assert.equal(store.retain(4, 2, state), true); assert.equal(store.get(1), undefined);
  assert.equal(store.size, 2);
});

test("initial fullstate bursts retain ACK candidates; unsolicited fullstate after nonzero baseline proves reset", () => {
  const store = new SnapshotBaselines(8, 128), state = new Uint8Array(4);
  assert.equal(store.retain(1, 0, state), true); assert.equal(store.retain(2, 0, state), true);
  assert.equal(store.get(1), state); assert.equal(store.get(2), state);
  assert.equal(store.retain(3, 1, state), false);
  assert.equal(store.retain(4, 0, state), true);
  assert.equal(store.size, 1); assert.equal(store.bytes, 4); assert.equal(store.get(4), state);
  assert.equal(store.get(1), undefined); assert.equal(store.get(2), undefined);
  assert.equal(store.retain(5, 0, state), true); assert.equal(store.get(4), state);
});
