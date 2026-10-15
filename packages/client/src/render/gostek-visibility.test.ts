import assert from "node:assert/strict";
import test from "node:test";
import { weaponVisibility } from "./gostek-visibility";
import type { WorldSprite } from "../world";
import { CombatEvents } from "../combat-events";
import { SIM_GAMEPLAY_EVENTS, type RenderView } from "@soldat-web/sim-host";

const makeSprite = (fields: Partial<WorldSprite>): WorldSprite => ({ flags: 1, primaryIndex: 3, secondaryIndex: 11, tertiaryWeapon: 50, grenades: 3, ammo: 0, reload: 80, clipTexture: 1, clipInTime: 45, clipOutTime: 120, fired: 0, bodyId: 0, chain: 0, hasCigar: 0, jetpack: false, fuel: 0, vest: 0, ...fields } as WorldSprite);

test("native clip window, muzzle, minigun and bow visibility", () => {
  const v = new Uint8Array(131), s = makeSprite({});
  weaponVisibility(s, v); assert.equal(v[80], 1); assert.equal(v[81], 0); assert.equal(v[82], 0);
  for (const ticks of [44, 121]) { v.fill(0); s.reload = ticks; weaponVisibility(s, v); assert.equal(v[81], 1); }
  s.reload = 45; v.fill(0); weaponVisibility(s, v); assert.equal(v[81], 0, "ClipIn strict inequality");
  s.reload = 120; v.fill(0); weaponVisibility(s, v); assert.equal(v[81], 0, "ClipOut strict inequality");
  s.ammo = 1; s.fired = 1; v.fill(0); weaponVisibility(s, v); assert.equal(v[81], 1); assert.equal(v[82], 1);
  s.flags = 3; v.fill(0); weaponVisibility(s, v); assert.equal(v[80], 0, "ordinary gun hidden on death");
  s.primaryIndex = 10; s.ammo = 0; s.reload = 64; v.fill(0); weaponVisibility(s, v); assert.equal(v[102], 1); assert.equal(v[101], 1);
  s.reload = 65; v.fill(0); weaponVisibility(s, v); assert.equal(v[101], 0);
  s.primaryIndex = 16; s.bodyId = 20; v.fill(0); weaponVisibility(s, v);
  assert.equal(v[119], 1); assert.equal(v[120], 1); assert.equal(v[121], 1); assert.equal(v[122], 1);
});

test("native throw inventory and jet-foot selection", () => {
  const v = new Uint8Array(131), s = makeSprite({ bodyId: 9, jetpack: true, fuel: 1, vest: 25 });
  v[19] = v[32] = 1; weaponVisibility(s, v);
  assert.equal(v[19], 0); assert.equal(v[32], 0); assert.equal(v[20], 1); assert.equal(v[33], 1);
  assert.equal(v[37], 1); assert.equal(v[64], 1); assert.equal(v[65], 1); assert.equal(v[66], 0);
});

test("kill feed consumes only framed native deaths", () => {
  const events = new CombatEvents(), bytes = new Uint8Array(48), d = new DataView(bytes.buffer);
  d.setUint32(0, SIM_GAMEPLAY_EVENTS.DEATH, true); d.setUint32(4, 42, true); d.setUint32(8, 1, true); d.setUint32(12, 2, true); d.setUint32(16, 28, true);
  [3, 3, 1, 1, 8, 1, 2].forEach((value, index) => d.setInt32(20 + index * 4, value, true));
  const world = { slots: 32, sprite: (index: number) => ({ playerName: index === 0 ? "Alpha" : "Bravo" }) } as RenderView;
  events.drain(bytes, bytes.length, world);
  assert.deepEqual(events.kills[0], { tick: 42, killer: "Alpha", victim: "Bravo", weapon: 3, killBullet: 3, suicide: false, killerKills: 8, killerTeam: 1, victimTeam: 2 });
  assert.throws(() => events.drain(bytes, 47, world), /Truncated/);
  events.clear(); d.setUint32(0, 0x80000004, true); events.drain(bytes, bytes.length, world); assert.equal(events.kills.length, 0);
});
