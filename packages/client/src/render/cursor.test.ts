import assert from "node:assert/strict";
import test from "node:test";
import { SPRITE_FLAGS } from "@soldat-web/sim-host";
import { cursorScale, cursorTarget } from "./cursor";
import { spriteVisible, type WorldSprite, type WorldView } from "../world";

function soldier(slot: number, team: number, patch: Partial<WorldSprite> = {}): WorldSprite {
  return { slot, team, active: true, flags: 0, x: 100, y: 80, position: 1, bonusStyle: 0,
    visibleMask: 0xffffffff, cursorVisibilityMask: 0xffffffff, ...patch } as WorldSprite;
}

test("cursor identification respects native prone, predator and observer concealment", () => {
  const me = soldier(1, 1), enemy = soldier(2, 2), ally = soldier(3, 1);
  const world: WorldView = { sprites: [me, enemy, ally], tick: 1, sync() {} };
  assert.equal(cursorTarget(world, me, 100, 80, false), enemy);
  enemy.position = 4;
  assert.equal(cursorTarget(world, me, 100, 80, false), ally, "prone enemy is not identified; prone ally may be");
  enemy.flags = SPRITE_FLAGS.dead;
  assert.equal(cursorTarget(world, me, 100, 80, false), enemy);
  enemy.bonusStyle = 19;
  assert.equal(cursorTarget(world, me, 100, 80, false), ally, "predator never exposes a name");
  enemy.bonusStyle = 0; enemy.visibleMask = enemy.cursorVisibilityMask = 2;
  assert.equal(cursorTarget(world, me, 100, 80, true), ally, "visibility for another observer must not leak");
  assert.equal(spriteVisible(enemy, 1, true), false);
  assert.equal(spriteVisible(enemy, 2, true), true);
  assert.equal(cursorTarget(world, me, 115, 80, false), undefined, "native hit radius is strictly below15");
});

test("sniper line halves both base cursor and bink expansion", () => {
  assert.equal(cursorScale(0, 0, true), 0.5);
  assert.equal(cursorScale(0.02, 12, true), cursorScale(0.02, 12, false) / 2);
});
