import Phaser from "phaser";
import { SimStatus, requireStatus, type SimHost } from "@soldat-web/sim-host";
import { Audio, SOUND_MAPPING_STATUS } from "./audio";
import { createCamera, resizeCamera, updateCamera, setZoom } from "./camera";
import { ClientClock } from "./clock";
import { InputSampler } from "./input";
import { loadSandbox } from "./sandbox";
import type { Settings } from "./settings";
import { SimWorldView } from "./world";
import { loadGostek, type GostekRenderer } from "./render/gostek";
import { AnimatedScenery, buildMap, loadSectors } from "./render/map";
import { QuadBatch } from "./render/quad-batch";
import { SoldatMap, TextureBank } from "./render/soldat-map";
import type { MapData } from "./render/types";

let lifecycle = Promise.resolve();
let audio: Audio | undefined;
let gostekData: Promise<GostekRenderer> | undefined;
export async function unlockGameAudio(): Promise<void> { await audio?.unlock(); }

export interface ClientDiagnostics {
  ready: boolean; map: string; simulation: string; tick: number;
  fraction: number; droppedTicks: number; renders: number; soundMapping: string;
}
declare global { interface Window { __soldatClient?: ClientDiagnostics } }

/** Serialized React mount/unmount lifecycle: Phaser destruction is asynchronous,
 * so a new game never races the previous game's canvas/audio/resource teardown. */
export function mountGame(container: HTMLElement, mapName: string, settings: Settings, onStatus: (status: string) => void): () => void {
  let cancelled = false;
  const abort = new AbortController();
  let release!: () => void;
  const ended = new Promise<void>(resolve => { release = resolve; });
  lifecycle = lifecycle.then(async () => {
    if (cancelled) return;
    let game: Phaser.Game | undefined;
    let host: SimHost | undefined;
    let inputPtr = 0, eventPtr = 0;
    const EVENT_CAPACITY = 1_048_576;
    const diagnostics: ClientDiagnostics = { ready: false, map: mapName, simulation: "loading", tick: 0, fraction: 0, droppedTicks: 0, renders: 0, soundMapping: SOUND_MAPPING_STATUS };
    window.__soldatClient = diagnostics;
    try {
      const response = await fetch(`/content/maps/${encodeURIComponent(mapName)}.json`, { signal: abort.signal });
      if (!response.ok) throw new Error(`Map ${mapName}: HTTP ${response.status}`);
      const map = await response.json() as MapData;
      const [sectors, gostek] = await Promise.all([loadSectors(map.name, map.polygons.length), gostekData ??= loadGostek()]);
      if (cancelled) return;
      const bank = new TextureBank();
      await bank.load([...gostek.assets, ...map.scenery.flatMap(s => s.asset ? [s.asset] : [])], map.terrain.asset!, map.edge.asset!, "/content/", gostek.assets);
      if (cancelled) return;
      const geometry = buildMap(map, sectors, bank.regions), scenery = new AnimatedScenery(map, bank.regions);
      const capture = new URLSearchParams(location.search).has("capture");
      let width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
      const camera = createCamera(width, height), clock = new ClientClock(), actors = new QuadBatch();
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.tabIndex = 0; canvas.setAttribute("aria-label", `${map.name} local sandbox`);
      const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: capture, powerPreference: "high-performance" });
      if (!gl) throw new Error("The map renderer requires WebGL2");
      const input = new InputSampler(canvas, settings);
      let world: SimWorldView | undefined, render: SoldatMap | undefined;
      let eventBytes: Uint8Array | undefined, inputBytes: Uint8Array | undefined, inputView: DataView | undefined;
      let fxAvailable = true, stopped = false;
      let presentationTick = 0;
      const step = () => {
        presentationTick++;
        if (!host || !world) {
          if (!capture) updateCamera(camera, camera.x, camera.y, camera.x, camera.y);
          return;
        }
        const player = world.sprites[0]!;
        const sample = input.sample(camera, width, height, player.x, player.y);
        inputView ??= new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
        const memory = host.exports.memory.buffer;
        if (!inputBytes || inputBytes.buffer !== memory) inputBytes = new Uint8Array(memory, inputPtr, 12);
        inputBytes.set(sample);
        requireStatus(host.exports.sim_set_input(1, world.tick, inputPtr), "sim_set_input");
        requireStatus(host.step(), "sim_step");
        if (fxAvailable) {
          const status = host.exports.fx_step();
          if (status === SimStatus.UNSUPPORTED) fxAvailable = false;
          else requireStatus(status, "fx_step");
        }
        world.sync();
        if (!capture) updateCamera(camera, player.x, player.y, inputView.getInt16(2, true), inputView.getInt16(4, true));
        audio?.setListener(player.x, player.y);
        const written = requireStatus(host.exports.sim_events(eventPtr, EVENT_CAPACITY), "sim_events");
        if (written > EVENT_CAPACITY) throw new Error(`Simulation event capacity exceeded: ${written}`);
        if (!eventBytes || eventBytes.buffer !== host.exports.memory.buffer) eventBytes = new Uint8Array(host.exports.memory.buffer, eventPtr, EVENT_CAPACITY);
        audio?.drain(eventBytes, written);
        diagnostics.tick = world.tick;
      };
      const visibility = () => { clock.reset(); input.reset(); };
      const wheel = (event: WheelEvent) => { event.preventDefault(); setZoom(camera, Math.max(-2, Math.min(2, camera.z + event.deltaY * 0.001))); };
      const lost = (event: Event) => { event.preventDefault(); clock.reset(); };
      const restored = () => { render?.restore(); clock.reset(); };
      const observer = new ResizeObserver(() => {
        width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight);
        resizeCamera(camera, width, height); game?.scale.resize(width, height);
      });
      class Sandbox extends Phaser.Scene {
        create() {
          render = new SoldatMap(gl!, bank, settings.filter === "linear", capture ? false : settings.mipmaps);
          audio = new Audio(this);
          const extern = this.add.extern();
          const framebufferState = { bindings: { framebuffer: null as unknown } };
          extern.render = (renderer, context) => {
            if (gl!.isContextLost()) return;
            const external = renderer as unknown as { glWrapper: { updateBindingsFramebuffer(state: unknown, force: boolean): void } };
            framebufferState.bindings.framebuffer = context.framebuffer;
            external.glWrapper.updateBindingsFramebuffer(framebufferState, true);
            render!.begin(camera, width, height, camera.y < 0 ? map.backgroundTop : map.backgroundBottom);
            render!.draw(geometry.background, true);
            render!.draw(geometry.edges[0]); render!.draw(geometry.polys[0]);
            drawProps(0);
            // Native ordering leaves bullet/Thing/spark slots empty in movement
            // scope. No synthetic entity is substituted for missing sim features.
            if (world) render!.drawDynamic(actors.update(gostek.quads(clock.fraction, world), bank.regions));
            drawProps(1);
            render!.draw(geometry.edges[1]); render!.draw(geometry.polys[1]); drawProps(2);
            diagnostics.ready = true; diagnostics.renders++;
          };
          document.addEventListener("visibilitychange", visibility);
          canvas.addEventListener("wheel", wheel, { passive: false });
          canvas.addEventListener("webglcontextlost", lost);
          canvas.addEventListener("webglcontextrestored", restored);
          observer.observe(container);
          this.events.once(Phaser.Scenes.Events.DESTROY, () => {
            observer.disconnect(); input.destroy();
            document.removeEventListener("visibilitychange", visibility);
            canvas.removeEventListener("wheel", wheel);
            canvas.removeEventListener("webglcontextlost", lost);
            canvas.removeEventListener("webglcontextrestored", restored);
            audio?.destroy(); audio = undefined; render?.destroy();
          });
          diagnostics.simulation = capture ? "map capture (simulation disabled)" : "loading";
          onStatus(capture ? "Map capture" : "Loading local simulation…");
          if (!capture) void loadSandbox(map.name, abort.signal).then(loaded => {
            if (cancelled) { loaded.dispose(); return; }
            host = loaded;
            inputPtr = requireStatus(host.exports.sim_alloc(12), "sim_alloc(input)");
            eventPtr = requireStatus(host.exports.sim_alloc(EVENT_CAPACITY), "sim_alloc(events)");
            if (!inputPtr || !eventPtr) throw new Error("Simulation buffer allocation failed");
            world = new SimWorldView(host);
            const player = world.sprites[0]!; camera.x = player.x; camera.y = player.y;
            clock.reset();
            diagnostics.simulation = "movement sandbox; cosmetic simulation unavailable; sound events unmapped";
            onStatus(diagnostics.simulation);
          }).catch(error => {
            if (cancelled) return;
            diagnostics.simulation = `simulation unavailable: ${String(error)}`;
            onStatus(diagnostics.simulation);
          });
        }
        update() {
          if (stopped || document.hidden || gl!.isContextLost()) { clock.reset(); return; }
          try {
            clock.advance(performance.now(), step);
            diagnostics.fraction = clock.fraction; diagnostics.droppedTicks = clock.droppedTicks;
            scenery.update(capture ? 0 : (presentationTick + clock.fraction) / 60);
          } catch (error) { stopped = true; diagnostics.simulation = `Simulation stopped: ${String(error)}`; onStatus(diagnostics.simulation); }
        }
      }
      const drawProps = (level: number) => {
        if (scenery.levels[level]) render!.drawDynamic(scenery.geometry(level));
        else render!.draw(geometry.props[level]!);
      };
      game = new Phaser.Game({
        type: Phaser.WEBGL, canvas, context: gl as unknown as CanvasRenderingContext2D,
        parent: container, width, height, banner: false, backgroundColor: "#202020",
        audio: { disableWebAudio: false }, render: { antialias: false, transparent: false, roundPixels: false },
        fps: { target: 144, smoothStep: false }, scene: Sandbox,
      });
      await ended;
    } catch (error) { if (!cancelled) { diagnostics.simulation = String(error); onStatus(String(error)); } }
    finally {
      if (game) await new Promise<void>(resolve => { game!.events.once(Phaser.Core.Events.DESTROY, resolve); game!.destroy(true); });
      if (host) { if (inputPtr) host.exports.sim_free(inputPtr); if (eventPtr) host.exports.sim_free(eventPtr); host.dispose(); }
    }
  });
  return () => { cancelled = true; abort.abort(); release(); };
}
