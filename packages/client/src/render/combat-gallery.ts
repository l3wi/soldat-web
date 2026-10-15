import { RENDER_LAYOUT, SIM_ABI_VERSION, readRenderView, type RenderView } from "@soldat-web/sim-host";
import type { WorldView, WorldSprite } from "../world";
import type { HudPresentation } from "./hud";

export interface CombatGallery { view: RenderView; world: WorldView; hud: HudPresentation; mode: string }
interface NativeGallery {
  kind: "native-render-gallery"; mode: string;
  bullets: Record<string, number | boolean>[];
  things: (Record<string, unknown> & { skeleton: { x: number; y: number; oldX: number; oldY: number }[] })[];
  globals: { teamScores: number[]; startHealth: number; mapStartJet: number; gameMode: number; killLimit: number; ceaseFireTime: number };
  hud: HudPresentation & { health: number; weapon: number; ammo: number; ammoCapacity: number; grenades: number; fuel: number; jetCapacity: number; reload: number; reloadTime: number; startHealth: number; rasterOnly: boolean; playerName?: string; [field: string]: unknown };
}

/** Render-only evidence adapter: bytes come from the native gallery JSON, not
 * gameplay injection or a reconstructed simulation. Never passed to sim_load_state. */
export function createCombatGallery(input: unknown, mode: string): CombatGallery {
  const source = input as NativeGallery;
  if (source.kind !== "native-render-gallery" || !["objects", "hud", "hud-reload", "hud-full"].includes(mode) || source.mode !== mode) throw new Error("Invalid native combat gallery");
  const memory = new WebAssembly.Memory({ initial: Math.ceil(RENDER_LAYOUT.totalBytes / 65536) });
  const ptr = 4, bytes = new DataView(memory.buffer, ptr, RENDER_LAYOUT.totalBytes);
  for (const [offset, value] of [[0, SIM_ABI_VERSION], [4, 0], [8, mode === "objects" ? 0 : 1], [12, 32], [16, RENDER_LAYOUT.spriteBytes], [20, RENDER_LAYOUT.bulletsOffset], [24, RENDER_LAYOUT.thingsOffset], [28, RENDER_LAYOUT.totalBytes]]) bytes.setUint32(offset!, value!, true);
  const writeRecord = (base: number, fields: Record<string, number>, values: Record<string, unknown>, floats: readonly string[]) => {
    for (const [name, offset] of Object.entries(fields)) {
      if (typeof values[name] !== "number" && typeof values[name] !== "boolean") continue;
      const value = Number(values[name]);
      if (!Number.isFinite(value)) throw new Error(`Nonfinite native gallery ${name}`);
      if (floats.includes(name)) bytes.setFloat32(base + offset, value, true);
      else bytes.setInt32(base + offset, value, true);
    }
  };
  const bulletCount = mode === "objects" ? source.bullets.length : 0;
  const thingCount = mode === "objects" ? source.things.length : 0;
  bytes.setUint32(RENDER_LAYOUT.bulletsOffset, bulletCount, true);
  bytes.setUint32(RENDER_LAYOUT.bulletsOffset + 4, RENDER_LAYOUT.bulletBytes, true);
  for (let index = 0; index < bulletCount; index++) {
    const base = RENDER_LAYOUT.bulletsOffset + 8 + index * RENDER_LAYOUT.bulletBytes;
    writeRecord(base, { ...RENDER_LAYOUT.movingEntity, ...RENDER_LAYOUT.bullet }, source.bullets[index]!, ["posX", "posY", "oldPosX", "oldPosY", "velocityX", "velocityY", "velocityPrevX", "velocityPrevY", "hitMultiply", "hitMultiplyPrev", "initialX", "initialY"]);
  }
  bytes.setUint32(RENDER_LAYOUT.thingsOffset, thingCount, true);
  bytes.setUint32(RENDER_LAYOUT.thingsOffset + 4, RENDER_LAYOUT.thingBytes, true);
  for (let index = 0; index < thingCount; index++) {
    const thing = source.things[index]!, base = RENDER_LAYOUT.thingsOffset + 8 + index * RENDER_LAYOUT.thingBytes;
    writeRecord(base, { ...RENDER_LAYOUT.movingEntity, ...RENDER_LAYOUT.thing }, thing, ["posX", "posY", "oldPosX", "oldPosY"]);
    bytes.setUint32(base + RENDER_LAYOUT.thing.pointCount, thing.skeleton.length, true);
    for (let point = 0; point < thing.skeleton.length; point++) {
      const p = thing.skeleton[point]!, offset = base + RENDER_LAYOUT.thing.skeleton + point * 16;
      bytes.setFloat32(offset, p.x, true); bytes.setFloat32(offset + 4, p.y, true);
      bytes.setFloat32(offset + 8, p.oldX, true); bytes.setFloat32(offset + 12, p.oldY, true);
    }
  }
  writeRecord(RENDER_LAYOUT.globalsOffset, RENDER_LAYOUT.globals, source.globals, []);
  source.globals.teamScores.forEach((score, index) => bytes.setInt32(RENDER_LAYOUT.globalsOffset + index * 4, score, true));
  const h = source.hud, s = RENDER_LAYOUT.sprite;
  if (mode !== "objects") {
    writeRecord(RENDER_LAYOUT.headerBytes, s, { ...h, slot: 1, flags: 1, health: h.health, weapon: h.weapon, fuel: h.fuel, weaponAmmo: h.ammoCapacity, weaponReloadTime: h.reloadTime, weaponFireInterval: h.fireInterval }, ["health", "vest"]);
    bytes.setUint32(RENDER_LAYOUT.headerBytes + s.inventory, h.ammo | (h.grenades << 8) | (h.reload << 16), true);
    const playerName = h.playerName ?? (typeof h.name === "string" ? h.name : undefined);
    if (playerName) {
      const name = new TextEncoder().encode(playerName).subarray(0, RENDER_LAYOUT.playerNameBytes);
      bytes.setUint32(RENDER_LAYOUT.headerBytes + s.playerNameLength, name.length, true);
      new Uint8Array(memory.buffer, ptr + RENDER_LAYOUT.headerBytes + s.playerName, name.length).set(name);
    }
  }
  const view = readRenderView(memory, ptr);
  if (typeof view === "number") throw new Error("Native gallery view unavailable");
  const native = view.sprite(0);
  const sprite: WorldSprite = { ...native, active: mode !== "objects", x: native.posX, y: native.posY, reload: native.reloadTicks, named: false, previous: native.previousSkeleton, current: native.currentSkeleton };
  const world: WorldView = { tick: 0, sprites: [sprite], sync() {}, ceaseFireTime: source.globals.ceaseFireTime };
  return { view, world, mode, hud: { ...h, rasterOnly: mode !== "hud-full", killFeedAvailable: true, startHealth: h.startHealth, startJet: h.jetCapacity, ammoCapacity: h.ammoCapacity, reloadTime: h.reloadTime } };
}
