import assert from "node:assert/strict";
import { test } from "node:test";
import { SPRITE_FLAGS } from "@soldat-web/sim-host";
import { LIMBO_WEAPONS, LimboMenu, limboHitIndex, limboKeyIndex, limboRowY, limboWeaponEnabled } from "./limbo";
import { cursorMoveAccuracy, cursorScale } from "./cursor";

test("native bare 1–0 and Ctrl+1–4 use menu indices, not weapon NUMs", () => {
  for (let i = 0; i < 10; i++) {
    const code = `Digit${(i + 1) % 10}`;
    assert.equal(limboKeyIndex(code), i);
    assert.equal(LIMBO_WEAPONS[i]!.num, i + 1);
    assert.equal(limboKeyIndex(code, true), i < 4 ? i + 10 : -1);
  }
  assert.deepEqual(LIMBO_WEAPONS.slice(10).map(weapon => weapon.num), [0, 11, 12, 13]);
  for (const code of ["Numpad1", "KeyA", "Digit11", "Digit", "1"]) assert.equal(limboKeyIndex(code), -1);
  assert.equal(limboKeyIndex("Digit1", false, true), -1);
  assert.equal(limboKeyIndex("Digit1", true, false, true), -1);
  assert.equal(limboKeyIndex("Digit1", false, false, false, true), -1);
});

test("native WeaponActive and WeaponSel are one-based and both must equal one", () => {
  const active = Array<number>(15).fill(1), selection = Array<number>(15).fill(1);
  active[0] = selection[0] = 0;
  for (let i = 0; i < 14; i++) {
    assert.equal(limboWeaponEnabled(i), true);
    assert.equal(limboWeaponEnabled(i, active, selection), true);
  }
  active[1] = 0;
  selection[11] = 0;
  active[14] = 2;
  assert.equal(limboWeaponEnabled(0, active, selection), false);
  assert.equal(limboWeaponEnabled(10, active, selection), false);
  assert.equal(limboWeaponEnabled(13, active, selection), false);
  for (const i of [-1, 14, 1.5, NaN]) assert.equal(limboWeaponEnabled(i, active, selection), false);
  assert.equal(limboWeaponEnabled(0, []), false);
});

test("native row hit geometry preserves the primary/secondary separator", () => {
  for (let i = 0; i < 14; i++) {
    const y = limboRowY(i);
    assert.equal(limboHitIndex(35, y), i);
    assert.equal(limboHitIndex(270, y + 16), i);
    assert.equal(limboHitIndex(34, y + 8), -1);
    assert.equal(limboHitIndex(271, y + 8), -1);
  }
  assert.equal(limboRowY(9), 316);
  assert.equal(limboRowY(10), 352);
  assert.equal(limboHitIndex(100, 342), -1);
  assert.equal(limboHitIndex(100, 153), -1);
});

test("limbo shows on first life and each death; a choice made while dead stays closed through respawn", () => {
  const menu = new LimboMenu();
  menu.observe(false, 8, 12);
  assert.equal(menu.active, true);
  assert.equal(menu.primary, 8);
  assert.equal(menu.secondary, 12);
  menu.choose(0);
  assert.equal(menu.active, false);
  menu.observe(false, 8, 12);
  assert.equal(menu.active, false);
  assert.equal(menu.primary, 1); // current inventory is not the queued choice
  menu.observe(true, 8, 12);
  assert.equal(menu.active, true);
  menu.observe(true, 8, 12);
  assert.equal(menu.active, true);
  menu.choose(2); // picked while dead
  menu.observe(false, 3, 12);
  assert.equal(menu.active, false); // respawn does not reopen it
  menu.observe(false, 3, 12);
  assert.equal(menu.active, false);
  menu.observe(true, 3, 12);
  assert.equal(menu.active, true); // next death does
  menu.observe(false, 3, 12);
  assert.equal(menu.active, true); // unchosen menu stays available after spawning
  menu.active = false;
  menu.spawn(); // explicit spawn can replace an already-living soldier
  assert.equal(menu.active, true);
});

test("secondary choice stays open and primary choice closes, preserving both choices", () => {
  const menu = new LimboMenu();
  menu.observe(false, 4, 0);
  menu.choose(limboKeyIndex("Digit2", true));
  assert.equal(menu.secondary, 11);
  assert.equal(menu.primary, 4);
  assert.equal(menu.active, true);
  assert.equal(menu.selected(11), true);
  menu.choose(limboKeyIndex("Digit0"));
  assert.equal(menu.primary, 10);
  assert.equal(menu.secondary, 11);
  assert.equal(menu.active, false);
  assert.equal(menu.selected(9), true);
});

test("native Tab while alive toggles auto-show, while dead toggles visible menu", () => {
  const menu = new LimboMenu();
  menu.observe(false, 4, 0);
  menu.toggle();
  assert.equal(menu.active, false);
  assert.equal(menu.locked, true);
  menu.observe(true, 4, 0);
  assert.equal(menu.active, false);
  menu.toggle();
  assert.equal(menu.active, true);
  assert.equal(menu.locked, false);
  menu.toggle();
  assert.equal(menu.active, false);
  assert.equal(menu.locked, true);
  menu.observe(false, 4, 0);
  assert.equal(menu.active, false);
  menu.toggle();
  assert.equal(menu.active, false); // alive Tab is NOT arbitrary inventory reopening
  assert.equal(menu.locked, false);
  menu.observe(true, 4, 0);
  assert.equal(menu.active, true);
});

const standing = { legsId: 0, legsFrame: 1, flags: SPRITE_FLAGS.permanent, jetpack: false, fuel: 100 };

test("GetMoveacc running, jumping, rolling and fueled jets use seven times weapon accuracy", () => {
  for (const id of [1, 2, 3, 4, 22, 23])
    assert.equal(cursorMoveAccuracy({ ...standing, legsId: id }, 0.05), 0.05 * 7);
  assert.equal(cursorMoveAccuracy({ ...standing, jetpack: true }, 0.05), 0.05 * 7);
  assert.equal(cursorMoveAccuracy({ ...standing, jetpack: true, fuel: 0 }, 0.05), 0);
  assert.equal(cursorMoveAccuracy({ ...standing, legsId: 1 }, 0), 0);
});

test("GetMoveacc airborne/stand-up/unfinished-prone use three times, crouch/prone exceptions stay stable", () => {
  assert.equal(cursorMoveAccuracy(standing, 0.05), 0);
  assert.equal(cursorMoveAccuracy({ ...standing, flags: 0 }, 0.05), 0.05 * 3);
  assert.equal(cursorMoveAccuracy({ ...standing, legsId: 39 }, 0.05), 0.05 * 3);
  assert.equal(cursorMoveAccuracy({ ...standing, legsId: 34, legsFrame: 26 }, 0.05), 0.05 * 3);
  assert.equal(cursorMoveAccuracy({ ...standing, legsId: 34, legsFrame: 27 }, 0.05), 0);
  for (const id of [6, 7, 24, 34, 38])
    assert.equal(cursorMoveAccuracy({ ...standing, flags: 0, legsId: id, legsFrame: 27 }, 0.05), 0);
});

test("cursor scale preserves native base, power curve and optional producer-supplied bink term", () => {
  assert.equal(cursorScale(0), 1);
  assert.equal(cursorScale(0, 0, true), 0.5);
  assert.equal(cursorScale(0.35), 1 + Math.pow(35, 0.6) / 20);
  assert.equal(cursorScale(0.15, 65), 1 + Math.pow(80, 0.6) / 20);
  assert.equal(cursorScale(0.15, 65, true), (1 + Math.pow(80, 0.6) / 20) / 2);
});
