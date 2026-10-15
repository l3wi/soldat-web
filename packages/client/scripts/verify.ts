import assert from "node:assert/strict";
import { ClientClock, TICK_MS } from "../src/clock";
import { createCamera, worldAt, screenAt, setZoom, updateCamera } from "../src/camera";
import { attenuation, soundPosition, Audio } from "../src/audio";
import { DEFAULT_SETTINGS, loadSettings } from "../src/settings";
import { quadVertices } from "../src/render/geometry";
import { SOUND_SAMPLES } from "../src/sound-samples";
import { EffectsRenderer } from "../src/render/effects";

for (const hz of [60, 120, 144]) {
  const clock = new ClientClock(); let ticks = 0;
  const step = () => ticks++;
  for (let frame = 0; frame <= hz * 10; frame++) clock.advance(frame * 1000 / hz, step);
  assert.equal(ticks, 600, `${hz} Hz clock`);
  assert.equal(clock.droppedTicks, 0);
  clock.reset(); clock.advance(100000, step); assert.equal(ticks, 600);
  clock.advance(100000 + TICK_MS, step); assert.equal(ticks, 601);
}
const capped = new ClientClock(); let count = 0;
capped.advance(0, () => count++); capped.advance(1000, () => count++);
assert.equal(count, 4); assert.equal(capped.droppedTicks, 56);
for (const [w, h, logical] of [[640, 480, 640], [1280, 720, 853], [400, 1000, 600], [3440, 1440, 854]]) {
  const camera = createCamera(w!, h!, 34, -51, 0.6), point = { x: 0, y: 0 }, pixel = { x: 0, y: 0 };
  assert.equal(camera.width, logical);
  for (const [x, y] of [[0, 0], [w!, h!], [w! / 3, h! / 4]]) {
    worldAt(camera, x!, y!, w!, h!, point); screenAt(camera, point.x, point.y, w!, h!, pixel);
    assert.ok(Math.abs(pixel.x - x!) < 1e-10 && Math.abs(pixel.y - y!) < 1e-10);
  }
}
const camera = createCamera(640, 480); setZoom(camera, 1); updateCamera(camera, 0, 0, 0, 0);
assert.equal(camera.z, 0.25);
assert.equal(attenuation(0), 1); assert.equal(attenuation(375), 0.5); assert.equal(attenuation(750), 0); assert.equal(attenuation(800), 0);
const position = { x: 0, y: 0, z: 0 }; soundPosition(200, -100, position);
assert.deepEqual(position, { x: 0.1, y: -0.05, z: -0.5 });
const events = new Uint8Array(40), data = new DataView(events.buffer);
data.setUint32(0, 0x80000001, true); data.setUint32(4, 7, true);
data.setUint32(20, 1, true); data.setUint32(24, 8, true);
const audio = new Audio({} as never); audio.drain(events);
assert.equal(audio.unmappedPresentationEvents, 1); assert.equal(audio.gameplayEvents, 1); assert.equal(audio.lastTick, 8);
assert.throws(() => audio.drain(events, 39), /Truncated/);
const soundEvent = new Uint8Array(52), soundData = new DataView(soundEvent.buffer);
soundData.setUint32(0, 0x80000004, true); soundData.setUint32(16, 32, true);
soundData.setInt32(20, 2, true); soundData.setInt32(24, -1, true);
soundData.setFloat32(44, 1, true); soundData.setFloat32(48, 750, true);
audio.drain(soundEvent);
assert.equal(audio.soundEvents, 1); assert.equal(audio.playedSounds, 0, "No playback before gesture");
assert.equal(SOUND_SAMPLES.length, 164); assert.equal(SOUND_SAMPLES[4], ""); assert.equal(SOUND_SAMPLES[163], "sfx_wind.wav");
audio.destroy();
assert.equal(DEFAULT_SETTINGS.bindings.flagThrow, "Space");
assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
const asset = { width: 90, height: 4, scale: 4.5, frames: [{ object: "fixture", delayMs: 0, delayTicks: 0 }] };
const q = { asset, x: 10, y: 20, width: 90, height: 4, scaleX: 2, scaleY: 1, pivotX: 0, pivotY: 1, rotation: Math.PI / 2, color: [255, 0, 128, 64], mapPivot: true };
const v = quadVertices(q, { key: "fixture", u0: 0, v0: 0, u1: 1, v1: 1 })[0]!;
assert.ok(Math.abs(v.x - 11) < 1e-12 && Math.abs(v.y - 21) < 1e-12);
const effects = new EffectsRenderer([
  { index: 1, symbol: "GFX_SPARKS_RAIN", asset },
  ...Array.from({ length: 16 }, (_, index) => ({ index: 100 + index, symbol: `GFX_SPARKS_EXPLOSION_EXPLODE${index + 1}`, asset })),
]);
const spark = { style: 38, owner: 1, life: 40, lifePrev: 41, x: 10, y: 20, previousX: 0, previousY: 10, tint: 0xffffff };
const view = { count: 1, spark: () => spark };
let quads = effects.quads(.5, view);
assert.equal(quads.length, 1); assert.equal(quads[0]!.color[3], 105);
assert.equal(quads[0]!.x, 5); assert.equal(quads[0]!.y, 15);
spark.style = 12; quads = effects.quads(.5, view);
assert.equal(quads.length, 2, "Native explosion underlayer before main layer");
assert.deepEqual(quads[0]!.color, [173,173,173,100]);
assert.equal(quads[1]!.x, -14); assert.equal(quads[1]!.y, -23);
console.log("Client invariants pass: 60/120/144 Hz fixed steps, catch-up cap, pause/reset, camera round trips/zoom, native sound formula/event drain, bindings and absolute map pivots.");
