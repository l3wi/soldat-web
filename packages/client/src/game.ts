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
import { preparePlayback, runGateSuite, type FixturePlayback } from "./gate";
import { loadEffects, SimEffectsView, type EffectsRenderer } from "./render/effects";

let lifecycle = Promise.resolve();
let audio: Audio | undefined;
let gostekData: Promise<GostekRenderer> | undefined;
let effectsData: Promise<EffectsRenderer> | undefined;
let respawn: (() => void) | undefined;
export function respawnGame(): void { if (!respawn) throw new Error("Simulation unavailable"); respawn(); }
const LOCAL_SLOT = [1] as const;
export async function unlockGameAudio(): Promise<void> { await audio?.unlock(); }

export interface ClientDiagnostics {
  ready: boolean; map: string; simulation: string; tick: number;
  fraction: number; droppedTicks: number; renders: number; soundMapping: string;
  soundEvents: number; playedSounds: number; sparks: number;
}
declare global { interface Window { __soldatClient?: ClientDiagnostics } }

/** Serialized React mount/unmount lifecycle: Phaser destruction is asynchronous,
 * so a new game never races the previous game's canvas/audio/resource teardown. */
export function mountGame(container: HTMLElement, mapName: string, settings: Settings, onStatus: (status: string) => void): () => void {
  let cancelled = false;
  const abort = new AbortController();
  const qualification = new URLSearchParams(location.search).has("g2");
  let release!: () => void;
  const ended = new Promise<void>(resolve => { release = resolve; });
  lifecycle = lifecycle.then(async () => {
    if (cancelled) return;
    let game: Phaser.Game | undefined;
    let host: SimHost | undefined;
    let inputPtr = 0, eventPtr = 0;
    const EVENT_CAPACITY = 1_048_576;
    const diagnostics: ClientDiagnostics = { ready: false, map: mapName, simulation: "loading", tick: 0, fraction: 0, droppedTicks: 0, renders: 0, soundMapping: SOUND_MAPPING_STATUS, soundEvents: 0, playedSounds: 0, sparks: 0 };
    window.__soldatClient = diagnostics;
    try {
      const response = await fetch(`/content/maps/${encodeURIComponent(mapName)}.json`, { signal: abort.signal });
      if (!response.ok) throw new Error(`Map ${mapName}: HTTP ${response.status}`);
      const map = await response.json() as MapData;
      const [sectors, gostek, effects] = await Promise.all([loadSectors(map.name, map.polygons.length), gostekData ??= loadGostek(), effectsData ??= loadEffects()]);
      if (cancelled) return;
      const bank = new TextureBank();
      const coreAssets = [...gostek.assets, ...effects.assets];
      await bank.load([...coreAssets, ...map.scenery.flatMap(s => s.asset ? [s.asset] : [])], map.terrain.asset!, map.edge.asset!, "/content/", coreAssets);
      if (cancelled) return;
      const geometry = buildMap(map, sectors, bank.regions), scenery = new AnimatedScenery(map, bank.regions);
      const capture = new URLSearchParams(location.search).has("capture");
      let width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
      const camera = createCamera(width, height), clock = new ClientClock(), actors = new QuadBatch(), particles = new QuadBatch();
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.tabIndex = 0; canvas.setAttribute("aria-label", `${map.name} local sandbox`);
      const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: capture, powerPreference: "high-performance" });
      if (!gl) throw new Error("The map renderer requires WebGL2");
      const input = new InputSampler(canvas, settings);
      let world: SimWorldView | undefined, render: SoldatMap | undefined;
      let fx: SimEffectsView | undefined;
      let eventBytes: Uint8Array | undefined, inputBytes: Uint8Array | undefined, inputView: DataView | undefined;
      let fxAvailable = true, stopped = false;
      let playback: FixturePlayback | undefined;
      let presentationTick = 0;
      const step = () => {
        presentationTick++;
        if (!host || !world) {
          if (!capture) updateCamera(camera, camera.x, camera.y, camera.x, camera.y);
          return;
        }
        const player = world.sprites[0]!;
        if (playback && world.tick >= playback.fixture.ticks) return;
        const slots = playback ? playback.active : LOCAL_SLOT;
        for (const slot of slots) {
          const sample = playback ? playback.input(slot, world.tick + 1) : input.sample(camera, width, height, player.x, player.y);
          if (!inputView || inputView.buffer !== sample.buffer) inputView = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
          const memory = host.exports.memory.buffer;
          if (!inputBytes || inputBytes.buffer !== memory) inputBytes = new Uint8Array(memory, inputPtr, 12);
          inputBytes.set(sample);
          requireStatus(host.exports.sim_set_input(slot, world.tick, inputPtr), "sim_set_input");
        }
        if (fxAvailable) {
          const zoom = Math.exp(camera.z);
          requireStatus(host.fxSetView(camera.x, camera.y, camera.width * zoom, camera.height * zoom, 1), "fx_set_view");
        }
        requireStatus(host.step(), "sim_step");
        if (fxAvailable) {
          const status = host.exports.fx_step();
          if (status === SimStatus.UNSUPPORTED) fxAvailable = false;
          else requireStatus(status, "fx_step");
        }
        world.sync();
        if (!capture && inputView) updateCamera(camera, player.x, player.y, inputView.getInt16(2, true), inputView.getInt16(4, true));
        audio?.setListener(player.x, player.y);
        const written = requireStatus(host.exports.sim_events(eventPtr, EVENT_CAPACITY), "sim_events");
        if (written > EVENT_CAPACITY) throw new Error(`Simulation event capacity exceeded: ${written}`);
        if (!eventBytes || eventBytes.buffer !== host.exports.memory.buffer) eventBytes = new Uint8Array(host.exports.memory.buffer, eventPtr, EVENT_CAPACITY);
        audio?.drain(eventBytes, written);
        diagnostics.soundEvents = audio?.soundEvents ?? 0; diagnostics.playedSounds = audio?.playedSounds ?? 0;
        if (playback) { playback.commands(world.tick); world.sync(); playback.recordTick(world.tick); }
        diagnostics.tick = world.tick;
      };
      const visibility = () => { if (!qualification) clock.reset(); input.reset(); };
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
            // Bullet/Thing rendering belongs to Phase 3; sparks occupy the native
            // slot after soldiers/Things and before scenery level 1.
            if (world) render!.drawDynamic(actors.update(gostek.quads(clock.fraction, world), bank.regions));
            if (host && fx && fxAvailable) {
              fx.sync();
              render!.drawDynamic(particles.update(effects.quads(clock.fraction, fx), bank.regions));
              diagnostics.sparks = fx.count;
            }
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
          if (qualification) {
            window.__soldatGate = {
              respawn() {
                if (!host || !world) throw new Error("Simulation unavailable");
                requireStatus(host.command(world.tick, { kind: "spawn", slot: 1 }), "sim_command(spawn)");
                world.sync();
              },
              async run(name, hz) {
                if (![60, 120, 144].includes(hz)) throw new Error("Unsupported display rate");
                game!.loop.stop();
                if (host) { host.exports.sim_free(inputPtr); host.exports.sim_free(eventPtr); host.dispose(); }
                await audio!.prepare();
                const prepared = await preparePlayback(name);
                playback = prepared.playback; host = playback.host;
                inputPtr = requireStatus(host.exports.sim_alloc(12), "sim_alloc(input)");
                eventPtr = requireStatus(host.exports.sim_alloc(EVENT_CAPACITY), "sim_alloc(events)");
                inputBytes = undefined; eventBytes = undefined; fxAvailable = true; stopped = false;
                fx = new SimEffectsView(host);
                world = new SimWorldView(host); camera.x = world.sprites[0]!.x; camera.y = world.sprites[0]!.y;
                clock.reset(); presentationTick = 0;
                const rendersBefore = diagnostics.renders;
                let frame = 0;
                while (world.tick < playback.fixture.ticks) {
                  game!.step(frame * 1000 / hz, 1000 / hz); frame++;
                  if (stopped) throw new Error(diagnostics.simulation);
                  if (frame > playback.fixture.ticks * 3 + 10) throw new Error("Client loop did not advance");
                  // Firefox 115 lacks Promise.withResolvers; yielding avoids a
                  // long synchronous browser task without changing display time.
                  if (frame % 120 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
                }
                if (host.hash() !== playback.rows[playback.rows.length - 1]!.hash) throw new Error("Final rendering mutated gameplay state");
                gl!.finish();
                const receipt = { ...prepared.identity, browser: /Firefox/.test(navigator.userAgent) ? "firefox" : /Chrome/.test(navigator.userAgent) ? "chrome" : "safari",
                  runtime: navigator.userAgent, hz, ticks: world.tick, droppedTicks: clock.droppedTicks,
                  runId: new URLSearchParams(location.search).get("run") ?? "interactive",
                  renders: diagnostics.renders - rendersBefore, rows: playback.rows,
                  renderingMap: map.name, simulationMap: playback.fixture.map, timing: "deterministic Phaser.Game.step timestamps" };
                const response = await fetch(`/g2/result?fixture=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(receipt) });
                const result = await response.json();
                if (!response.ok) throw new Error(JSON.stringify(result));
                return result;
              },
            };
            void runGateSuite();
          }
          if (!capture && !qualification) void audio.prepare().then(() => loadSandbox(map.name, abort.signal)).then(loaded => {
            if (cancelled) { loaded.dispose(); return; }
            host = loaded;
            inputPtr = requireStatus(host.exports.sim_alloc(12), "sim_alloc(input)");
            eventPtr = requireStatus(host.exports.sim_alloc(EVENT_CAPACITY), "sim_alloc(events)");
            if (!inputPtr || !eventPtr) throw new Error("Simulation buffer allocation failed");
            world = new SimWorldView(host);
            fx = new SimEffectsView(host);
            respawn = () => {
              requireStatus(host!.command(world!.tick, { kind: "spawn", slot: 1 }), "sim_command(spawn)");
              world!.sync(); input.reset();
            };
            const player = world.sprites[0]!; camera.x = player.x; camera.y = player.y;
            clock.reset();
            const warnings = map.missing?.filter(item => item.active).map(item => `${item.kind}: ${item.requested} (fallback ${item.fallback ?? "unavailable"})`) ?? [];
            diagnostics.simulation = `movement sandbox; ${fxAvailable ? "cosmetics active" : "cosmetic simulation unavailable"}; positional SFX ready${warnings.length ? `; WARNING ${warnings.join("; ")}` : ""}`;
            onStatus(diagnostics.simulation);
          }).catch(error => {
            if (cancelled) return;
            diagnostics.simulation = `simulation unavailable: ${String(error)}`;
            onStatus(diagnostics.simulation);
          });
        }
        update(time: number) {
          if (stopped || (!qualification && document.hidden) || gl!.isContextLost()) { clock.reset(); return; }
          try {
            clock.advance(time, step);
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
    } catch (error) {
      if (!cancelled) {
        diagnostics.simulation = String(error); onStatus(String(error));
        if (qualification) {
          window.__soldatGateRun = { state: "failed", completed: 0, error: String(error) };
          await fetch("/g2/error", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime: navigator.userAgent, runId: new URLSearchParams(location.search).get("run") ?? "interactive", error: String(error) }) });
        }
      }
    }
    finally {
      if (game) await new Promise<void>(resolve => { game!.events.once(Phaser.Core.Events.DESTROY, resolve); game!.destroy(true); });
      if (host) { if (inputPtr) host.exports.sim_free(inputPtr); if (eventPtr) host.exports.sim_free(eventPtr); host.dispose(); }
      delete window.__soldatGate;
      if (window.__soldatClient === diagnostics) delete window.__soldatClient;
      respawn = undefined;
    }
  });
  return () => { cancelled = true; abort.abort(); release(); };
}
