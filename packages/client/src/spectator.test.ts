import assert from "node:assert/strict";
import test from "node:test";
import { SPRITE_FLAGS, type RenderView } from "@soldat-web/sim-host";
import { createCamera, updateSpectatorCamera } from "./camera";
import { SpectatorController, type SpectatorSprite } from "./spectator";

function roster() {
  return [
    { slot: 1, active: true, flags: SPRITE_FLAGS.active, team: 5, x: 0, y: 0 },
    { slot: 2, active: true, flags: SPRITE_FLAGS.active, team: 1, x: 20, y: 40 },
    { slot: 3, active: true, flags: SPRITE_FLAGS.active | SPRITE_FLAGS.dead, team: 1, x: 30, y: 60 },
    { slot: 4, active: true, flags: SPRITE_FLAGS.active, team: 2, x: 40, y: 80 },
    { slot: 5, active: false, flags: 0, team: 1, x: 50, y: 100 },
    { slot: 6, active: true, flags: SPRITE_FLAGS.active, team: 5, x: 60, y: 120 },
  ];
}

function observer(sprites: readonly SpectatorSprite[] = roster(), realistic = false) {
  const controller = new SpectatorController();
  controller.update(sprites, 1, realistic, 0);
  return controller;
}

test("spectators cycle every living team, skipping dead, empty and spectator slots with wrap", () => {
  const controller = observer();
  assert.equal(controller.free, true);
  assert.equal(controller.cycle(), 2);
  assert.equal(controller.cycle(), 4);
  assert.equal(controller.cycle(), 2);
  assert.equal(controller.cycle(true), 4);
  controller.freeCamera();
  assert.equal(controller.cycle(true), 4);
  controller.follow(2);
  assert.equal(controller.target?.slot, 2);
  controller.follow(0);
  assert.equal(controller.free, true);
  assert.throws(() => controller.follow(3), /living/);
  assert.throws(() => controller.follow(6), /living/);
  assert.throws(() => controller.follow(7), /range/);
  assert.throws(() => controller.follow(NaN), /range/);
});

test("dead team players only cycle teammates and cannot use spectator console commands", () => {
  const sprites = roster();
  sprites[0]!.team = 1;
  sprites[0]!.flags |= SPRITE_FLAGS.dead;
  const controller = observer(sprites);
  assert.equal(controller.observing, true);
  assert.equal(controller.cycle(), 2);
  assert.equal(controller.cycle(), 2);
  assert.equal(controller.cycle(true), 2);
  assert.throws(() => controller.follow(4), /not a spectator/);
  controller.freeCamera();
  assert.equal(controller.free, true);
  sprites[1]!.team = 2;
  controller.update(sprites, 1, false, 0);
  assert.equal(controller.cycle(), 0);
});

test("realistic dead teammates cannot freecam; true spectators still can", () => {
  const sprites = roster();
  sprites[0]!.team = 1;
  sprites[0]!.flags |= SPRITE_FLAGS.dead;
  const controller = observer(sprites, true);
  assert.equal(controller.free, false);
  assert.throws(() => controller.freeCamera(), /realistic/);
  assert.equal(controller.controls(false, false, true), true);
  assert.equal(controller.targetSlot, 2);
  sprites[1]!.flags |= SPRITE_FLAGS.dead;
  controller.update(sprites, 1, true, 0);
  assert.equal(controller.targetSlot, 0);
  assert.equal(controller.free, false);
  assert.equal(observer(roster(), true).free, true);
});

test("solo dead players follow other solo players but not team players", () => {
  const sprites = roster();
  sprites[0]!.team = sprites[1]!.team = 0;
  sprites[0]!.flags |= SPRITE_FLAGS.dead;
  const controller = observer(sprites);
  assert.equal(controller.cycle(), 2);
  assert.equal(controller.cycle(), 2);
});

test("death, disconnect and team changes invalidate followed targets", () => {
  const sprites = roster();
  const controller = observer(sprites);
  controller.follow(2);
  sprites[1]!.flags |= SPRITE_FLAGS.dead;
  controller.update(sprites, 1, false, 0);
  assert.equal(controller.targetSlot, 0);
  sprites[1]!.flags &= ~SPRITE_FLAGS.dead;
  controller.update(sprites, 1, false, 0);
  assert.equal(controller.targetSlot, 0, "respawn must not silently reacquire a dead target");
  controller.follow(2);
  sprites[1]!.active = false;
  controller.update(sprites, 1, false, 0);
  assert.equal(controller.targetSlot, 0);
  sprites[1]!.active = true;
  controller.follow(2);
  sprites[1]!.team = 2;
  controller.update(sprites, 1, false, 0);
  assert.equal(controller.targetSlot, 0);
});

test("admission invalidation prevents same-slot reuse and round epochs clear camera ownership", () => {
  const sprites = roster();
  const controller = observer(sprites);
  controller.follow(2);
  controller.invalidate(2);
  controller.update(sprites, 1, false, 0);
  assert.equal(controller.targetSlot, 0);
  controller.follow(4);
  controller.update(sprites, 1, false, 1);
  assert.equal(controller.targetSlot, 0);
  controller.follow(4);
  controller.reset();
  assert.equal(controller.observing, false);
  assert.equal(controller.target, undefined);
});

test("respawn and joining a playing team return directly to the local playing camera", () => {
  const sprites = roster();
  const controller = observer(sprites);
  controller.follow(4);
  sprites[0]!.team = 1;
  controller.update(sprites, 1, false, 0);
  assert.equal(controller.observing, false);
  assert.equal(controller.targetSlot, 1);
  assert.throws(() => controller.cycle(), /spectator or dead/);
  sprites[0]!.flags |= SPRITE_FLAGS.dead;
  controller.update(sprites, 1, false, 0);
  controller.cycle();
  sprites[0]!.flags &= ~SPRITE_FLAGS.dead;
  controller.update(sprites, 1, false, 0);
  assert.equal(controller.targetSlot, 1);
});

test("native fire/jet direction, ten-tick delay, Up freecam and capture suppression", () => {
  const controller = observer();
  assert.equal(controller.controls(true, false, false, true), false);
  assert.equal(controller.targetSlot, 0);
  assert.equal(controller.controls(true, false, false), true);
  assert.equal(controller.targetSlot, 2);
  for (let tick = 0; tick < 9; tick++) assert.equal(controller.controls(false, true, false), false);
  assert.equal(controller.controls(false, true, false), true);
  assert.equal(controller.targetSlot, 4);
  for (let tick = 0; tick < 10; tick++) controller.controls(false, false, false);
  assert.equal(controller.controls(false, false, true), true);
  assert.equal(controller.free, true);
  for (let tick = 0; tick < 20; tick++) assert.equal(controller.controls(false, false, true), false);
});

test("switchcamflag uses last matching objective skeleton position and never mutates simulation", () => {
  const camera = createCamera(640, 480);
  const things = [
    { style: 1, pointCount: 1, skeleton: new Float32Array([10, 20]), posX: 99, posY: 99 },
    { style: 2, pointCount: 1, skeleton: new Float32Array([30, 40]), posX: 99, posY: 99 },
    { style: 1, pointCount: 1, skeleton: new Float32Array([50, 60]), posX: 99, posY: 99 },
  ];
  const view = { thingCount: things.length, thing: (index: number) => things[index]! } as Pick<RenderView, "thingCount" | "thing">;
  const controller = observer();
  controller.follow(2);
  controller.flag(1, view, camera);
  assert.equal(controller.free, true);
  assert.equal(camera.x, 50);
  assert.equal(camera.y, 60);
  assert.equal(things[2]!.skeleton[0], 50);
  assert.throws(() => controller.flag(3, view, camera), /No flag/);
  assert.throws(() => controller.flag(0, view, camera), /Invalid/);
  assert.equal(camera.x, 50);
});

test("spectator freecam is pointer driven with native center dead zone; realistic lock does not drift", () => {
  const camera = createCamera(1280, 960, 10, 20);
  updateSpectatorCamera(camera, undefined, 640, 480, 1280, 960);
  assert.equal(camera.x, 10);
  assert.equal(camera.y, 20);
  updateSpectatorCamera(camera, undefined, 940, 480, 1280, 960);
  assert.equal(camera.x, 15);
  updateSpectatorCamera(camera, undefined, 940, 480, 1280, 960, false);
  assert.equal(camera.x, 15);
  updateSpectatorCamera(camera, { x: 115, y: 120 }, 640, 480, 1280, 960);
  assert.equal(camera.x, 29);
  assert.equal(camera.y, 34);
});
