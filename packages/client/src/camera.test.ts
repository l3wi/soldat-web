import assert from "node:assert/strict";
import test from "node:test";
import { CameraPresentation, createCamera, screenAt, setZoom, updateCamera, worldAt } from "./camera";

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

test("render camera shares soldier phase without changing fixed follow or zoom", () => {
  const camera = createCamera(1280, 720, 100, 80), presentation = new CameraPresentation(camera);
  setZoom(camera, -0.6);
  const before = { ...camera };
  presentation.capture();
  updateCamera(camera, 120, 90, 300, 140);
  const fixed = { ...camera };
  for (const fraction of [0, 1 / 6, 0.5, 5 / 6, 1]) {
    const rendered = presentation.present(fraction);
    near(rendered.x, before.x + (fixed.x - before.x) * fraction);
    near(rendered.y, before.y + (fixed.y - before.y) * fraction);
    near(rendered.z, before.z + (fixed.z - before.z) * fraction);
    const projected = { x: 0, y: 0 }, recovered = { x: 0, y: 0 };
    screenAt(rendered, 111, 87, 1280, 720, projected);
    worldAt(rendered, projected.x, projected.y, 1280, 720, recovered);
    near(recovered.x, 111); near(recovered.y, 87);
    assert.deepEqual(camera, fixed, "Rendering cannot feed interpolated coordinates back into native follow");
  }
  camera.x = -900; camera.y = 400;
  presentation.reset();
  assert.deepEqual(presentation.present(0), camera, "View discontinuities snap both render endpoints");
});
