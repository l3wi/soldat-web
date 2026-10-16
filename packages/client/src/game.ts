import Phaser from "phaser";
import { SimStatus, requireStatus, readTraceState, sha256, encodeInput, type SimHost, type SimCommand, type Control } from "@soldat-web/sim-host";
import { Audio, SOUND_MAPPING_STATUS } from "./audio";
import { createCamera, resizeCamera, updateCamera, setZoom } from "./camera";
import { ClientClock } from "./clock";
import { InputSampler } from "./input";
import { loadSandbox } from "./sandbox";
import { DEFAULT_SANDBOX, type SandboxOptions } from "./sandbox-options";
import type { Settings } from "./settings";
import { SimWorldView } from "./world";
import { loadGostek, type GostekRenderer } from "./render/gostek";
import { AnimatedScenery, buildMap, loadSectors } from "./render/map";
import { QuadBatch } from "./render/quad-batch";
import { SoldatMap, TextureBank } from "./render/soldat-map";
import type { MapData } from "./render/types";
import { preparePlayback, runGateSuite, type FixturePlayback } from "./gate";
import { loadEffects, SimEffectsView, type EffectsRenderer } from "./render/effects";
import { connectOnline, type BrowserOnline } from "./net/browser";
import { loadCombat, type CombatRenderer } from "./render/combat";
import { CombatHud, hudPresentationFromRender, type HudContent } from "./render/hud";
import { createCombatGallery, type CombatGallery } from "./render/combat-gallery";
import { CombatEvents } from "./combat-events";
import { CursorBink } from "./render/bink";

let lifecycle = Promise.resolve();
let audio: Audio | undefined;
let gostekData: Promise<GostekRenderer> | undefined;
let effectsData: Promise<EffectsRenderer> | undefined;
let combatData: Promise<CombatRenderer> | undefined;
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
interface PracticeSnapshot {
  tick: number; hash: string; bink: number; bullets: number; scores: number[];
  thingStyles: number[];
  players: { slot: number; name: string; team: number; flags: number; x: number; y: number; kills: number; deaths: number; fired: number; weapon: number; secondaryWeapon: number }[];
}
declare global { interface Window { __soldatPractice?: () => PracticeSnapshot } }
export interface CombatHook {
  command(command: SimCommand): void;
  input(slot: number, bytes: number[] | null): void;
  control(slot: number, control: Control): void;
  step(ticks: number): void;
  camera(x: number, y: number, z?: number): void;
  pause(paused: boolean): void;
  state(): unknown;
  view(): unknown;
  reset(): Promise<void>;
  render(): void;
  screenshot(): string;
  gallery(data: unknown, mode: string): void;
  identity(): unknown;
}
declare global { interface Window { __soldatCombat?: CombatHook } }

/** Serialized React mount/unmount lifecycle: Phaser destruction is asynchronous,
 * so a new game never races the previous game's canvas/audio/resource teardown. */
export function mountGame(container: HTMLElement, mapName: string, settings: Settings, onStatus: (status: string) => void, sandbox: SandboxOptions = DEFAULT_SANDBOX): () => void {
  let cancelled = false;
  const abort = new AbortController();
  const qualification = new URLSearchParams(location.search).has("g2");
  const combatCapture = new URLSearchParams(location.search).has("combat");
  let release!: () => void;
  const ended = new Promise<void>(resolve => { release = resolve; });
  lifecycle = lifecycle.then(async () => {
    if (cancelled) return;
    let game: Phaser.Game | undefined;
    let host: SimHost | undefined;
    let online: BrowserOnline | undefined;
    let hud: CombatHud | undefined;
    let inputPtr = 0, eventPtr = 0;
    const EVENT_CAPACITY = 1_048_576;
    const diagnostics: ClientDiagnostics = { ready: false, map: mapName, simulation: "loading", tick: 0, fraction: 0, droppedTicks: 0, renders: 0, soundMapping: SOUND_MAPPING_STATUS, soundEvents: 0, playedSounds: 0, sparks: 0 };
    window.__soldatClient = diagnostics;
    try {
      const response = await fetch(`/content/maps/${encodeURIComponent(mapName)}.json`, { signal: abort.signal });
      if (!response.ok) throw new Error(`Map ${mapName}: HTTP ${response.status}`);
      const map = await response.json() as MapData;
      const [sectors, gostek, effects, combat, content, weapons] = await Promise.all([
        loadSectors(map.name, map.polygons.length), gostekData ??= loadGostek(), effectsData ??= loadEffects(), combatData ??= loadCombat(),
        fetch("/content/manifest.json", { signal: abort.signal }).then(response => { if (!response.ok) throw new Error(`HUD manifest HTTP ${response.status}`); return response.json() as Promise<{ core: HudContent }>; }),
        fetch("/content/weapons.json", { signal: abort.signal }).then(response => { if (!response.ok) throw new Error(`Weapon metadata HTTP ${response.status}`); return response.json(); }),
      ]);
      if (cancelled) return;
      const bank = new TextureBank();
      const coreAssets = [...gostek.assets, ...effects.assets, ...combat.assets];
      await bank.load([...coreAssets, ...map.scenery.flatMap(s => s.asset ? [s.asset] : [])], map.terrain.asset!, map.edge.asset!, "/content/", coreAssets);
      if (cancelled) return;
      const geometry = buildMap(map, sectors, bank.regions), scenery = new AnimatedScenery(map, bank.regions);
      const capture = new URLSearchParams(location.search).has("capture");
      const serverUrl = !capture && !qualification ? new URLSearchParams(location.search).get("server") : null;
      let width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
      const camera = createCamera(width, height), clock = new ClientClock(), actors = new QuadBatch(), particles = new QuadBatch();
      const projectiles = new QuadBatch(), objects = new QuadBatch();
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.tabIndex = 0; canvas.setAttribute("aria-label", `${map.name} ${serverUrl ? "online match" : "local sandbox"}`);
      const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: capture || combatCapture, powerPreference: "high-performance" });
      if (!gl) throw new Error("The map renderer requires WebGL2");
      const input = new InputSampler(canvas, settings);
      if (!capture) hud = await CombatHud.create(container, content.core, {
        startJet: 0, weapons, pointer: !qualification && !combatCapture ? input : undefined, weaponsMenu: !qualification && !combatCapture,
        onInputCapture: () => input.reset(),
        weaponChoiceNotice: "Choose now after spawning; otherwise applies next respawn",
        onWeaponChoice(primary, secondary, selection) {
          if (serverUrl) {
            if (!online) throw new Error("Online connection unavailable");
            online.weaponChoice(primary, secondary, selection);
            return;
          }
          if (!host || !world) throw new Error("Simulation unavailable");
          requireStatus(host.command(world.tick, { kind: "weapon-choice", slot: 1, weapon: primary, secondaryWeapon: secondary }), "sim_command(weapon-choice)");
          const applied = host.command(world.tick, { kind: "weapon-apply", slot: 1, weapon: primary, secondaryWeapon: secondary, selection });
          if (applied !== SimStatus.UNSUPPORTED) requireStatus(applied, "sim_command(weapon-apply)");
          world.sync();
        },
      });
      let world: SimWorldView | undefined, render: SoldatMap | undefined;
      let fx: SimEffectsView | undefined;
      let eventBytes: Uint8Array | undefined, inputBytes: Uint8Array | undefined, inputView: DataView | undefined;
      let fxAvailable = true, stopped = false;
      let playback: FixturePlayback | undefined;
      let presentationTick = 0;
      let combatPaused = combatCapture, fixedCamera = combatCapture;
      let gallery: CombatGallery | undefined;
      const overrides = new Map<number, Uint8Array>();
      const combatSlots = [1, 2] as const;
      const neutral = new Uint8Array(12);
      const combatEvents = new CombatEvents();
      const bink = new CursorBink();
      const step = () => {
        presentationTick++;
        if (!host || !world) {
          if (!capture) updateCamera(camera, camera.x, camera.y, camera.x, camera.y);
          return;
        }
        const player = world.sprites[0]!;
        if (playback && world.tick >= playback.fixture.ticks) return;
        const slots = playback ? playback.active : combatCapture ? combatSlots : LOCAL_SLOT;
        for (const slot of slots) {
          const sample = playback ? playback.input(slot, world.tick + 1) : overrides.get(slot) ?? (slot === 1 ? input.sample(camera, width, height, player.x, player.y, hud?.gameplayCaptured) : neutral);
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
        if (!capture && !fixedCamera && inputView) updateCamera(camera, player.x, player.y, inputView.getInt16(2, true), inputView.getInt16(4, true));
        audio?.setListener(player.x, player.y);
        const written = requireStatus(host.exports.sim_events(eventPtr, EVENT_CAPACITY), "sim_events");
        if (written > EVENT_CAPACITY) throw new Error(`Simulation event capacity exceeded: ${written}`);
        if (!eventBytes || eventBytes.buffer !== host.exports.memory.buffer) eventBytes = new Uint8Array(host.exports.memory.buffer, eventPtr, EVENT_CAPACITY);
        audio?.drain(eventBytes, written);
        combatEvents.drain(eventBytes, written, world.renderView);
        bink.liveStep(world.tick, eventBytes.subarray(0, written), 1);
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
            const fraction = combatCapture ? 1 : online ? 1 : clock.fraction;
            const view = gallery?.view ?? (online ? online.session.authoritativeRenderView() : world?.renderView);
            if (!gallery) { render!.draw(geometry.edges[0]); render!.draw(geometry.polys[0]); drawProps(0); }
            combat.paused = combatPaused; combat.timeElapsed = combatCapture ? 0 : presentationTick / 60;
            if (view) render!.drawDynamic(projectiles.update(combat.bullets(fraction, view), bank.regions));
            if (world && !gallery) render!.drawDynamic(actors.update(gostek.quads(fraction, online ? online.session.present() : world), bank.regions));
            if (view) render!.drawDynamic(objects.update(combat.things(fraction, view), bank.regions));
            if (host && fx && fxAvailable && !gallery) {
              fx.sync();
              render!.drawDynamic(particles.update(effects.quads(fraction, fx), bank.regions));
              diagnostics.sparks = fx.count;
            }
            if (!gallery) drawProps(1);
            if (view) render!.drawDynamic(combat.polygons(fraction, view, bank.regions));
            if (!gallery) { render!.draw(geometry.edges[1]); render!.draw(geometry.polys[1]); drawProps(2); }
            if (view && world && gallery?.mode !== "objects") {
              const slot = online?.session.metrics.slot ?? 1;
              const presentation = hudPresentationFromRender(view, slot, gallery?.hud ?? combatEvents.presentation);
              if (!gallery) presentation.hitSprayCounter = bink.counter;
              hud?.update(gallery?.world ?? world, slot, presentation);
            } else hud?.clear();
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
            hud?.destroy(); hud = undefined;
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
          if (serverUrl) void audio.prepare().then(() => connectOnline({
            url: serverUrl, map: map.name, container, signal: abort.signal, onStatus,
            onPresentation(bytes) { audio?.drain(bytes, bytes.length); },
            onLiveStep(tick, bytes, slot) { bink.liveStep(tick, bytes, slot); },
            onEvent(event) {
              const bytes = new Uint8Array(event.header.length + event.payload.length);
              bytes.set(event.header); bytes.set(event.payload, event.header.length);
              audio?.drain(bytes, bytes.length);
              if (world) combatEvents.drain(bytes, bytes.length, world.renderView);
              diagnostics.soundEvents = audio?.soundEvents ?? 0; diagnostics.playedSounds = audio?.playedSounds ?? 0;
            },
          })).then(loaded => {
            if (cancelled) { loaded.dispose(); return; }
            online = loaded; host = loaded.prediction; world = loaded.session.predictionWorld;
            fx = new SimEffectsView(host);
            respawn = () => { throw new Error("Online respawn is server-owned"); };
            diagnostics.simulation = "online; awaiting authoritative snapshot"; onStatus(diagnostics.simulation);
          }).catch(error => {
            if (cancelled) return;
            diagnostics.simulation = `online unavailable: ${String(error)}`; onStatus(diagnostics.simulation);
          });
          else if (!capture && !qualification) void audio.prepare().then(() => loadSandbox(map.name, abort.signal, combatCapture, hud?.loadout, sandbox, settings.nickname)).then(async loaded => {
            if (cancelled) { loaded.dispose(); return; }
            host = loaded;
            inputPtr = requireStatus(host.exports.sim_alloc(12), "sim_alloc(input)");
            eventPtr = requireStatus(host.exports.sim_alloc(EVENT_CAPACITY), "sim_alloc(events)");
            if (!inputPtr || !eventPtr) throw new Error("Simulation buffer allocation failed");
            world = new SimWorldView(host);
            fx = new SimEffectsView(host);
            // Read-only qualification surface; ordinary matches keep no diagnostic copies.
            if (new URLSearchParams(location.search).has("bots-check")) window.__soldatPractice = () => {
              const hash = host!.hash(), view = world!.renderView;
              return { tick: view.tick, hash, bink: bink.counter, bullets: view.bulletCount,
                scores: Array.from(view.globals.teamScores),
                thingStyles: Array.from({ length: view.thingCount }, (_, index) => view.thing(index).style),
                players: Array.from({ length: view.slots }, (_, index) => view.sprite(index))
                  .filter(sprite => (sprite.flags & 1) !== 0)
                  .map(sprite => ({ slot: sprite.slot, name: sprite.playerName, team: sprite.team, flags: sprite.flags,
                    x: sprite.posX, y: sprite.posY, kills: sprite.kills, deaths: sprite.deaths, fired: sprite.fired, weapon: sprite.weapon, secondaryWeapon: sprite.secondaryWeapon })) };
            };
            respawn = () => {
              requireStatus(host!.command(world!.tick, { kind: "spawn", slot: 1 }), "sim_command(spawn)");
              world!.sync(); input.reset(); hud?.spawned(); canvas.focus({ preventScroll: true });
            };
            const player = world.sprites[0]!; camera.x = player.x; camera.y = player.y;
            clock.reset();
            if (combatCapture) {
              const wasmSha256 = await sha256(new Uint8Array(await (await fetch("/sim.wasm", { signal: abort.signal })).arrayBuffer()));
              const draw = () => { game!.step(performance.now(), 0); gl!.finish(); };
              window.__soldatCombat = {
                command(command) { gallery = undefined; requireStatus(host!.command(world!.tick, command), `sim_command(${command.kind})`); world!.sync(); },
                input(slot, bytes) {
                  if (bytes === null) overrides.delete(slot);
                  else { if (bytes.length !== 12) throw new Error("Combat input must have twelve bytes"); overrides.set(slot, Uint8Array.from(bytes)); }
                },
                control(slot, control) { overrides.set(slot, encodeInput(control)); },
                step(ticks) {
                  if (!Number.isInteger(ticks) || ticks < 0) throw new Error("Invalid combat tick count");
                  gallery = undefined;
                  for (let tick = 0; tick < ticks; tick++) step();
                  draw();
                },
                camera(x, y, z = 0) { fixedCamera = true; camera.x = x; camera.y = y; camera.z = z; draw(); },
                pause(value) { combatPaused = value; clock.reset(); },
                state() { return readTraceState(host!); },
                view() {
                  const view = world!.renderView;
                  return { tick: view.tick, sprites: Array.from({ length: view.slots }, (_, index) => view.sprite(index)), bullets: Array.from({ length: view.bulletCount }, (_, index) => view.bullet(index)), things: Array.from({ length: view.thingCount }, (_, index) => view.thing(index)) };
                },
                async reset() {
                  const loaded = await loadSandbox(map.name, abort.signal, true);
                  host!.exports.sim_free(inputPtr); host!.exports.sim_free(eventPtr); host!.dispose(); host = loaded;
                  inputPtr = requireStatus(host.exports.sim_alloc(12), "sim_alloc(input)");
                  eventPtr = requireStatus(host.exports.sim_alloc(EVENT_CAPACITY), "sim_alloc(events)");
                  inputBytes = undefined; eventBytes = undefined; inputView = undefined;
                  world = new SimWorldView(host); fx = new SimEffectsView(host);
                  gallery = undefined; overrides.clear(); input.reset(); clock.reset(); presentationTick = 0;
                  combatEvents.clear();
                  bink.clear();
                  diagnostics.tick = world.tick; draw();
                },
                render: draw,
                screenshot() {
                  const before = host!.hash();
                  draw();
                  if (host!.hash() !== before) throw new Error("Combat rendering mutated gameplay state");
                  const frame = document.createElement("canvas");
                  frame.width = canvas.width; frame.height = canvas.height;
                  const context = frame.getContext("2d");
                  if (!context) throw new Error("Combat framebuffer capture unavailable");
                  context.drawImage(canvas, 0, 0);
                  hud?.captureTo(context, frame.width, frame.height);
                  return frame.toDataURL("image/png");
                },
                gallery(data, mode) { gallery = createCombatGallery(data, mode); camera.x = 0; camera.y = 0; camera.z = 0; fixedCamera = true; draw(); },
                identity() { return { wasmSha256, abiVersion: host!.exports.sim_version(), map: map.name, filter: settings.filter, mipmaps: settings.mipmaps, gameWidth: camera.width, gameHeight: camera.height, jetCapacity: world!.renderView.globals.mapStartJet }; },
              };
              game!.loop.stop();
              draw();
            }
            const warnings = map.missing?.filter(item => item.active).map(item => `${item.kind}: ${item.requested} (fallback ${item.fallback ?? "unavailable"})`) ?? [];
            diagnostics.simulation = `${combatCapture ? "combat sandbox" : `${sandbox.mode.toUpperCase()} practice; ${sandbox.bots} bots`}; ${fxAvailable ? "cosmetics active" : "cosmetic simulation unavailable"}; positional SFX ready${warnings.length ? `; WARNING ${warnings.join("; ")}` : ""}`;
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
            if (online && host && world) {
              const local = world.sprites[online.session.metrics.slot - 1]!;
              online.session.advance(
                () => online!.hook.input ?? input.sample(camera, width, height, local.x, local.y, hud?.gameplayCaptured),
                () => {
                  if (fxAvailable) {
                    const zoom = Math.exp(camera.z);
                    requireStatus(host!.fxSetView(camera.x, camera.y, camera.width * zoom, camera.height * zoom, local.slot), "fx_set_view");
                  }
                },
                () => {
                  if (fxAvailable) {
                    const status = host!.exports.fx_step();
                    if (status === SimStatus.UNSUPPORTED) fxAvailable = false;
                    else requireStatus(status, "fx_step");
                  }
                  if (local.active) updateCamera(camera, local.x, local.y, local.aimX, local.aimY);
                  audio?.setListener(local.x, local.y);
                },
              );
              diagnostics.tick = world.tick;
              presentationTick = world.tick; online.updateOverlay();
            } else if (!combatPaused) clock.advance(time, step);
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
      if (online) online.dispose();
      else if (host) { if (inputPtr) host.exports.sim_free(inputPtr); if (eventPtr) host.exports.sim_free(eventPtr); host.dispose(); }
      delete window.__soldatGate;
      delete window.__soldatCombat;
      delete window.__soldatPractice;
      hud?.destroy();
      if (window.__soldatClient === diagnostics) delete window.__soldatClient;
      respawn = undefined;
    }
  });
  return () => { cancelled = true; abort.abort(); release(); };
}
