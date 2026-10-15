export const RENDER_LAYOUT = {
  headerBytes: 32, spriteBytes: 448, slots: 32, skeletonPoints: 24,
  header: { version: 0, tick: 4, spriteCount: 8, slots: 12, spriteStride: 16, bulletsOffset: 20, thingsOffset: 24, totalBytes: 28 },
  sprite: { slot: 0, flags: 4, direction: 8, legsId: 12, legsFrame: 16, bodyId: 20, bodyFrame: 24, aimX: 28, aimY: 32, weapon: 36, posX: 40, posY: 44, health: 48, fuel: 52, previousSkeleton: 56, currentSkeleton: 248, team: 440, inventory: 444 },
  sectionHeaderBytes: 8, bulletBytes: 48, thingBytes: 304, maxBullets: 254, maxThings: 90,
  bulletsOffset: 14368, thingsOffset: 26568, totalBytes: 53936,
  section: { count: 0, stride: 4 },
  movingEntity: { slot: 0, style: 4, posX: 8, posY: 12, oldPosX: 16, oldPosY: 20, owner: 24 },
} as const;
export const SPRITE_FLAGS = { active: 1, dead: 2, ground: 4, permanent: 8, crouch: 16, prone: 32 } as const;

export interface RenderSprite {
  slot: number; flags: number; direction: number;
  legsId: number; legsFrame: number; bodyId: number; bodyFrame: number;
  aimX: number; aimY: number; weapon: number;
  posX: number; posY: number; health: number; fuel: number;
  team: number; ammo: number; grenades: number; reloadTicks: number;
  previousSkeleton: Float32Array; currentSkeleton: Float32Array;
}
export interface RenderMovingEntity {
  slot: number; style: number; posX: number; posY: number;
  oldPosX: number; oldPosY: number;
}
export interface RenderBullet extends RenderMovingEntity {
  owner: number; ownerWeapon: number; velocityX: number; velocityY: number; timeout: number; imageStyle: number;
}
export interface RenderThing extends RenderMovingEntity {
  owner: number; ammo: number; holdingSprite: number; flags: number; pointCount: number;
  /** 16 interleaved x,y,oldX,oldY entries, consume only pointCount. */
  skeleton: Float32Array;
}

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
  if (version !== 0x00010002 || slots !== RENDER_LAYOUT.slots || stride !== RENDER_LAYOUT.spriteBytes || totalBytes !== RENDER_LAYOUT.totalBytes) throw new Error("Unsupported render-view layout");
  const bytes = new Uint8Array(memory.buffer, ptr, totalBytes);
  const bulletsOffset = header.getUint32(h.bulletsOffset, true);
  const thingsOffset = header.getUint32(h.thingsOffset, true);
  function section(offset: number, maximum: number, expectedStride: number) {
    if (offset < RENDER_LAYOUT.headerBytes + slots * stride || offset + RENDER_LAYOUT.sectionHeaderBytes > totalBytes) throw new Error("Invalid render section offset");
    const view = new DataView(memory.buffer, ptr + offset, RENDER_LAYOUT.sectionHeaderBytes);
    const count = view.getUint32(RENDER_LAYOUT.section.count, true);
    const itemStride = view.getUint32(RENDER_LAYOUT.section.stride, true);
    if (count > maximum || itemStride !== expectedStride || offset + RENDER_LAYOUT.sectionHeaderBytes + count * itemStride > totalBytes) throw new Error("Unsupported moving-entity render layout");
    return count;
  }
  const bulletCount = section(bulletsOffset, RENDER_LAYOUT.maxBullets, RENDER_LAYOUT.bulletBytes);
  const thingCount = section(thingsOffset, RENDER_LAYOUT.maxThings, RENDER_LAYOUT.thingBytes);
  function movingEntity(offset: number, count: number, index: number, size: number): RenderMovingEntity {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError("Moving-entity render index out of bounds");
    const view = new DataView(memory.buffer, ptr + offset + RENDER_LAYOUT.sectionHeaderBytes + index * size, size);
    const field = RENDER_LAYOUT.movingEntity;
    return {
      slot: view.getUint32(field.slot, true), style: view.getUint32(field.style, true),
      posX: view.getFloat32(field.posX, true), posY: view.getFloat32(field.posY, true),
      oldPosX: view.getFloat32(field.oldPosX, true), oldPosY: view.getFloat32(field.oldPosY, true),
    };
  }
  return {
    version, tick: header.getUint32(h.tick, true), spriteCount: header.getUint32(h.spriteCount, true), slots,
    bulletsOffset, thingsOffset, bytes, bulletCount, thingCount,
    bullet(index: number) {
      const view = new DataView(memory.buffer, ptr + bulletsOffset + 8 + index * RENDER_LAYOUT.bulletBytes, RENDER_LAYOUT.bulletBytes);
      return { ...movingEntity(bulletsOffset, bulletCount, index, RENDER_LAYOUT.bulletBytes),
        owner: view.getUint32(24,true), ownerWeapon: view.getUint32(28,true),
        velocityX: view.getFloat32(32,true), velocityY: view.getFloat32(36,true),
        timeout: view.getInt32(40,true), imageStyle: view.getUint32(44,true) };
    },
    thing(index: number) {
      const base = ptr + thingsOffset + 8 + index * RENDER_LAYOUT.thingBytes;
      const common = movingEntity(thingsOffset, thingCount, index, RENDER_LAYOUT.thingBytes);
      const view = new DataView(memory.buffer, base, RENDER_LAYOUT.thingBytes);
      const pointCount = view.getUint32(40,true);
      if (pointCount > 16) throw new Error("Unsupported thing skeleton");
      return { ...common, owner: view.getUint32(24,true), ammo: view.getUint32(28,true),
        holdingSprite: view.getUint32(32,true), flags: view.getUint32(36,true), pointCount,
        skeleton: new Float32Array(memory.buffer,base+48,64) };
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
        team: view.getUint32(s.team,true), ammo: view.getUint32(s.inventory,true) & 255,
        grenades: (view.getUint32(s.inventory,true) >>> 8) & 255,
        reloadTicks: view.getUint32(s.inventory,true) >>> 16,
        previousSkeleton: new Float32Array(memory.buffer, base + s.previousSkeleton, RENDER_LAYOUT.skeletonPoints * 2),
        currentSkeleton: new Float32Array(memory.buffer, base + s.currentSkeleton, RENDER_LAYOUT.skeletonPoints * 2),
      };
    },
  };
}
