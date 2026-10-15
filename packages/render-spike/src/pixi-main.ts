import { PixiMap } from "./pixi-map";
import { TextureBank } from "./soldat-map";
import { buildMap, loadSectors, propQuad, syntheticMap } from "./map";
import { loadGostek } from "./gostek";
import type { GostekInstance } from "./gostek";
import { quadGeometry } from "./geometry";
import { logicalCamera } from "./types";
import type { ImageAsset, MapData, Quad } from "./types";
import { QuadBatch } from "./quad-batch";
import { FrameStats } from "./frame-stats";
const actorBatch = new QuadBatch(),
  sparkBatch = new QuadBatch();
const params = new URLSearchParams(location.search),
  fixture = params.get("map") ?? "Airpirates",
  stress = params.has("stress"),
  gallery = params.has("gostek");
const width = Number(params.get("width") ?? innerWidth),
  height = Number(params.get("height") ?? innerHeight),
  camera = logicalCamera(
    width,
    height,
    Number(params.get("x") ?? 0),
    Number(params.get("y") ?? 0),
    Number(params.get("z") ?? 0),
  );
const json = async <T>(path: string): Promise<T> => {
  const response = await fetch("/content/" + path);
  if (!response.ok) throw Error(`${path}: ${response.status}`);
  return response.json();
};
const source = await json<MapData>(
    `maps/${fixture === "synthetic" ? "Aero" : fixture}.json`,
  ),
  map =
    fixture === "synthetic"
      ? syntheticMap(source.terrain.asset!, source.edge.asset!)
      : source;
const sectors =
  fixture === "synthetic"
    ? {
        division: 100,
        radius: 25,
        cells: Array.from({ length: 2601 }, () => []),
      }
    : await loadSectors(map.name, map.polygons.length);
const propMap = stress ? await json<MapData>("maps/inf_Biologic.json") : map,
  gostek = await loadGostek(),
  bank = new TextureBank();
const assets: ImageAsset[] = [
  ...gostek.assets,
  ...propMap.scenery.flatMap((s) => (s.asset ? [s.asset] : [])),
];
await bank.load(assets, map.terrain.asset!, map.edge.asset!);
const geometry = buildMap(map, sectors, bank.regions);
if (stress)
  for (let level = 0; level < 3; level++)
    geometry.props[level] = quadGeometry(
      propMap.props
        .filter((p) => p.level === level)
        .map((p) => propQuad(propMap, p))
        .filter((q): q is Quad => q !== null),
      bank.regions,
    );
const states = [
  "runRight",
  "runLeft",
  "aim",
  "crouch",
  "prone",
  "jet",
  "reload",
  "dead",
];
const instances: GostekInstance[] = Array.from(
  { length: stress ? 32 : gallery ? 16 : 0 },
  (_, i) => ({
    x: camera.x + ((i % 8) - 3.5) * 70,
    y: camera.y + (Math.floor(i / 8) - 0.5) * 100,
    state: states[i % 8]!,
    team: (Math.floor(i / 8) % 2) + 1,
  }),
);
const sparks: Quad[] = Array.from({ length: stress ? 512 : 0 }, (_, i) => ({
  asset: {
    width: 1,
    height: 1,
    scale: 1,
    frames: [{ object: "white", delayMs: 0, delayTicks: 0 }],
  },
  x: camera.x + ((i % 32) - 16) * 22,
  y: camera.y + (Math.floor(i / 32) - 8) * 22,
  width: 2,
  height: 5,
  scaleX: 1,
  scaleY: 1,
  pivotX: 0.5,
  pivotY: 0.5,
  rotation: i * 0.3,
  color: [255, 180 + (i % 75), 40, 120],
}));
const stats = new FrameStats();
let render: PixiMap,
  created = 0,
  destroyed = 0,
  contextLosses = 0,
  contextRestores = 0,
  frozen = params.has("time") ? Number(params.get("time")) : NaN,
  startTime = performance.now(),
  loop = 0;
function metrics() {
  return {
    fixture,
    mapTriangles: map.polygons.length,
    props: propMap.props.filter((p) => p.active && p.level <= 2).length,
    gosteks: instances.length,
    sparks: sparks.length,
    logicalWidth: camera.width,
    logicalHeight: 480,
    physicalWidth: width,
    physicalHeight: height,
    adapter: "Pixi8.21.0 public Geometry + Shader",
    dither: false,
    ...stats.summary(),
    drawCalls: render.drawCalls,
    resources: render.resources,
    contextLosses,
    contextRestores,
    created,
    destroyed,
    canvases: document.querySelectorAll("canvas").length,
    camera: { ...camera },
    renderer: "webgl2",
  };
}
async function create() {
  const canvas = document.createElement("canvas");
  document.querySelector("#game")!.append(canvas);
  render = new PixiMap(bank, params.get("filter") !== "nearest");
  await render.init(canvas, width, height);
  created++;
  canvas.addEventListener("webglcontextlost", () => contextLosses++);
  canvas.addEventListener("webglcontextrestored", () => {
    contextRestores++;
    render.generation++;
  });
}
function frame() {
  const start = performance.now(),
    time = Number.isNaN(frozen) ? (start - startTime) / 1000 : frozen;
  render.begin(camera);
  render.draw(geometry.background, true);
  if (!gallery) {
    if (fixture !== "synthetic") render.draw(geometry.edges[0]);
    render.draw(geometry.polys[0]);
    render.draw(geometry.props[0]);
  }
  if (instances.length) {
    for (const instance of instances)
      if (instance.state === "aim") instance.aim = Math.sin(time) * 1.2;
    render.drawDynamic(
      actorBatch.update(gostek.quads(time, instances), bank.regions),
    );
  }
  if (sparks.length) {
    for (let i = 0; i < sparks.length; i++)
      sparks[i]!.rotation = time + i * 0.3;
    render.drawDynamic(sparkBatch.update(sparks, bank.regions));
  }
  if (!gallery) {
    render.draw(geometry.props[1]);
    if (fixture !== "synthetic") render.draw(geometry.edges[1]);
    render.draw(geometry.polys[1]);
    render.draw(geometry.props[2]);
  }
  render.finish();
  stats.record(performance.now() - start, start);
  loop = requestAnimationFrame(frame);
}
async function recreate() {
  cancelAnimationFrame(loop);
  const canvas = render.renderer.canvas;
  render.destroy();
  canvas.remove();
  destroyed++;
  await create();
  frame();
  return metrics();
}
await create();
frame();
Object.assign(window, {
  spike: {
    metrics,
    reset: () => stats.reset(),
    setTime: (t: number) => {
      frozen = t;
    },
    recreate,
    loseContext: () => {
      const ext = render.renderer.gl.getExtension("WEBGL_lose_context")!;
      ext.loseContext();
      setTimeout(() => ext.restoreContext(), 150);
    },
    ready: true,
  },
});
