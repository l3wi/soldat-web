export const RENDER_LAYOUT = {
  headerBytes: 32, spriteBytes: 448, slots: 32, skeletonPoints: 24,
  header: { version: 0, tick: 4, spriteCount: 8, slots: 12, spriteStride: 16, bulletsOffset: 20, thingsOffset: 24, totalBytes: 28 },
  sprite: { slot: 0, flags: 4, direction: 8, legsId: 12, legsFrame: 16, bodyId: 20, bodyFrame: 24, aimX: 28, aimY: 32, weapon: 36, posX: 40, posY: 44, health: 48, fuel: 52, previousSkeleton: 56, currentSkeleton: 248 },
  sectionHeaderBytes: 8, movingEntityBytes: 32, maxBullets: 254, maxThings: 90,
  bulletsOffset: 14368, thingsOffset: 22504, totalBytes: 25392,
  section: { count: 0, stride: 4 },
  movingEntity: { slot: 0, style: 4, posX: 8, posY: 12, oldPosX: 16, oldPosY: 20, timeout: 24, ownerOrHolder: 28 },
} as const;
export const SPRITE_FLAGS = { active: 1, dead: 2, ground: 4, permanent: 8, crouch: 16, prone: 32 } as const;

export interface RenderSprite {
  slot: number; flags: number; direction: number;
  legsId: number; legsFrame: number; bodyId: number; bodyFrame: number;
  aimX: number; aimY: number; weapon: number;
  posX: number; posY: number; health: number; fuel: number;
  previousSkeleton: Float32Array; currentSkeleton: Float32Array;
}
export interface RenderMovingEntity {
  slot: number; style: number; posX: number; posY: number;
  oldPosX: number; oldPosY: number; timeout: number;
}
export interface RenderBullet extends RenderMovingEntity { owner: number }
export interface RenderThing extends RenderMovingEntity { holdingSprite: number }

export interface RenderView {
  version: number; tick: number; spriteCount: number; slots: number;
  bulletsOffset: number; thingsOffset: number; bytes: Uint8Array;
  sprite(index: number): RenderSprite;
  bulletCount: number; thingCount: number;
  bullet(index: number): RenderBullet;
  thing(index: number): RenderThing;
}

/** Borrowed views: consume synchronously; refresh after any sim call or memory growth. */
export function readRenderView(memory: WebAssembly.Memory, ptr: number): RenderView | number {
  if (ptr <= 0) return ptr;
  const h = RENDER_LAYOUT.header;
  const header = new DataView(memory.buffer, ptr, RENDER_LAYOUT.headerBytes);
  const version = header.getUint32(h.version, true);
  const slots = header.getUint32(h.slots, true);
  const stride = header.getUint32(h.spriteStride, true);
  const totalBytes = header.getUint32(h.totalBytes, true);
  if (version !== 0x00010001 || slots !== RENDER_LAYOUT.slots || stride !== RENDER_LAYOUT.spriteBytes || totalBytes < RENDER_LAYOUT.headerBytes + slots * stride) throw new Error("Unsupported render-view layout");
  const bytes = new Uint8Array(memory.buffer, ptr, totalBytes);
  const bulletsOffset = header.getUint32(h.bulletsOffset, true);
  const thingsOffset = header.getUint32(h.thingsOffset, true);
  function section(offset: number, maximum: number) {
    if (offset < RENDER_LAYOUT.headerBytes + slots * stride || offset + RENDER_LAYOUT.sectionHeaderBytes > totalBytes) throw new Error("Invalid render section offset");
    const view = new DataView(memory.buffer, ptr + offset, RENDER_LAYOUT.sectionHeaderBytes);
    const count = view.getUint32(RENDER_LAYOUT.section.count, true);
    const itemStride = view.getUint32(RENDER_LAYOUT.section.stride, true);
    if (count > maximum || itemStride !== RENDER_LAYOUT.movingEntityBytes || offset + RENDER_LAYOUT.sectionHeaderBytes + count * itemStride > totalBytes) throw new Error("Unsupported moving-entity render layout");
    return count;
  }
  const bulletCount = section(bulletsOffset, RENDER_LAYOUT.maxBullets);
  const thingCount = section(thingsOffset, RENDER_LAYOUT.maxThings);
  function movingEntity<K extends "owner" | "holdingSprite">(offset: number, count: number, index: number, ownerField: K): RenderMovingEntity & Record<K, number> {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError("Moving-entity render index out of bounds");
    const view = new DataView(memory.buffer, ptr + offset + RENDER_LAYOUT.sectionHeaderBytes + index * RENDER_LAYOUT.movingEntityBytes, RENDER_LAYOUT.movingEntityBytes);
    const field = RENDER_LAYOUT.movingEntity;
    return {
      slot: view.getUint32(field.slot, true), style: view.getUint32(field.style, true),
      posX: view.getFloat32(field.posX, true), posY: view.getFloat32(field.posY, true),
      oldPosX: view.getFloat32(field.oldPosX, true), oldPosY: view.getFloat32(field.oldPosY, true),
      timeout: view.getInt32(field.timeout, true), [ownerField]: view.getUint32(field.ownerOrHolder, true),
    } as unknown as RenderMovingEntity & Record<K, number>;
  }
  return {
    version, tick: header.getUint32(h.tick, true), spriteCount: header.getUint32(h.spriteCount, true), slots,
    bulletsOffset, thingsOffset, bytes, bulletCount, thingCount,
    bullet(index: number) {
      return movingEntity(bulletsOffset, bulletCount, index, "owner");
    },
    thing(index: number) {
      return movingEntity(thingsOffset, thingCount, index, "holdingSprite");
    },
    sprite(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= slots) throw new RangeError("Render slot index out of bounds");
      const base = ptr + RENDER_LAYOUT.headerBytes + index * stride;
      const view = new DataView(memory.buffer, base, stride);
      const s = RENDER_LAYOUT.sprite;
      return {
        slot: view.getUint32(s.slot, true), flags: view.getUint32(s.flags, true), direction: view.getInt32(s.direction, true),
        legsId: view.getInt32(s.legsId, true), legsFrame: view.getInt32(s.legsFrame, true),
        bodyId: view.getInt32(s.bodyId, true), bodyFrame: view.getInt32(s.bodyFrame, true),
        aimX: view.getInt32(s.aimX, true), aimY: view.getInt32(s.aimY, true), weapon: view.getInt32(s.weapon, true),
        posX: view.getFloat32(s.posX, true), posY: view.getFloat32(s.posY, true), health: view.getFloat32(s.health, true), fuel: view.getInt32(s.fuel, true),
        previousSkeleton: new Float32Array(memory.buffer, base + s.previousSkeleton, RENDER_LAYOUT.skeletonPoints * 2),
        currentSkeleton: new Float32Array(memory.buffer, base + s.currentSkeleton, RENDER_LAYOUT.skeletonPoints * 2),
      };
    },
  };
}
