import { SPRITE_FLAGS } from "@soldat-web/sim-host";
import type { WorldSprite } from "../world";

/** RenderGostek visibility, GostekGraphics.pas:265–415; indices are the pinned
 * GostekGraphics.inc painter-order IDs, not weapon numbers. Mutates only cache. */
export function weaponVisibility(s: WorldSprite, visible: Uint8Array): void {
  const dead = (s.flags & SPRITE_FLAGS.dead) !== 0;
  if (s.jetpack && s.fuel > 0) {
    visible[19] = visible[32] = 0; visible[20] = visible[33] = 1;
  }
  visible[37] = Number(s.vest > 0);
  const firstGrenade = s.tertiaryWeapon === 50 ? 64 : 69;
  const grenades = Math.min(5, s.grenades - Number(s.bodyId === 9));
  for (let i = 0; i < grenades; i++) visible[firstGrenade + i] = 1;
  if (s.chain === 1) visible[58] = visible[59] = visible[60] = 1;
  if (s.chain === 2) visible[61] = visible[62] = visible[63] = 1;
  visible[57] = Number(s.hasCigar === 5 || s.hasCigar === 10);
  if (s.primaryIndex === 15 || s.primaryIndex === 16) visible[48] = 1;
  if (s.secondaryIndex >= 1 && s.secondaryIndex <= 17) visible[s.secondaryIndex - 1] = 1;
  if (s.primaryIndex === 10) {
    visible[102] = 1;
    visible[101] = Number(s.ammo > 0 || (s.ammo === 0 && s.reload < 65));
    visible[103] = Number(s.fired > 0);
  } else if (s.primaryIndex === 15 || s.primaryIndex === 16) {
    visible[s.ammo === 0 ? 120 : 117] = 1;
    if (s.bodyId === 20) visible[119] = visible[121] = 1;
    else visible[116] = visible[118] = 1;
    visible[122] = Number(s.fired > 0);
  } else if (!dead && s.primaryIndex >= 1 && s.primaryIndex <= 17) {
    const index = s.primaryIndex === 17 ? 123 : 74 + 3 * (s.primaryIndex - 1);
    visible[index] = 1;
    visible[index + 1] = Number(s.clipTexture > 0 && (s.ammo > 0 || (s.ammo === 0 && (s.reload < s.clipInTime || s.reload > s.clipOutTime))));
    visible[index + 2] = Number(s.fired > 0);
  }
}
