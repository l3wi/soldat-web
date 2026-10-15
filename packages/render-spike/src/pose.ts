import type { Point } from "./types";

export interface SourcePoint {
  x: number;
  y: number;
  z: number;
}
export interface AnimationData {
  frames: (SourcePoint & { index: number })[][];
}
export interface SkeletonData {
  points: (SourcePoint & { name: string })[];
  constraints: [number, number][];
}
export type AnimationsData = Record<string, AnimationData>;
export type SkeletonsData = Record<string, SkeletonData>;

// Anims.pas:172–376. Speed is ticks per frame, not frames per second.
export const ANIMATIONS = {
  stand: ["stoi", 3, true],
  run: ["biega", 1, true],
  runBack: ["biegatyl", 1, true],
  jump: ["skok", 1, false],
  jumpSide: ["skokwbok", 1, false],
  fall: ["spada", 1, false],
  crouch: ["kuca", 1, false],
  crouchRun: ["kucaidzie", 2, true],
  reload: ["laduje", 2, false],
  throw: ["rzuca", 1, false],
  recoil: ["odrzut", 1, false],
  smallRecoil: ["odrzut2", 1, false],
  shotgun: ["shotgun", 1, false],
  clipOut: ["clipout", 3, false],
  clipIn: ["clipin", 3, false],
  slideBack: ["slideback", 2, true],
  change: ["change", 1, false],
  throwWeapon: ["wyrzuca", 1, false],
  weaponNone: ["bezbroni", 3, false],
  punch: ["bije", 1, false],
  reloadBow: ["strzala", 1, false],
  barret: ["barret", 9, false],
  roll: ["skokdolobrot", 1, false],
  rollBack: ["skokdolobrottyl", 1, false],
  crouchRunBack: ["kucaidzietyl", 2, true],
  cigar: ["cigar", 3, false],
  match: ["match", 3, false],
  smoke: ["smoke", 4, false],
  wipe: ["wipe", 4, false],
  groin: ["krocze", 2, false],
  piss: ["szcza", 8, false],
  mercy: ["samo", 3, false],
  mercy2: ["samo2", 3, false],
  takeOff: ["takeoff", 2, false],
  prone: ["lezy", 1, false],
  victory: ["cieszy", 3, false],
  aim: ["celuje", 2, false],
  handsUpAim: ["gora", 2, false],
  proneMove: ["lezyidzie", 2, true],
  getUp: ["wstaje", 1, false],
  aimRecoil: ["celujeodrzut", 1, false],
  handsUpRecoil: ["goraodrzut", 1, false],
  melee: ["kolba", 1, false],
  own: ["rucha", 3, false],
} as const;
type AnimationName = keyof typeof ANIMATIONS;
interface Animation {
  frames: Point[][];
  speed: number;
  loop: boolean;
}
export const GOSTEK_STATES = [
  "runRight",
  "runLeft",
  "aim",
  "crouch",
  "prone",
  "jet",
  "reload",
  "dead",
] as const;
export type GostekState = (typeof GOSTEK_STATES)[number];
const legs = new Set([1, 2, 3, 4, 5, 6, 17, 18]);
const points = (): Point[] =>
  Array.from({ length: 25 }, () => ({ x: 0, y: 0 }));
const copy = (to: Point[], from: Point[]): void => {
  for (let i = 1; i <= 24; i++) {
    to[i].x = from[i].x;
    to[i].y = from[i].y;
  }
};

export function facing(state: string, direction?: number): number {
  return direction === undefined
    ? state === "runLeft"
      ? -1
      : 1
    : direction < 0
      ? -1
      : 1;
}

/** Temporary render-spike evaluator, not an authoritative simulation implementation. */
export class PoseLibrary {
  readonly rest = points();
  readonly animations = {} as Record<AnimationName, Animation>;
  readonly cosmeticConstraints: { a: number; b: number; length: number }[];

  constructor(data: AnimationsData, skeletons: SkeletonsData) {
    const skeleton = skeletons["objects/gostek.po"];
    if (!skeleton || skeleton.points.length !== 24)
      throw new Error("Expected the 24-point gostek PO skeleton");
    for (let i = 0; i < skeleton.points.length; i++) {
      const p = skeleton.points[i];
      this.rest[i + 1].x = (-p.x * 3) / 1.2;
      this.rest[i + 1].y = -p.z * 3;
    }
    for (const name of Object.keys(ANIMATIONS) as AnimationName[]) {
      const [file, speed, loop] = ANIMATIONS[name];
      const source = data[`anims/${file}.poa`];
      if (!source?.frames.length) throw new Error(`Missing animation: ${file}`);
      const frames = source.frames.map((frame) => {
        const projected = points();
        for (const p of frame) {
          projected[p.index].x = (-3 * p.x) / 1.1;
          projected[p.index].y = -3 * p.z;
        }
        return projected;
      });
      this.animations[name] = { frames, speed, loop };
    }
    // Native constraints 29/30, used for pendant and dreadlock particles only.
    this.cosmeticConstraints = skeleton.constraints
      .slice(28, 30)
      .map(([a, b]) => ({
        a,
        b,
        length: Math.hypot(
          this.rest[b].x - this.rest[a].x,
          this.rest[b].y - this.rest[a].y,
        ),
      }));
  }

  frame(name: AnimationName, tick: number): number {
    const a = this.animations[name];
    const frame = Math.floor(tick / a.speed);
    return a.loop
      ? frame % a.frames.length
      : Math.min(frame, a.frames.length - 1);
  }

  compose(
    out: Point[],
    prior: Point[],
    tick: number,
    state: string,
    direction: number,
    aim: number,
  ): void {
    let leg: AnimationName = "stand";
    let body: AnimationName = "stand";
    if (state === "runRight" || state === "runLeft") {
      const movement = state === "runLeft" ? -1 : 1;
      leg = movement === direction ? "run" : "runBack";
    } else if (state === "crouch") {
      leg = "crouch";
      body = Math.sin(aim) < -0.5 ? "handsUpAim" : "aim";
    } else if (state === "prone" || state === "dead") {
      leg = body = "prone";
    } else if (state === "jet") leg = "fall";
    else if (state === "reload") body = "reload";
    else if (state !== "aim") throw new Error(`Unknown gostek state: ${state}`);

    // No native death POA exists. The dead fixture is a frozen terminal prone
    // snapshot; corpse collision/Verlet simulation intentionally remains out of this spike.
    const sampleTick =
      state === "dead" ? this.animations.prone.frames.length - 1 : tick;
    const legFrame = this.frame(leg, sampleTick);
    const bodyFrame = this.frame(body, sampleTick);
    const lp = this.animations[leg].frames[legFrame];
    const bp = this.animations[body].frames[bodyFrame];
    let bodyY = state === "crouch" ? 9 : 8;
    if (body === "prone") bodyY = bodyFrame + 1 > 9 ? -2 : 14 - (bodyFrame + 1);
    copy(out, prior);
    // Sprites.pas:549–554 copies previous head anchors before composition.
    out[21].x = prior[9].x;
    out[21].y = prior[9].y;
    out[23].x = prior[12].x;
    out[23].y = prior[12].y;
    for (let i = 1; i <= 20; i++)
      if (legs.has(i)) {
        out[i].x = direction * lp[i].x;
        out[i].y = lp[i].y;
      }
    for (let i = 1; i <= 20; i++)
      if (!legs.has(i)) {
        out[i].x = direction * bp[i].x;
        out[i].y = out[6].y + bodyY + bp[i].y;
      }
    if (state === "dead") return;

    // Aim is a world/screen-space radian angle toward a point 1000 units from
    // the sprite origin. Keep native per-point normalization, not one common arm rotation.
    const mx = Math.cos(aim) * 1000;
    const my = Math.sin(aim) * 1000;
    let dx = out[12].x - mx,
      dy = out[12].y - my;
    let length = Math.hypot(dx, dy);
    if (length !== 0) {
      dx /= length;
      dy /= length;
    }
    out[12].x = out[9].x - direction * dy * 0.1;
    out[12].y = out[9].y + direction * dx * 0.1;
    out[23].x = out[9].x - direction * dy * 5;
    out[23].y = out[9].y + direction * dx * 5;
    // Reload is one of the native body-animation exceptions to procedural aim.
    if (body === "reload") return;
    for (const i of [15, 19]) {
      dx = out[i].x - mx;
      dy = out[i].y - my;
      length = Math.hypot(dx, dy);
      if (length !== 0) {
        dx /= length;
        dy /= length;
      }
      const arm = i === 15 ? -7 : -8;
      out[i].x = out[16].x + dx * arm;
      out[i].y = out[16].y + (i === 19 ? -4 : 0) + dy * arm;
    }
  }
}

/** One fixed-60Hz stream per instance; returned points are reused on the next call. */
export class PoseSampler {
  private previous = points();
  private current = points();
  private readonly render = points();
  private readonly verletOld = points();
  private tick = -1;
  private state = "";
  private direction = 0;

  constructor(private readonly library: PoseLibrary) {}

  sample(
    timeSeconds: number,
    state: string,
    direction: number,
    aim: number,
  ): Point[] {
    const time = Math.max(0, timeSeconds) * 60;
    const target = Math.floor(time);
    if (
      state !== this.state ||
      direction !== this.direction ||
      target < this.tick - 1
    ) {
      this.tick = -1;
      this.state = state;
      this.direction = direction;
      copy(this.previous, this.library.rest);
      copy(this.current, this.library.rest);
      copy(this.verletOld, this.library.rest);
    }
    while (this.tick < target + 1) {
      const swap = this.previous;
      this.previous = this.current;
      this.current = swap;
      this.library.compose(
        this.current,
        this.previous,
        ++this.tick,
        state,
        direction,
        aim,
      );
      if (state !== "dead") this.integrateCosmetics();
      else {
        // Frozen corpse accessories retain the projected PO rest offsets.
        for (const { a, b } of this.library.cosmeticConstraints) {
          this.current[b].x =
            this.current[a].x + this.library.rest[b].x - this.library.rest[a].x;
          this.current[b].y =
            this.current[a].y + this.library.rest[b].y - this.library.rest[a].y;
        }
      }
    }
    const fraction = time - target;
    for (let i = 1; i <= 24; i++) {
      this.render[i].x =
        this.previous[i].x +
        (this.current[i].x - this.previous[i].x) * fraction;
      this.render[i].y =
        this.previous[i].y +
        (this.current[i].y - this.previous[i].y) * fraction;
    }
    return this.render;
  }

  private integrateCosmetics(): void {
    // Parts.pas:138–158,190–211; Anims.pas skeleton damping/gravity.
    for (const { a, b, length } of this.library.cosmeticConstraints) {
      const p = this.current[a],
        anchor = this.current[b],
        old = this.verletOld[a];
      const x = p.x,
        y = p.y;
      p.x = 1.997 * x - 0.997 * old.x;
      p.y = 1.997 * y - 0.997 * old.y + 1.06 * 0.06;
      old.x = x;
      old.y = y;
      const dx = anchor.x - p.x,
        dy = anchor.y - p.y;
      const distance = Math.hypot(dx, dy);
      const correction =
        distance === 0 ? 0 : (0.5 * (distance - length)) / distance;
      p.x += dx * correction;
      p.y += dy * correction;
      anchor.x -= dx * correction;
      anchor.y -= dy * correction;
    }
  }
}
