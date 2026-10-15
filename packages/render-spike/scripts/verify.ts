import assert from "node:assert/strict";
import { logicalCamera, worldAt } from "../src/types";
import type { ImageAsset, Quad } from "../src/types";
import { packVertices, quadGeometry, quadVertices } from "../src/geometry";
import { QuadBatch } from "../src/quad-batch";
import { FrameStats } from "../src/frame-stats";
for (const [width, height, expected] of [
  [640, 480, 640],
  [1920, 1080, 853],
  [480, 960, 600],
  [3440, 1440, 854],
]) {
  const c = logicalCamera(width!, height!, 32, -18, Math.log(2));
  assert.equal(c.width, expected);
  assert.deepEqual(worldAt(c, width! / 2, height! / 2, width!, height!), {
    x: 32,
    y: -18,
  });
  assert.deepEqual(worldAt(c, width!, height!, width!, height!), {
    x: 32 + c.width,
    y: 462,
  });
}
const asset: ImageAsset = {
  width: 90,
  height: 4,
  scale: 4.5,
  frames: [{ object: "fixture", delayMs: 0, delayTicks: 0 }],
};
const region = { key: "fixture", u0: 0, v0: 0, u1: 1, v1: 1 },
  regions = new Map([["fixture", region]]);
const q: Quad = {
  asset,
  x: 10,
  y: 20,
  width: 90,
  height: 4,
  scaleX: 2,
  scaleY: 1,
  pivotX: 0,
  pivotY: 1,
  rotation: 0,
  color: [255, 0, 128, 64],
  mapPivot: true,
};
assert.deepEqual(quadVertices(q, region)[0], {
  x: 10,
  y: 20,
  u: 0,
  v: 0,
  color: q.color,
});
q.rotation = Math.PI / 2;
const rotated = quadVertices(q, region)[0]!;
assert.ok(Math.abs(rotated.x - 11) < 1e-12 && Math.abs(rotated.y - 21) < 1e-12);
const batch = new QuadBatch();
for (const mapPivot of [true, false])
  for (const scaleY of [-1, 1])
    for (const rotation of [0, 0.3, Math.PI]) {
      Object.assign(q, { mapPivot, scaleY, rotation });
      const expected = quadGeometry([q], regions),
        actual = batch.update([q], regions);
      assert.deepEqual(
        new Uint8Array(packVertices(actual.runs)),
        new Uint8Array(packVertices(expected.runs)),
      );
    }
const packed = new DataView(packVertices(quadGeometry([q], regions).runs));
assert.equal(packed.byteLength, 120);
assert.equal(packed.getUint8(16), 255);
assert.equal(packed.getUint8(17), 0);
assert.equal(packed.getUint8(18), 128);
assert.equal(packed.getUint8(19), 64);
const stats = new FrameStats();
for (let i = 0; i < 30000; i++)
  stats.record(i % 100 === 0 ? 2 : 1, 100 + i * 5);
const summary = stats.summary();
assert.equal(summary.frames, 30000);
assert.equal(summary.retainedSamples, 20000);
assert.equal(summary.cpuP50, 1);
assert.equal(summary.cpuP99, 2);
assert.equal(summary.averageFps, 200);
stats.reset();
assert.equal(stats.summary().frames, 0);
console.log(
  "Renderer invariants: camera aspect/zoom/world transform, native absolute map pivot, normalized gostek pivot, negative scale, byte layout, reusable quad batching, bounded frame statistics passed.",
);
