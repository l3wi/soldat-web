import assert from "node:assert/strict";
import test from "node:test";
import { createCamera, screenAt, updateCamera, worldAt } from "./camera";

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test("native scope coefficient changes camera reach with widescreen compensation", () => {
  for (const coefficient of [7, 4.5, 3.5]) {
    const camera = createCamera(1280, 720, 100, 80);
    const width = camera.width;
    updateCamera(camera, 120, 90, 300, 140, coefficient);
    near(camera.x, 100 + 20 * 0.14 + 200 / coefficient *
      (2 * 640 / width - 1 + (width - 640) / width * (7 - coefficient) / 6.8));
    near(camera.y, 80 + 10 * 0.14 + 60 / coefficient);
  }
});

test("scoped world aim and name projection share a reversible physical viewport", () => {
  const camera = createCamera(1440, 900, -500, 220, -0.3);
  const aim = { x: 0, y: 0 }, screen = { x: 0, y: 0 };
  worldAt(camera, 1050, 201, 1440, 900, aim);
  screenAt(camera, aim.x, aim.y, 1440, 900, screen);
  near(screen.x, 1050); near(screen.y, 201);
});
