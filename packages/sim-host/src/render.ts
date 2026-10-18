export const RENDER_ABI_VERSION = 0x00010006;
export const RENDER_LAYOUT = {
  headerBytes: 32, spriteBytes: 696, slots: 32, skeletonPoints: 24,
  header: { version: 0, tick: 4, spriteCount: 8, slots: 12, spriteStride: 16, bulletsOffset: 20, thingsOffset: 24, totalBytes: 28 },
  sprite: { slot: 0, flags: 4, direction: 8, legsId: 12, legsFrame: 16, bodyId: 20, bodyFrame: 24, aimX: 28, aimY: 32, weapon: 36, posX: 40, posY: 44, health: 48, fuel: 52, previousSkeleton: 56, currentSkeleton: 248, team: 440, inventory: 444,
    fired: 448, clipTexture: 452, clipInTime: 456, clipOutTime: 460, secondaryWeapon: 464, tertiaryWeapon: 468, vest: 472, jetpack: 476,
    alpha: 480, wearHelmet: 484, hasCigar: 488, chain: 492, headCap: 496, hairStyle: 500, shirtColor: 504, pantsColor: 508, skinColor: 512, hairColor: 516,
    ceaseFireCounter: 520, visible: 524, style: 528, demoPlayer: 532, weaponAmmo: 536, weaponReloadTime: 540, weaponFireInterval: 544, fireIntervalCount: 548,
    kills: 552, deaths: 556, ping: 560, playerFlags: 564, controlMethod: 568, playerNameLength: 572, playerName: 576, jetColor: 624, primaryIndex: 628, secondaryIndex: 632,
    weaponBink: 636, controlBits: 640, mouseDist: 644, currentWaypoint: 648, nextWaypoint: 652,
    availableWeaponsMask: 656, limboAvailable: 660, respawnCounter: 664, bonusStyle: 668, bonusTime: 672, multikills: 676, aimDistCoef: 680, position: 684, visibleMask: 688, cursorVisibilityMask: 692 },
  playerNameBytes: 48,
  sectionHeaderBytes: 8, bulletBytes: 96, thingBytes: 324, maxBullets: 254, maxThings: 90,
  bulletsOffset: 22304, thingsOffset: 46696, globalsOffset: 75864, globalsBytes: 112, totalBytes: 75976,
  bullet: { owner: 24, ownerWeapon: 28, velocityX: 32, velocityY: 36, timeout: 40, imageStyle: 44,
    velocityPrevX: 48, velocityPrevY: 52, hitMultiply: 56, hitMultiplyPrev: 60, timeoutPrev: 64, initialX: 68, initialY: 72, hitBody: 76, pingAdd: 80, pingAddStart: 84, active: 88, presentationFlags: 92 },
  thing: { owner: 24, ammo: 28, holdingSprite: 32, flags: 36, pointCount: 40, skeleton: 48, timeout: 304, interest: 308, color: 312, presentationFlags: 316, creationFacing: 320 },
  globals: { teamScores: 0, startHealth: 24, mapStartJet: 28, gameMode: 32, killLimit: 36, ceaseFireTime: 40,
    timeLimitTicks: 44, timeLeftTicks: 48, mapChangeCounter: 52, roundPhase: 56, roundEpoch: 60,
    realistic: 64, survival: 68, advance: 72, bulletTime: 76, tickScale: 80, sniperLine: 84, friendlyFire: 88,
    enabledWeaponsMask: 92, survivalEndRound: 96, advanceAmount: 100, bonusFrequency: 104, bulletTimeTimer: 108 },
  section: { count: 0, stride: 4 },
  movingEntity: { slot: 0, style: 4, posX: 8, posY: 12, oldPosX: 16, oldPosY: 20, owner: 24 },
} as const;
export const SPRITE_FLAGS = { active: 1, dead: 2, ground: 4, permanent: 8, crouch: 16, prone: 32, bot: 64 } as const;
export const BULLET_PRESENTATION_FLAGS = { pingUnavailable: 1 } as const;
export const THING_PRESENTATION_FLAGS = { colorAvailable: 1 } as const;
const nameDecoder = new TextDecoder();

export interface RenderSprite {
  slot: number; flags: number; direction: number;
  legsId: number; legsFrame: number; bodyId: number; bodyFrame: number;
  aimX: number; aimY: number; weapon: number;
  posX: number; posY: number; health: number; fuel: number;
  team: number; ammo: number; grenades: number; reloadTicks: number;
  fired: number; clipTexture: number; clipInTime: number; clipOutTime: number;
  secondaryWeapon: number; tertiaryWeapon: number; primaryIndex: number; secondaryIndex: number;
  vest: number; jetpack: boolean; alpha: number; wearHelmet: number; hasCigar: number;
  chain: number; headCap: number; hairStyle: number;
  shirtColor: number; pantsColor: number; skinColor: number; hairColor: number; jetColor: number;
  ceaseFireCounter: number; visible: number; style: number; demoPlayer: boolean;
  weaponAmmo: number; weaponReloadTime: number; weaponFireInterval: number; fireIntervalCount: number;
  kills: number; deaths: number; ping: number; playerFlags: number; controlMethod: number; playerName: string;
  weaponBink: number; controlBits: number; mouseDist: number; currentWaypoint: number; nextWaypoint: number;
  availableWeaponsMask: number; limboAvailable: boolean; respawnCounter: number;
  bonusStyle: number; bonusTime: number; multikills: number; aimDistCoef: number; position: number; visibleMask: number; cursorVisibilityMask: number;
  previousSkeleton: Float32Array; currentSkeleton: Float32Array;
}
export interface RenderMovingEntity {
  slot: number; style: number; posX: number; posY: number;
  oldPosX: number; oldPosY: number;
}
export interface RenderBullet extends RenderMovingEntity {
  owner: number; ownerWeapon: number; velocityX: number; velocityY: number; timeout: number; imageStyle: number;
  velocityPrevX: number; velocityPrevY: number; hitMultiply: number; hitMultiplyPrev: number;
  timeoutPrev: number; initialX: number; initialY: number; hitBody: number;
  pingAdd: number; pingAddStart: number; active: boolean; presentationFlags: number;
}
export interface RenderThing extends RenderMovingEntity {
  owner: number; ammo: number; holdingSprite: number; flags: number; pointCount: number;
  timeout: number; interest: number; color: number; presentationFlags: number; creationFacing: number;
  /** 16 interleaved x,y,oldX,oldY entries, consume only pointCount. */
  skeleton: Float32Array;
}

export interface RenderGlobals {
  /** Borrowed original TeamScore[0..5], not a sorted scoreboard. */
  teamScores: Int32Array;
  startHealth: number; mapStartJet: number; gameMode: number; killLimit: number; ceaseFireTime: number;
  timeLimitTicks: number; timeLeftTicks: number; mapChangeCounter: number;
  /** 0 playing, 1 native results countdown, 2 awaiting explicit host map epoch. */
  roundPhase: number; roundEpoch: number;
  realistic: boolean; survival: boolean; advance: boolean; bulletTime: boolean; tickScale: number;
  sniperLine: boolean; friendlyFire: boolean; enabledWeaponsMask: number; survivalEndRound: boolean;
  advanceAmount: number; bonusFrequency: number; bulletTimeTimer: number;
}
export interface RenderView {
  version: number; tick: number; spriteCount: number; slots: number;
  bulletsOffset: number; thingsOffset: number; bytes: Uint8Array;
  globals: RenderGlobals;
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
  if (version !== RENDER_ABI_VERSION || slots !== RENDER_LAYOUT.slots || stride !== RENDER_LAYOUT.spriteBytes || totalBytes !== RENDER_LAYOUT.totalBytes) throw new Error("Unsupported render-view layout");
  const bytes = new Uint8Array(memory.buffer, ptr, totalBytes);
  const bulletsOffset = header.getUint32(h.bulletsOffset, true);
  const thingsOffset = header.getUint32(h.thingsOffset, true);
  if (bulletsOffset !== RENDER_LAYOUT.bulletsOffset || thingsOffset !== RENDER_LAYOUT.thingsOffset) throw new Error("Invalid render section offsets");
  const globals = new DataView(memory.buffer, ptr + RENDER_LAYOUT.globalsOffset, RENDER_LAYOUT.globalsBytes);
  const g = RENDER_LAYOUT.globals;
  const bulletSection = new DataView(memory.buffer, ptr + bulletsOffset, RENDER_LAYOUT.sectionHeaderBytes);
  const thingSection = new DataView(memory.buffer, ptr + thingsOffset, RENDER_LAYOUT.sectionHeaderBytes);
  function section(view: DataView, offset: number, maximum: number, expectedStride: number) {
    if (offset < RENDER_LAYOUT.headerBytes + slots * stride || offset + RENDER_LAYOUT.sectionHeaderBytes > totalBytes) throw new Error("Invalid render section offset");
    const count = view.getUint32(RENDER_LAYOUT.section.count, true);
    const itemStride = view.getUint32(RENDER_LAYOUT.section.stride, true);
    if (count > maximum || itemStride !== expectedStride || offset + RENDER_LAYOUT.sectionHeaderBytes + count * itemStride > totalBytes) throw new Error("Unsupported moving-entity render layout");
    return count;
  }
  section(bulletSection, bulletsOffset, RENDER_LAYOUT.maxBullets, RENDER_LAYOUT.bulletBytes);
  section(thingSection, thingsOffset, RENDER_LAYOUT.maxThings, RENDER_LAYOUT.thingBytes);
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
    version, get tick() { return header.getUint32(h.tick, true); },
    get spriteCount() { return header.getUint32(h.spriteCount, true); }, slots,
    bulletsOffset, thingsOffset, bytes,
    get bulletCount() { return section(bulletSection, bulletsOffset, RENDER_LAYOUT.maxBullets, RENDER_LAYOUT.bulletBytes); },
    get thingCount() { return section(thingSection, thingsOffset, RENDER_LAYOUT.maxThings, RENDER_LAYOUT.thingBytes); },
    globals: {
      teamScores: new Int32Array(memory.buffer, ptr + RENDER_LAYOUT.globalsOffset + g.teamScores, 6),
      get startHealth() { return globals.getInt32(g.startHealth, true); },
      get mapStartJet() { return globals.getInt32(g.mapStartJet, true); },
      get gameMode() { return globals.getInt32(g.gameMode, true); },
      get killLimit() { return globals.getInt32(g.killLimit, true); },
      get ceaseFireTime() { return globals.getInt32(g.ceaseFireTime, true); },
      get timeLimitTicks() { return globals.getInt32(g.timeLimitTicks, true); },
      get timeLeftTicks() { return globals.getInt32(g.timeLeftTicks, true); },
      get mapChangeCounter() { return globals.getInt32(g.mapChangeCounter, true); },
      get roundPhase() { return globals.getInt32(g.roundPhase, true); },
      get roundEpoch() { return globals.getUint32(g.roundEpoch, true); },
      get realistic() { return globals.getUint32(g.realistic, true) !== 0; },
      get survival() { return globals.getUint32(g.survival, true) !== 0; },
      get advance() { return globals.getUint32(g.advance, true) !== 0; },
      get bulletTime() { return globals.getUint32(g.bulletTime, true) !== 0; },
      get tickScale() { return globals.getFloat32(g.tickScale, true); },
      get sniperLine() { return globals.getUint32(g.sniperLine, true) !== 0; },
      get friendlyFire() { return globals.getUint32(g.friendlyFire, true) !== 0; },
      get enabledWeaponsMask() { return globals.getUint32(g.enabledWeaponsMask, true); },
      get survivalEndRound() { return globals.getUint32(g.survivalEndRound, true) !== 0; },
      get advanceAmount() { return globals.getInt32(g.advanceAmount, true); },
      get bonusFrequency() { return globals.getInt32(g.bonusFrequency, true); },
      get bulletTimeTimer() { return globals.getInt32(g.bulletTimeTimer, true); },
    },
    bullet(index: number) {
      const view = new DataView(memory.buffer, ptr + bulletsOffset + 8 + index * RENDER_LAYOUT.bulletBytes, RENDER_LAYOUT.bulletBytes);
      return { ...movingEntity(bulletsOffset, section(bulletSection, bulletsOffset, RENDER_LAYOUT.maxBullets, RENDER_LAYOUT.bulletBytes), index, RENDER_LAYOUT.bulletBytes),
        owner: view.getUint32(24,true), ownerWeapon: view.getUint32(28,true),
        velocityX: view.getFloat32(32,true), velocityY: view.getFloat32(36,true),
        timeout: view.getInt32(40,true), imageStyle: view.getUint32(44,true),
        velocityPrevX: view.getFloat32(48,true), velocityPrevY: view.getFloat32(52,true),
        hitMultiply: view.getFloat32(56,true), hitMultiplyPrev: view.getFloat32(60,true), timeoutPrev: view.getInt32(64,true),
        initialX: view.getFloat32(68,true), initialY: view.getFloat32(72,true), hitBody: view.getUint32(76,true),
        pingAdd: view.getInt32(80,true), pingAddStart: view.getInt32(84,true), active: view.getUint32(88,true) !== 0, presentationFlags: view.getUint32(92,true) };
    },
    thing(index: number) {
      const base = ptr + thingsOffset + 8 + index * RENDER_LAYOUT.thingBytes;
      const common = movingEntity(thingsOffset, section(thingSection, thingsOffset, RENDER_LAYOUT.maxThings, RENDER_LAYOUT.thingBytes), index, RENDER_LAYOUT.thingBytes);
      const view = new DataView(memory.buffer, base, RENDER_LAYOUT.thingBytes);
      const pointCount = view.getUint32(40,true);
      if (pointCount > 16) throw new Error("Unsupported thing skeleton");
      return { ...common, owner: view.getUint32(24,true), ammo: view.getUint32(28,true),
        holdingSprite: view.getUint32(32,true), flags: view.getUint32(36,true), pointCount,
        timeout: view.getInt32(304,true), interest: view.getInt32(308,true), color: view.getUint32(312,true), presentationFlags: view.getUint32(316,true),
        creationFacing: view.getUint32(320,true),
        skeleton: new Float32Array(memory.buffer,base+48,64) };
    },
    sprite(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= slots) throw new RangeError("Render slot index out of bounds");
      const base = ptr + RENDER_LAYOUT.headerBytes + index * stride;
      const view = new DataView(memory.buffer, base, stride);
      const s = RENDER_LAYOUT.sprite;
      const nameLength = view.getUint32(s.playerNameLength, true);
      if (nameLength > RENDER_LAYOUT.playerNameBytes) throw new Error("Unsupported player name length");
      return {
        slot: view.getUint32(s.slot, true), flags: view.getUint32(s.flags, true), direction: view.getInt32(s.direction, true),
        legsId: view.getInt32(s.legsId, true), legsFrame: view.getInt32(s.legsFrame, true),
        bodyId: view.getInt32(s.bodyId, true), bodyFrame: view.getInt32(s.bodyFrame, true),
        aimX: view.getInt32(s.aimX, true), aimY: view.getInt32(s.aimY, true), weapon: view.getInt32(s.weapon, true),
        posX: view.getFloat32(s.posX, true), posY: view.getFloat32(s.posY, true), health: view.getFloat32(s.health, true), fuel: view.getInt32(s.fuel, true),
        team: view.getUint32(s.team,true), ammo: view.getUint32(s.inventory,true) & 255,
        grenades: (view.getUint32(s.inventory,true) >>> 8) & 255,
        reloadTicks: view.getUint32(s.inventory,true) >>> 16,
        fired: view.getUint32(s.fired,true), clipTexture: view.getUint32(s.clipTexture,true),
        clipInTime: view.getUint32(s.clipInTime,true), clipOutTime: view.getUint32(s.clipOutTime,true),
        secondaryWeapon: view.getUint32(s.secondaryWeapon,true), tertiaryWeapon: view.getUint32(s.tertiaryWeapon,true),
        primaryIndex: view.getInt32(s.primaryIndex,true), secondaryIndex: view.getInt32(s.secondaryIndex,true),
        vest: view.getFloat32(s.vest,true), jetpack: view.getUint32(s.jetpack,true) !== 0, alpha: view.getUint32(s.alpha,true),
        wearHelmet: view.getUint32(s.wearHelmet,true), hasCigar: view.getUint32(s.hasCigar,true), chain: view.getUint32(s.chain,true),
        headCap: view.getUint32(s.headCap,true), hairStyle: view.getUint32(s.hairStyle,true),
        shirtColor: view.getUint32(s.shirtColor,true), pantsColor: view.getUint32(s.pantsColor,true),
        skinColor: view.getUint32(s.skinColor,true), hairColor: view.getUint32(s.hairColor,true), jetColor: view.getUint32(s.jetColor,true),
        ceaseFireCounter: view.getInt32(s.ceaseFireCounter,true), visible: view.getUint32(s.visible,true),
        style: view.getUint32(s.style,true), demoPlayer: view.getUint32(s.demoPlayer,true) !== 0,
        weaponAmmo: view.getUint32(s.weaponAmmo,true), weaponReloadTime: view.getUint32(s.weaponReloadTime,true),
        weaponFireInterval: view.getUint32(s.weaponFireInterval,true), fireIntervalCount: view.getUint32(s.fireIntervalCount,true),
        kills: view.getInt32(s.kills,true), deaths: view.getInt32(s.deaths,true), ping: view.getUint32(s.ping,true),
        playerFlags: view.getUint32(s.playerFlags,true), controlMethod: view.getUint32(s.controlMethod,true),
        playerName: nameDecoder.decode(new Uint8Array(memory.buffer, base + s.playerName, nameLength)),
        weaponBink: view.getInt32(s.weaponBink,true), controlBits: view.getUint32(s.controlBits,true),
        mouseDist: view.getInt32(s.mouseDist,true), currentWaypoint: view.getInt32(s.currentWaypoint,true),
        nextWaypoint: view.getInt32(s.nextWaypoint,true),
        availableWeaponsMask: view.getUint32(s.availableWeaponsMask,true), limboAvailable: view.getUint32(s.limboAvailable,true) !== 0,
        respawnCounter: view.getInt32(s.respawnCounter,true), bonusStyle: view.getUint32(s.bonusStyle,true),
        bonusTime: view.getInt32(s.bonusTime,true), multikills: view.getUint32(s.multikills,true),
        aimDistCoef: view.getFloat32(s.aimDistCoef,true), position: view.getInt32(s.position,true), visibleMask: view.getUint32(s.visibleMask,true),
        cursorVisibilityMask: view.getUint32(s.cursorVisibilityMask,true),
        previousSkeleton: new Float32Array(memory.buffer, base + s.previousSkeleton, RENDER_LAYOUT.skeletonPoints * 2),
        currentSkeleton: new Float32Array(memory.buffer, base + s.currentSkeleton, RENDER_LAYOUT.skeletonPoints * 2),
      };
    },
  };
}
