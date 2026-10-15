import Phaser from "phaser";
import { loadGostek } from "./gostek";
import type { GostekInstance } from "./gostek";
import { TextureBank, SoldatMap } from "./soldat-map";
import {
  animatedProps,
  buildMap,
  loadSectors,
  propQuad,
  syntheticMap,
} from "./map";
import { logicalCamera, worldAt } from "./types";
import type { ImageAsset, MapData, Quad } from "./types";
import { quadGeometry } from "./geometry";
import { QuadBatch } from "./quad-batch";
import { FrameStats } from "./frame-stats";
const actorBatch = new QuadBatch(),
  sparkBatch = new QuadBatch();
const params = new URLSearchParams(location.search),
  fixture = params.get("map") ?? "Airpirates",
  stress = params.has("stress"),
  gallery = params.has("gostek");
const width = Number(params.get("width") ?? innerWidth),
  height = Number(params.get("height") ?? innerHeight);
const camera = logicalCamera(
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
const map = await json<MapData>(
  `maps/${fixture === "synthetic" ? "Aero" : fixture}.json`,
);
const renderMap =
  fixture === "synthetic"
    ? syntheticMap(map.terrain.asset!, map.edge.asset!)
    : map;
const sectors =
  fixture === "synthetic"
    ? {
        division: 100,
        radius: 25,
        cells: Array.from({ length: 2601 }, () => []),
      }
    : await loadSectors(map.name, map.polygons.length);
const gostek = await loadGostek();
let extraMap: MapData | undefined;
if (stress) extraMap = await json<MapData>("maps/inf_Biologic.json");
const propMap = extraMap ?? renderMap;
const assets: ImageAsset[] = [
  ...gostek.assets,
  ...propMap.scenery.flatMap((s) => (s.asset ? [s.asset] : [])),
];
const bank = new TextureBank();
await bank.load(assets, renderMap.terrain.asset!, renderMap.edge.asset!);
const geometry = buildMap(renderMap, sectors, bank.regions);
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
  { length: stress ? 32 : gallery ? 16 : params.has("soldiers") ? 2 : 0 },
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
let frozen = params.has("time") ? Number(params.get("time")) : NaN,
  time = 0,
  game: Phaser.Game,
  render: SoldatMap | undefined,
  frameStart = 0,
  contextLosses = 0,
  contextRestores = 0,
  created = 0,
  destroyed = 0;
const info = {
  fixture,
  mapTriangles: renderMap.polygons.length,
  props: propMap.props.filter((p) => p.active && p.level <= 2).length,
  gosteks: instances.length,
  sparks: sparks.length,
  logicalWidth: camera.width,
  logicalHeight: 480,
  physicalWidth: width,
  physicalHeight: height,
  adapter: "Phaser4.2.1 Extern + native WebGL2 static VBO",
  dither: false,
};
function metrics() {
  return {
    ...info,
    ...stats.summary(),
    drawCalls: render?.drawCalls,
    resources: render?.resources,
    contextLosses,
    contextRestores,
    created,
    destroyed,
    canvases: document.querySelectorAll("canvas").length,
    camera: { ...camera },
    renderer: game?.renderer.type,
  };
}
function makeGame() {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  if (!gl) throw Error("Native NPOT repeat fixture requires WebGL2");
  class Viewer extends Phaser.Scene {
    create() {
      created++;
      render = new SoldatMap(gl!, bank, params.get("filter") !== "nearest");
      const extern = this.add.extern();
      extern.render = (renderer, context) => {
        if (gl!.isContextLost()) return;
        // Phaser 4.2.1 exposes glWrapper at runtime and documents this Extern API,
        // but its published WebGLRenderer declaration omits the member.
        const externalRenderer = renderer as unknown as {
          glWrapper: {
            updateBindingsFramebuffer: (state: unknown, force: boolean) => void;
          };
        };
        externalRenderer.glWrapper.updateBindingsFramebuffer(
          { bindings: { framebuffer: context.framebuffer } },
          true,
        );
        const clear =
          camera.y < 0 ? renderMap.backgroundTop : renderMap.backgroundBottom;
        render!.begin(camera, width, height, clear);
        render!.draw(geometry.background, true);
        if (!gallery) {
          if (fixture !== "synthetic") render!.draw(geometry.edges[0]);
          render!.draw(geometry.polys[0]);
          drawProps(0);
        }
        // Native slots: bullets (empty fixture), soldiers, things (empty fixture),
        // sparks, scenery1, thing polys (empty), edges1, terrain1, scenery2.
        const animated = Number.isNaN(frozen) ? time : frozen;
        if (instances.length) {
          for (const instance of instances)
            if (instance.state === "aim")
              instance.aim = Math.sin(animated) * 1.2;
          const quads = gostek.quads(animated, instances);
          render!.drawDynamic(actorBatch.update(quads, bank.regions));
        }
        if (sparks.length) {
          for (let i = 0; i < sparks.length; i++)
            sparks[i]!.rotation = animated + i * 0.3;
          render!.drawDynamic(sparkBatch.update(sparks, bank.regions));
        }
        if (!gallery) {
          drawProps(1);
          if (fixture !== "synthetic") render!.draw(geometry.edges[1]);
          render!.draw(geometry.polys[1]);
          drawProps(2);
        }
      };
      const restored = () => {
        render!.restore();
        contextRestores++;
      };
      const lost = (event: Event) => {
        event.preventDefault();
        contextLosses++;
      };
      canvas.addEventListener("webglcontextlost", lost);
      canvas.addEventListener("webglcontextrestored", restored);
      this.events.once(Phaser.Scenes.Events.DESTROY, () => {
        canvas.removeEventListener("webglcontextlost", lost);
        canvas.removeEventListener("webglcontextrestored", restored);
        render!.destroy();
        destroyed++;
      });
      this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
        if (p.isDown) {
          camera.x -=
            (p.velocity.x / width) * camera.width * Math.exp(camera.z);
          camera.y -=
            (p.velocity.y / height) * camera.height * Math.exp(camera.z);
        }
      });
      this.input.on(
        "wheel",
        (_p: unknown, _o: unknown, _x: number, dy: number) => {
          camera.z += dy * 0.001;
        },
      );
    }
    update(_time: number, delta: number) {
      time += delta / 1000;
    }
  }
  const drawProps = (level: number) => {
    if (
      propMap.props.some(
        (p) =>
          p.level === level &&
          (propMap.scenery[p.style - 1]?.asset?.frames.length ?? 0) > 1,
      )
    )
      render!.drawDynamic(
        animatedProps(
          propMap,
          Number.isNaN(frozen) ? time : frozen,
          bank.regions,
          level,
        ),
      );
    else render!.draw(geometry.props[level]!);
  };
  game = new Phaser.Game({
    type: Phaser.WEBGL,
    canvas,
    context: gl as unknown as CanvasRenderingContext2D,
    parent: "game",
    width,
    height,
    backgroundColor: "#202020",
    banner: false,
    audio: { noAudio: true },
    render: { antialias: false, transparent: false, roundPixels: false },
    fps: { target: 144, smoothStep: false },
    scene: Viewer,
  });
  game.events.on(Phaser.Core.Events.PRE_STEP, () => {
    frameStart = performance.now();
  });
  game.events.on(Phaser.Core.Events.POST_RENDER, () => {
    stats.record(performance.now() - frameStart, frameStart);
    if (!params.has("capture") && stats.count % 144 === 0)
      document.querySelector("#stats")!.textContent =
        ` ${render?.drawCalls} calls · CPU p99 ${stats.summary().cpuP99.toFixed(2)}ms`;
  });
}
async function recreate() {
  await new Promise<void>((resolve) => {
    game.events.once(Phaser.Core.Events.DESTROY, () => resolve());
    game.destroy(true);
  });
  makeGame();
  await new Promise<void>((resolve) =>
    game.events.once(Phaser.Core.Events.POST_RENDER, () => resolve()),
  );
  return metrics();
}
makeGame();
Object.assign(window, {
  spike: {
    metrics,
    reset: () => stats.reset(),
    setTime: (t: number) => {
      frozen = t;
    },
    recreate,
    loseContext: () => {
      const ext = game.canvas
        .getContext("webgl2")!
        .getExtension("WEBGL_lose_context")!;
      ext.loseContext();
      setTimeout(() => ext.restoreContext(), 150);
    },
    pixel: () => {
      const gl = game.canvas.getContext("webgl2")!;
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    },
    worldAt: (x: number, y: number) => worldAt(camera, x, y, width, height),
    ready: true,
  },
});
const selector = document.querySelector<HTMLSelectElement>("#map")!;
for (const name of [
  "Airpirates",
  "Aero",
  "DesertWind",
  "Jungle",
  "inf_Biologic",
  "ctf_Death",
  "synthetic",
]) {
  const option = new Option(name, name);
  option.selected = name === fixture;
  selector.add(option);
}
selector.onchange = () => {
  params.set("map", selector.value);
  location.search = params.toString();
};
document.querySelector<HTMLButtonElement>("#pause")!.onclick = () => {
  frozen = Number.isNaN(frozen) ? time : NaN;
};
document.querySelector<HTMLButtonElement>("#recreate")!.onclick = () =>
  void recreate();
if (params.has("capture"))
  document.querySelector<HTMLElement>("#controls")!.style.display = "none";
declare global {
  interface Window {
    spike: {
      metrics: typeof metrics;
      reset: () => void;
      setTime: (t: number) => void;
      recreate: typeof recreate;
      loseContext: () => void;
      pixel: () => Uint8Array;
      worldAt: (x: number, y: number) => { x: number; y: number };
      ready: boolean;
    };
  }
}
