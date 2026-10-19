import type { Camera } from './render/types';

const zoomTargets = new WeakMap<Camera, number>();

// FPC Round uses ties-to-even, unlike Math.round (notably for negative halves).
function roundEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  return fraction === 0.5 ? lower + (lower % 2 === 0 ? 0 : 1) : Math.round(value);
}

export function createCamera(width: number, height: number, x = 0, y = 0, z = 0): Camera {
  const camera: Camera = { x, y, z, width: 640, height: 480 };
  resizeCamera(camera, width, height);
  zoomTargets.set(camera, z);
  return camera;
}

export function resizeCamera(camera: Camera, width: number, height: number): void {
  camera.width = roundEven(Math.max(1.25, Math.min(1.78, width / height)) * 480);
  camera.height = 480;
}

/** Physical canvas pixels to down-positive world coordinates; out is caller-owned. */
export function worldAt(
  camera: Camera, x: number, y: number, width: number, height: number,
  out: { x: number; y: number },
): void {
  const zoom = Math.exp(camera.z);
  out.x = camera.x + (x / width - 0.5) * camera.width * zoom;
  out.y = camera.y + (y / height - 0.5) * camera.height * zoom;
}

/** Inverse of worldAt, returning physical canvas pixels without allocating. */
export function screenAt(
  camera: Camera, x: number, y: number, width: number, height: number,
  out: { x: number; y: number },
): void {
  const zoom = Math.exp(camera.z);
  out.x = ((x - camera.x) / (camera.width * zoom) + 0.5) * width;
  out.y = ((y - camera.y) / (camera.height * zoom) + 0.5) * height;
}

export function setZoom(camera: Camera, targetZ: number): void {
  zoomTargets.set(camera, targetZ);
}

/**
 * Call once per 60 Hz tick. Source: UpdateFrame.pas:351-375 (live soldier follow),
 * GameRendering.pas:357-364 (EaseZoom), Constants.pas CAMSPEED=0.14,
 * DEFAULTAIMDIST=7. aimX/Y are world coordinates sampled BEFORE this update.
 * AimDistCoef comes from native Control.pas (Barrett prone/crouch scope).
 */
export function updateCamera(
  camera: Camera, playerX: number, playerY: number, aimX: number, aimY: number, aimDistCoef = 7,
): void {
  // Recover exp(oldZoom) * (mx - GameWidthHalf) from the world aim.
  const aimOffsetX = aimX - camera.x;
  const aimOffsetY = aimY - camera.y;
  const oldZoom = camera.z;
  const target = zoomTargets.get(camera) ?? oldZoom;
  camera.z += (target - camera.z) / 4;
  if (Math.abs(target - camera.z) < 0.01) camera.z = target;
  const zoomChange = Math.exp(camera.z - oldZoom);
  const distance = aimDistCoef > 0 ? aimDistCoef : 7;
  const resolution = 2 * 640 / camera.width - 1 +
    (camera.width - 640) / camera.width * (7 - distance) / 6.8;
  camera.x += (playerX - camera.x) * 0.14 + aimOffsetX * zoomChange / distance * resolution;
  camera.y += (playerY - camera.y) * 0.14 + aimOffsetY * zoomChange / distance;
}

/** Observer camera uses the same native smoothing/zoom as playing. Free camera
 * is pointer-driven with a 20x20 logical-pixel dead zone, not WASD translation.
 * Source: UpdateFrame.pas:351-399, SPECTATORAIMDIST=30.
 * A missing target with free=false holds a realistic dead player's camera still.
 */
export function updateSpectatorCamera(
  camera: Camera, target: { x: number; y: number; aimDistCoef?: number } | undefined,
  pointerX: number, pointerY: number, width: number, height: number, free = true,
): void {
  const offsetX = (pointerX / width - 0.5) * camera.width;
  const offsetY = (pointerY / height - 0.5) * camera.height;
  if (target) {
    const zoom = Math.exp(camera.z);
    updateCamera(camera, target.x, target.y, camera.x + offsetX * zoom, camera.y + offsetY * zoom, target.aimDistCoef);
    return;
  }
  // Preserve zoom easing even with no live target.
  updateCamera(camera, camera.x, camera.y, camera.x, camera.y);
  if (!free || (Math.abs(offsetX) < camera.width / 64 && Math.abs(offsetY) < 10)) return;
  const speed = Math.exp(camera.z) / 30;
  camera.x += offsetX * speed;
  camera.y += offsetY * speed;
}

/** Render-only interpolation of the native fixed-step camera. The source is
 * never modified: input sampling and the next 60 Hz follow update keep using it. */
export class CameraPresentation {
  readonly camera: Camera;
  private x: number;
  private y: number;
  private z: number;
  constructor(private readonly source: Camera) {
    this.camera = { ...source };
    this.x = source.x; this.y = source.y; this.z = source.z;
  }
  /** Capture immediately before each fixed camera update, including catch-up ticks. */
  capture(): void {
    this.x = this.source.x; this.y = this.source.y; this.z = this.source.z;
  }
  /** Round/respawn/observer snaps must not interpolate across unrelated views. */
  reset(): void { this.capture(); this.present(1); }
  present(fraction: number): Camera {
    const t = Math.max(0, Math.min(1, fraction)), source = this.source, out = this.camera;
    out.x = this.x + (source.x - this.x) * t;
    out.y = this.y + (source.y - this.y) * t;
    out.z = this.z + (source.z - this.z) * t;
    out.width = source.width; out.height = source.height;
    return out;
  }
}
