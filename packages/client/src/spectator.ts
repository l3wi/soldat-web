import { SPRITE_FLAGS, type RenderView } from "@soldat-web/sim-host";
import type { Camera } from "./render/types";

/** Borrow existing WorldSprite records; no copied roster or simulation writes. */
export interface SpectatorSprite {
  readonly slot: number;
  readonly active: boolean;
  readonly flags: number;
  readonly team: number;
  readonly x: number;
  readonly y: number;
  readonly aimDistCoef?: number;
}

/** Presentation-only camera ownership. Call update after each world sync, before input.
 * Source: ClientGame.GetCameraTarget, Control.pas:253-293, ClientCommands switchcam/flag.
 * Admission changes must call invalidate(slot), even if a replacement reuses its name.
 */
export class SpectatorController {
  private sprites: readonly SpectatorSprite[] = [];
  private localSlot = 0;
  private localTeam = -1;
  private epoch: number | string | undefined;
  private realistic = false;
  private selectedSlot = 0;
  private selectedTeam = -1;
  private isObserving = false;
  private cooldown = 0;
  private freeCamPressed = false;

  public get observing(): boolean { return this.isObserving; }
  public get targetSlot(): number { return this.selectedSlot; }
  public get target(): SpectatorSprite | undefined { return this.sprite(this.selectedSlot); }
  /** False with no target means a realistic dead player has a stationary camera. */
  public get free(): boolean {
    return this.isObserving && this.selectedSlot === 0 && this.canFree();
  }

  public update(
    sprites: readonly SpectatorSprite[], localSlot: number, realistic: boolean, epoch: number | string,
  ): void {
    this.sprites = sprites;
    const local = this.sprite(localSlot);
    const observing = local !== undefined && local.active &&
      (local.team === 5 || (local.flags & SPRITE_FLAGS.dead) !== 0);
    const changed = this.epoch !== epoch || this.localSlot !== localSlot || this.localTeam !== local?.team;
    const transition = this.isObserving !== observing;
    this.localSlot = localSlot;
    this.localTeam = local?.team ?? -1;
    this.realistic = realistic;
    this.epoch = epoch;
    this.isObserving = observing;
    if (changed || transition) {
      this.selectedSlot = 0;
      this.selectedTeam = -1;
      this.cooldown = 0;
      this.freeCamPressed = false;
    }
    if (!observing) {
      this.selectedSlot = local?.active && local.team !== 5 ? localSlot : 0;
      this.selectedTeam = local?.team ?? -1;
      return;
    }
    const target = this.sprite(this.selectedSlot);
    if (!this.eligible(target) || target?.team !== this.selectedTeam) {
      this.selectedSlot = 0;
      this.selectedTeam = -1;
    }
  }

  public reset(): void {
    this.sprites = [];
    this.localSlot = 0;
    this.localTeam = -1;
    this.epoch = undefined;
    this.selectedSlot = 0;
    this.selectedTeam = -1;
    this.isObserving = false;
    this.cooldown = 0;
    this.freeCamPressed = false;
  }

  /** Invalidate on authoritative leave/re-admission; never silently follow a reused slot. */
  public invalidate(slot: number): void {
    if (this.selectedSlot === slot) {
      this.selectedSlot = 0;
      this.selectedTeam = -1;
    }
    if (this.localSlot === slot) {
      this.localTeam = -1;
      this.cooldown = 0;
      this.freeCamPressed = false;
    }
  }

  public cycle(backwards = false): number {
    this.requireObserving();
    const count = this.sprites.length;
    const start = this.selectedSlot || (backwards ? 1 : 0);
    for (let offset = 1; offset <= count; offset++) {
      const slot = ((start - 1 + (backwards ? -offset : offset)) % count + count) % count + 1;
      const sprite = this.sprite(slot);
      if (!this.eligible(sprite)) continue;
      this.select(sprite!);
      return slot;
    }
    this.selectedSlot = 0;
    this.selectedTeam = -1;
    return 0;
  }

  /** Original switchcam is spectator-only; zero selects free camera. */
  public follow(slot: number): void {
    this.requireSpectator();
    if (!Number.isInteger(slot) || slot < 0 || slot > this.sprites.length) {
      throw new Error(`Invalid camera id. Must be in range [0, ${this.sprites.length}]`);
    }
    if (slot === 0) { this.freeCamera(); return; }
    const sprite = this.sprite(slot);
    if (!this.eligible(sprite)) throw new Error("Camera target is not a living player");
    this.select(sprite!);
  }

  public freeCamera(): void {
    this.requireObserving();
    if (!this.canFree()) throw new Error("Free camera is unavailable to dead players in realistic mode");
    this.selectedSlot = 0;
    this.selectedTeam = -1;
  }

  /** Original switchcamflag jumps once to the last matching thing, then remains free.
   * Styles 1/2/3 are red/blue/yellow flags; other objective styles work as in Pascal.
   */
  public flag(style: number, view: Pick<RenderView, "thingCount" | "thing">, camera: Camera): void {
    this.requireSpectator();
    if (!Number.isInteger(style) || style <= 0) throw new Error("Invalid flag/objective style");
    let found = false, x = 0, y = 0;
    for (let index = 0; index < view.thingCount; index++) {
      const thing = view.thing(index);
      if (thing.style !== style) continue;
      x = thing.pointCount > 0 ? thing.skeleton[0]! : thing.posX;
      y = thing.pointCount > 0 ? thing.skeleton[1]! : thing.posY;
      found = true;
    }
    if (!found) throw new Error(`No flag/objective with style ${style}`);
    this.freeCamera();
    camera.x = x;
    camera.y = y;
  }

  /** Once per 60 Hz input tick. Fire cycles forward; Jet cycles backward; Up requests
   * freecam (cycles teammates instead in realistic mode). Native MenuTimer is 10.
   * Return true to recenter the pointer after a camera transition.
   */
  public controls(fire: boolean, jet: boolean, up: boolean, captured = false): boolean {
    if (this.cooldown > 0) this.cooldown--;
    if (captured || !this.isObserving) { this.freeCamPressed = false; return false; }
    if (!fire && !jet && !up) { this.freeCamPressed = false; return false; }
    if (this.cooldown > 0) return false;
    if (up && this.canFree()) {
      if (this.freeCamPressed) return false;
      this.freeCamera();
    } else {
      const slot = this.cycle(jet);
      if (slot === 0 && this.freeCamPressed) return false;
    }
    this.freeCamPressed = this.selectedSlot === 0;
    this.cooldown = 10;
    return true;
  }

  private sprite(slot: number): SpectatorSprite | undefined {
    return slot > 0 ? this.sprites[slot - 1] : undefined;
  }
  private eligible(sprite: SpectatorSprite | undefined): boolean {
    return sprite !== undefined && sprite.active && sprite.team !== 5 &&
      (sprite.flags & SPRITE_FLAGS.dead) === 0 &&
      (this.localTeam === 5 || sprite.team === this.localTeam);
  }
  private canFree(): boolean { return this.localTeam === 5 || !this.realistic; }
  private select(sprite: SpectatorSprite): void {
    this.selectedSlot = sprite.slot;
    this.selectedTeam = sprite.team;
  }
  private requireObserving(): void {
    if (!this.isObserving) throw new Error("Camera controls require a spectator or dead player");
  }
  private requireSpectator(): void {
    if (!this.isObserving || this.localTeam !== 5) throw new Error("You are not a spectator");
  }
}
