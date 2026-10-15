import { RENDER_LAYOUT, SPRITE_FLAGS, type RenderView, type SimHost } from "@soldat-web/sim-host";

export interface WorldSprite {
  slot: number; active: boolean; flags: number; direction: number;
  legsId: number; legsFrame: number; bodyId: number; bodyFrame: number;
  aimX: number; aimY: number; weapon: number; x: number; y: number;
  health: number; fuel: number; team: number;
  /** World-space points; zero-based pair index corresponds to native point 1. */
  readonly previous: Float32Array; readonly current: Float32Array;
}
export interface WorldView {
  readonly sprites: readonly WorldSprite[];
  readonly tick: number;
  sync(): void;
}

/** Copies only render data into reusable client-owned arrays. Never writes WASM.
 * Reads layout constants exported by sim-host, not a second ABI definition.
 * RenderView.sprite() is intentionally not used in the hot loop: it allocates.
 */
export class SimWorldView implements WorldView {
  readonly sprites: WorldSprite[];
  tick = 0;
  private view!: RenderView;
  private data!: DataView;
  private pointer = 0;
  private buffer?: ArrayBufferLike;
  constructor(private readonly host: SimHost, team = 1) {
    this.sprites = Array.from({ length: RENDER_LAYOUT.slots }, (_, i) => ({
      slot: i + 1, active: false, flags: 0, direction: 1,
      legsId: 0, legsFrame: 0, bodyId: 0, bodyFrame: 0,
      aimX: 0, aimY: 0, weapon: 0, x: 0, y: 0, health: 0, fuel: 0, team,
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
      for (let p = 0; p < RENDER_LAYOUT.skeletonPoints * 2; p++) {
        sprite.previous[p] = d.getFloat32(base + s.previousSkeleton + p * 4, true);
        sprite.current[p] = d.getFloat32(base + s.currentSkeleton + p * 4, true);
      }
    }
  }
}
