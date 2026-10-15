import { RENDER_LAYOUT, SPRITE_FLAGS, type RenderView, type SimHost } from "@soldat-web/sim-host";

export interface WorldSprite {
  slot: number; active: boolean; flags: number; direction: number;
  legsId: number; legsFrame: number; bodyId: number; bodyFrame: number;
  aimX: number; aimY: number; weapon: number; x: number; y: number;
  health: number; fuel: number; team: number;
  ammo: number; grenades: number; reload: number;
  primaryIndex: number; secondaryIndex: number; secondaryWeapon: number; tertiaryWeapon: number;
  fired: number; vest: number; jetpack: boolean; alpha: number;
  wearHelmet: number; hasCigar: number; chain: number; headCap: number; hairStyle: number;
  shirtColor: number; pantsColor: number; skinColor: number; hairColor: number;
  ceaseFireCounter: number; clipTexture: number; clipInTime: number; clipOutTime: number;
  style: number; demoPlayer: boolean; named: boolean;
  /** World-space points; zero-based pair index corresponds to native point 1. */
  readonly previous: Float32Array; readonly current: Float32Array;
}
export interface WorldView {
  readonly sprites: readonly WorldSprite[];
  readonly tick: number;
  sync(): void;
  readonly ceaseFireTime?: number;
}

/** Copies only render data into reusable client-owned arrays. Never writes WASM.
 * Reads layout constants exported by sim-host, not a second ABI definition.
 * RenderView.sprite() is intentionally not used in the hot loop: it allocates.
 */
export class SimWorldView implements WorldView {
  readonly sprites: WorldSprite[];
  tick = 0;
  get renderView(): RenderView {
    if (this.buffer !== this.host.exports.memory.buffer) this.sync();
    return this.view;
  }
  get ceaseFireTime(): number { return this.renderView.globals.ceaseFireTime; }
  private view!: RenderView;
  private data!: DataView;
  private pointer = 0;
  private buffer?: ArrayBufferLike;
  constructor(private readonly host: SimHost, team = 1) {
    this.sprites = Array.from({ length: RENDER_LAYOUT.slots }, (_, i) => ({
      slot: i + 1, active: false, flags: 0, direction: 1,
      legsId: 0, legsFrame: 0, bodyId: 0, bodyFrame: 0,
      aimX: 0, aimY: 0, weapon: 0, x: 0, y: 0, health: 0, fuel: 0, team,
      ammo: 0, grenades: 0, reload: 0, primaryIndex: 0, secondaryIndex: 0, secondaryWeapon: 0, tertiaryWeapon: 0,
      fired: 0, vest: 0, jetpack: false, alpha: 255, wearHelmet: 0, hasCigar: 0, chain: 0, headCap: 0, hairStyle: 0,
      shirtColor: 0, pantsColor: 0, skinColor: 0, hairColor: 0, ceaseFireCounter: 0, clipTexture: 0, clipInTime: 0, clipOutTime: 0,
      style: 0, demoPlayer: false, named: false,
      previous: new Float32Array(RENDER_LAYOUT.skeletonPoints * 2),
      current: new Float32Array(RENDER_LAYOUT.skeletonPoints * 2),
    }));
    this.sync();
  }
  sync(): void {
    const pointer = this.host.exports.sim_render_view();
    if (pointer <= 0) throw new Error(`sim_render_view returned ${pointer}`);
    const buffer = this.host.exports.memory.buffer;
    if (buffer !== this.buffer || pointer !== this.pointer) {
      const view = this.host.renderView();
      if (typeof view === "number") throw new Error(`sim_render_view returned ${view}`);
      this.view = view;
      this.pointer = pointer; this.buffer = buffer;
      this.data = new DataView(buffer, this.view.bytes.byteOffset, this.view.bytes.byteLength);
    }
    const d = this.data, s = RENDER_LAYOUT.sprite;
    this.tick = d.getUint32(RENDER_LAYOUT.header.tick, true);
    for (let i = 0; i < this.sprites.length; i++) {
      const sprite = this.sprites[i]!, base = RENDER_LAYOUT.headerBytes + i * RENDER_LAYOUT.spriteBytes;
      sprite.flags = d.getUint32(base + s.flags, true);
      sprite.active = (sprite.flags & SPRITE_FLAGS.active) !== 0;
      if (!sprite.active) continue;
      sprite.slot = d.getUint32(base + s.slot, true);
      sprite.direction = d.getInt32(base + s.direction, true);
      sprite.legsId = d.getInt32(base + s.legsId, true); sprite.legsFrame = d.getInt32(base + s.legsFrame, true);
      sprite.bodyId = d.getInt32(base + s.bodyId, true); sprite.bodyFrame = d.getInt32(base + s.bodyFrame, true);
      sprite.aimX = d.getInt32(base + s.aimX, true); sprite.aimY = d.getInt32(base + s.aimY, true);
      sprite.weapon = d.getInt32(base + s.weapon, true);
      sprite.x = d.getFloat32(base + s.posX, true); sprite.y = d.getFloat32(base + s.posY, true);
      sprite.health = d.getFloat32(base + s.health, true); sprite.fuel = d.getInt32(base + s.fuel, true);
      sprite.team = d.getUint32(base + s.team, true);
      const inventory = d.getUint32(base + s.inventory, true);
      sprite.ammo = inventory & 255; sprite.grenades = (inventory >>> 8) & 255; sprite.reload = inventory >>> 16;
      sprite.primaryIndex = d.getInt32(base + s.primaryIndex, true); sprite.secondaryIndex = d.getInt32(base + s.secondaryIndex, true);
      sprite.secondaryWeapon = d.getUint32(base + s.secondaryWeapon, true); sprite.tertiaryWeapon = d.getUint32(base + s.tertiaryWeapon, true);
      sprite.fired = d.getUint32(base + s.fired, true); sprite.vest = d.getFloat32(base + s.vest, true);
      sprite.jetpack = d.getUint32(base + s.jetpack, true) !== 0; sprite.alpha = d.getUint32(base + s.alpha, true);
      sprite.wearHelmet = d.getUint32(base + s.wearHelmet, true); sprite.hasCigar = d.getUint32(base + s.hasCigar, true);
      sprite.chain = d.getUint32(base + s.chain, true); sprite.headCap = d.getUint32(base + s.headCap, true); sprite.hairStyle = d.getUint32(base + s.hairStyle, true);
      sprite.shirtColor = d.getUint32(base + s.shirtColor, true); sprite.pantsColor = d.getUint32(base + s.pantsColor, true);
      sprite.skinColor = d.getUint32(base + s.skinColor, true); sprite.hairColor = d.getUint32(base + s.hairColor, true);
      sprite.ceaseFireCounter = d.getInt32(base + s.ceaseFireCounter, true);
      sprite.clipTexture = d.getUint32(base + s.clipTexture, true); sprite.clipInTime = d.getUint32(base + s.clipInTime, true); sprite.clipOutTime = d.getUint32(base + s.clipOutTime, true);
      sprite.style = d.getUint32(base + s.style, true); sprite.demoPlayer = d.getUint32(base + s.demoPlayer, true) !== 0;
      sprite.named = d.getUint32(base + s.playerNameLength, true) > 0;
      for (let p = 0; p < RENDER_LAYOUT.skeletonPoints * 2; p++) {
        sprite.previous[p] = d.getFloat32(base + s.previousSkeleton + p * 4, true);
        sprite.current[p] = d.getFloat32(base + s.currentSkeleton + p * 4, true);
      }
    }
  }
}
