import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PoseLibrary, PoseSampler, GOSTEK_STATES, facing } from "../src/pose";
import type { AnimationsData, SkeletonsData } from "../src/pose";
import type { Point } from "../src/types";
const root = resolve("../..");
const animations: AnimationsData = JSON.parse(
  await readFile(resolve(root, "dist/content/animations.json"), "utf8"),
);
const skeletons: SkeletonsData = JSON.parse(
  await readFile(resolve(root, "dist/content/skeletons.json"), "utf8"),
);
const native: Point[][] = JSON.parse(
  await readFile(
    resolve(root, process.argv[2] ?? "build-out/refclient/gostek-poses.json"),
    "utf8",
  ),
);
if (native.length !== 16 || native.some((p) => p.length !== 24))
  throw Error("Expected native16×24 pose dump");
const library = new PoseLibrary(animations, skeletons),
  slots = [];
let maxWorldDistance = 0;
for (let slot = 0; slot < 16; slot++) {
  const state = GOSTEK_STATES[slot % 8]!,
    direction = facing(state),
    aim = state === "aim" ? Math.sin(1) * 1.2 : direction === 1 ? 0 : Math.PI;
  const pose = new PoseSampler(library).sample(1, state, direction, aim);
  let maxDistance = 0;
  for (let point = 1; point <= 24; point++) {
    const expected = native[slot]![point - 1]!,
      actual = pose[point]!;
    const distance = Math.hypot(
      expected.x - (((slot % 8) - 3.5) * 70 + actual.x),
      expected.y - ((Math.floor(slot / 8) - 0.5) * 100 + actual.y),
    );
    maxDistance = Math.max(maxDistance, distance);
  }
  maxWorldDistance = Math.max(maxWorldDistance, maxDistance);
  slots.push({
    slot,
    state,
    team: Math.floor(slot / 8) + 1,
    maxWorldDistance: maxDistance,
  });
}
const result = {
  time: 1,
  tick: 60,
  points: 384,
  maxWorldDistance,
  tolerance: 0.0001,
  pass: maxWorldDistance <= 0.0001,
  slots,
};
await writeFile(
  resolve(root, "tests/fixtures/render/pose-results.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
