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
 * The Phase 1 render ABI has no AimDistCoef: this follows the original ordinary
 * (unscoped) soldier branch, not the spectator or weapon-scope camera.
 */
export function updateCamera(
  camera: Camera, playerX: number, playerY: number, aimX: number, aimY: number,
): void {
  // Recover exp(oldZoom) * (mx - GameWidthHalf) from the world aim.
  const aimOffsetX = aimX - camera.x;
  const aimOffsetY = aimY - camera.y;
  const oldZoom = camera.z;
  const target = zoomTargets.get(camera) ?? oldZoom;
  camera.z += (target - camera.z) / 4;
  if (Math.abs(target - camera.z) < 0.01) camera.z = target;
  const zoomChange = Math.exp(camera.z - oldZoom);
  // Original resolution/scope expression reduces to this with AimDistCoef=7.
  const resolution = 2 * 640 / camera.width - 1;
  camera.x += (playerX - camera.x) * 0.14 + aimOffsetX * zoomChange / 7 * resolution;
  camera.y += (playerY - camera.y) * 0.14 + aimOffsetY * zoomChange / 7;
}
