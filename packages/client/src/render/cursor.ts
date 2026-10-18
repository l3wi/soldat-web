import { SPRITE_FLAGS } from "@soldat-web/sim-host";
import { spriteVisible, type WorldSprite, type WorldView } from "../world";

/** TSprite.GetMoveacc, Anims.pas IDs; stock lezy.poa has 27 frames. */
export function cursorMoveAccuracy(sprite: Pick<WorldSprite, "legsId" | "legsFrame" | "flags" | "jetpack" | "fuel">, movementAcc: number): number {
  if (movementAcc <= 0) return 0;
  const id = sprite.legsId;
  if ((sprite.jetpack && sprite.fuel > 0) || id === 1 || id === 2 || id === 3 || id === 4 || id === 22 || id === 23)
    return movementAcc * 7;
  if (((sprite.flags & SPRITE_FLAGS.permanent) === 0 && id !== 34 && id !== 38 && id !== 6 && id !== 7 && id !== 24) ||
      id === 39 || (id === 34 && sprite.legsFrame < 27)) return movementAcc * 3;
  return 0;
}

/** InterfaceGraphics.pas:2291–2308; bink is supplied by the client-only counter. */
export function cursorScale(moveAccuracy: number, hitSprayCounter = 0, sniperLine = false): number {
  const base = sniperLine ? 0.5 : 1;
  const inaccuracy = hitSprayCounter + moveAccuracy * 100;
  return inaccuracy > 0 ? base + Math.pow(inaccuracy, 0.6) / 20 * base : base;
}

/** UpdateFrame.pas cursor hit test, including concealed prone/predator players. */
export function cursorTarget(world: WorldView, me: WorldSprite, x: number, y: number, realistic: boolean): WorldSprite | undefined {
  for (const target of world.sprites) {
    const friendly = me.team >= 1 && me.team <= 4 && me.team === target.team;
    if (!target.active || target.slot === me.slot || target.team === 5 || target.bonusStyle === 19 ||
      (realistic && ((target.cursorVisibilityMask ?? 0) & (1 << (me.slot - 1))) === 0) ||
      !spriteVisible(target, me.slot, realistic) ||
      (target.position !== 1 && !friendly && (me.flags & SPRITE_FLAGS.dead) === 0 && (target.flags & SPRITE_FLAGS.dead) === 0)) continue;
    if ((target.x - x) ** 2 + (target.y - y) ** 2 < 15 ** 2) return target;
  }
  return undefined;
}
