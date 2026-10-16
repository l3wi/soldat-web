import assert from "node:assert/strict";
import test from "node:test";
import { BucketTable, ConnectionAdmission, TokenBucket, hardeningLimits, sourceIp, HARDENING_DEFAULTS } from "./hardening.ts";

test("F-08 stale bucket eviction admits new IPs without resetting recent identities", () => {
  const buckets = new BucketTable(2, 1, 0.1);
  assert.equal(buckets.take("old", 0), true);
  assert.equal(buckets.take("recent", 1), true);
  assert.equal(buckets.take("new", 2), true);
  assert.equal(buckets.take("recent", 3), false);
  assert.equal(buckets.take("old", 4), true);
  const global = new TokenBucket(2, 2, 0);
  assert.equal(global.take(1, 0), true); assert.equal(global.take(1, 0), true);
  assert.equal(global.take(1, 0), false); assert.equal(global.take(1, 500), true);
});
test("F-03 pending and joined per-IP websocket limits recover exactly once on release", () => {
  const admission = new ConnectionAdmission(hardeningLimits({ maxWebSocketsPerIp: 2, maxPendingUpgrades: 2 }));
  const first = admission.acquire("a")!, second = admission.acquire("a")!;
  assert.equal(admission.acquire("b"), undefined);
  first.joined();
  const other = admission.acquire("b")!;
  assert.equal(admission.acquire("a"), undefined);
  second.release(); second.release();
  const replacement = admission.acquire("a")!; assert.ok(replacement);
  first.release(); other.release(); replacement.release();
  assert.ok(admission.acquire("a"));
});
test("IPv6 /64 and IPv4-mapped identities share quota keys", () => {
  assert.equal(sourceIp("2001:db8:abcd:12::1"), sourceIp("2001:0db8:abcd:0012:ffff::2"));
  assert.notEqual(sourceIp("2001:db8:abcd:12::1"), sourceIp("2001:db8:abcd:13::1"));
  assert.equal(sourceIp("::ffff:127.0.0.1"), sourceIp("127.0.0.1"));
  assert.equal(sourceIp("::ffff:7f00:1"), sourceIp("127.0.0.1"));
});
test("all public hardening defaults reject invalid config values", () => {
  for (const key of Object.keys(HARDENING_DEFAULTS)) for (const value of [0, -1, 0.5, Infinity, NaN, null, "2", 0x80000000]) {
    assert.throws(() => hardeningLimits({ [key]: value }), new RegExp(key));
  }
});

test("F-07 exhausted failure buckets gate attempts until refill without charging successful lookups", () => {
  const buckets = new BucketTable(2, 2, 1);
  assert.equal(buckets.available("source", 0), true);
  assert.equal(buckets.take("source", 0), true);
  assert.equal(buckets.available("source", 0), true);
  assert.equal(buckets.available("source", 0), true);
  assert.equal(buckets.take("source", 0), true);
  assert.equal(buckets.available("source", 999), false);
  assert.equal(buckets.available("source", 1000), true);
});
