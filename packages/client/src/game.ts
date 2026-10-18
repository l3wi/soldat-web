import Phaser from "phaser";
import { SimStatus, SPRITE_FLAGS, requireStatus, readTraceState, encodeInput, type SimHost, type SimCommand, type Control } from "@soldat-web/sim-host";
import { validateAppearance, validateTeam, type PlayerAppearance, type FeatureClientMessage, type FeatureServerMessage } from "@soldat-web/protocol";
import { Audio, SOUND_MAPPING_STATUS } from "./audio";
import { createCamera, resizeCamera, updateCamera, updateSpectatorCamera, setZoom } from "./camera";
import { ClientClock } from "./clock";
import { InputSampler } from "./input";
import { loadSandbox } from "./sandbox";
import { ATTRACT_SANDBOX, DEFAULT_SANDBOX, compatibleSandboxMaps, type SandboxOptions } from "./sandbox-options";
import type { Settings } from "./settings";
import { SimWorldView } from "./world";
import { loadGostek, type GostekRenderer } from "./render/gostek";
import { AnimatedScenery, buildMap, loadSectors } from "./render/map";
import { QuadBatch } from "./render/quad-batch";
import { SoldatMap, TextureBank } from "./render/soldat-map";
import { preparePlayback, runGateSuite, type FixturePlayback } from "./gate";
import { loadEffects, SimEffectsView, type EffectsRenderer } from "./render/effects";
import { connectOnline, type BrowserOnline } from "./net/browser";
import { loadCombat, type CombatRenderer } from "./render/combat";
import { CombatHud, hudPresentationFromRender, type HudOptions, type HudPresentation } from "./render/hud";
import { createCombatGallery, type CombatGallery } from "./render/combat-gallery";
import { CombatEvents } from "./combat-events";
import { CursorBink } from "./render/bink";
import { loadContentIndex, loadRenderMap } from "./content";
import { sessionJson } from "./session-cache";
import { loadSimulationCode } from "./sim-runtime";
import { roundMapDisposition } from "./round-map";
import { SpectatorController } from "./spectator";
import { VoiceClient } from "./voice";

let lifecycle = Promise.resolve();
let audio: Audio | undefined;
let audioContext: AudioContext | undefined;
let audioUnlockRequested = false;
let masterVolume = 1;
let pauseGame: ((paused: boolean) => void) | undefined;
let weaponsGame: (() => void) | undefined;
let teamsGame: (() => void) | undefined;
let teamGame: ((team: number) => void) | undefined;
let appearanceGame: ((appearance: PlayerAppearance) => void) | undefined;
let settingsGame: ((settings: Settings) => void) | undefined;
let voiceVolumeGame: ((volume: number) => void) | undefined;
let gostekData: Promise<GostekRenderer> | undefined;
let effectsData: Promise<EffectsRenderer> | undefined;
let combatData: Promise<CombatRenderer> | undefined;
let respawn: (() => void) | undefined;
export function respawnGame(): void { if (!respawn) throw new Error("Simulation unavailable"); respawn(); }
const LOCAL_SLOT = [1] as const;
const NO_SLOTS: readonly number[] = [];
/** Create/resume during the gesture, even while the match's assets are loading. */
export async function unlockGameAudio(): Promise<void> {
  audioUnlockRequested = true;
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
  await audio?.unlock();
}
export function setGamePaused(paused: boolean): void { pauseGame?.(paused); }
export function openGameWeapons(): void { weaponsGame?.(); }
export function openGameTeams(): void { teamsGame?.(); }
export function changeTeam(team: number): void {
  if (!teamGame) throw new Error("Simulation unavailable");
  teamGame(team);
}
export function updateAppearance(appearance: PlayerAppearance): void {
  validateAppearance(appearance);
  appearanceGame?.(appearance);
}
export function updateGameSettings(settings: Settings): void {
  setGameVolume(settings.volume);
  settingsGame?.(settings);
}
/** Normalized shell master gain, independent of native per-source volume. */
export function setGameVolume(volume: number): void {
  masterVolume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
  audio?.setVolume(masterVolume);
  voiceVolumeGame?.(masterVolume);
}

export interface GameMountOptions {
  attract?: boolean;
  paused?: boolean;
  serverUrl?: string;
  onRoundChange?: (map: string) => void;
  onSettingsChange?: (settings: Settings) => void;
  onShellCommand?: (command: string, args: readonly string[]) => void | Promise<void>;
}

export interface ClientDiagnostics {
  ready: boolean; map: string; simulation: string; tick: number;
  fraction: number; droppedTicks: number; renders: number; soundMapping: string;
  soundEvents: number; playedSounds: number; sparks: number;
}
declare global { interface Window { __soldatClient?: ClientDiagnostics } }
declare global { interface Window { __soldatCapture?: { respawn(): void } } }
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
export function mountGame(container: HTMLElement, mapName: string, settings: Settings, onStatus: (status: string) => void, sandbox: SandboxOptions = DEFAULT_SANDBOX, options: GameMountOptions = {}): () => void {
  let cancelled = false;
  let voice: VoiceClient | undefined;
  let serverPaused = false;
  let initialVoiceState: Extract<FeatureServerMessage, { type: "voice-state" }> | undefined;
  const abort = new AbortController();
  const attract = options.attract === true;
  if (attract) sandbox = ATTRACT_SANDBOX;
  let paused = options.paused === true;
  let applyPause: (() => void) | undefined;
  const setPaused = (value: boolean) => { paused = value; applyPause?.(); };
  pauseGame = setPaused;
  weaponsGame = teamsGame = undefined;
  teamGame = undefined;
  appearanceGame = appearance => { settings = { ...settings, appearance }; };
  settingsGame = next => { settings = next; };
  const qualification = !attract && new URLSearchParams(location.search).has("g2");
  const combatCapture = !attract && new URLSearchParams(location.search).has("combat");
  let release!: () => void;
  const ended = new Promise<void>(resolve => { release = resolve; });
  lifecycle = lifecycle.then(async () => {
    if (cancelled) return;
    let game: Phaser.Game | undefined;
    let host: SimHost | undefined;
    let online: BrowserOnline | undefined;
    let hud: CombatHud | undefined;
    let input: InputSampler | undefined;
    let inputPtr = 0, eventPtr = 0;
    let screenshotRequest: { resolve(): void; reject(error: Error): void } | undefined;
    const EVENT_CAPACITY = 1_048_576;
    const diagnostics: ClientDiagnostics = { ready: false, map: mapName, simulation: "loading", tick: 0, fraction: 0, droppedTicks: 0, renders: 0, soundMapping: SOUND_MAPPING_STATUS, soundEvents: 0, playedSounds: 0, sparks: 0 };
    window.__soldatClient = diagnostics;
    try {
      let map = await loadRenderMap(mapName, abort.signal);
      const [sectors, gostek, effects, combat, content, weapons] = await Promise.all([
        loadSectors(map.name, map.polygons.length), gostekData ??= loadGostek(), effectsData ??= loadEffects(), combatData ??= loadCombat(),
        loadContentIndex(abort.signal),
        sessionJson<HudOptions["weapons"]>("/content/weapons.json", abort.signal),
      ]);
      if (cancelled) return;
      let bank = new TextureBank();
      const coreAssets = [...gostek.assets, ...effects.assets, ...combat.assets];
      await bank.load([...coreAssets, ...map.scenery.flatMap(s => s.asset ? [s.asset] : [])], map.terrain.asset!, map.edge.asset!, "/content/");
      if (cancelled) return;
      let geometry = buildMap(map, sectors, bank.regions), scenery = new AnimatedScenery(map, bank.regions);
      const capture = !attract && new URLSearchParams(location.search).has("capture");
      const serverUrl = !attract && !capture && !qualification ? options.serverUrl ?? new URLSearchParams(location.search).get("server") : null;
      let width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
      const camera = createCamera(width, height), clock = new ClientClock(), actors = new QuadBatch(), particles = new QuadBatch();
      const projectiles = new QuadBatch(), objects = new QuadBatch();
      let roundLoading = false;
      let roundMapGeneration = 0, roundPresentationEpoch = -1;
      let pendingMap: { map: typeof map; bank: TextureBank; geometry: typeof geometry; scenery: AnimatedScenery } | undefined;
      let scaledTime = 0, frameTime = Number.NaN;
      let graphicsChanged = false, appearancePending = false;
      let desiredAppearance = settings.appearance;
      const prepareRoundMap = async (name: string): Promise<number | undefined> => {
        const generation = ++roundMapGeneration;
        const action = roundMapDisposition(map.name, pendingMap?.map.name, name);
        if (action === "discard") { pendingMap = undefined; return generation; }
        if (action === "retain") return generation;
        const nextMap = await loadRenderMap(name, abort.signal);
        if (cancelled || generation !== roundMapGeneration) return;
        const nextSectors = await loadSectors(nextMap.name, nextMap.polygons.length);
        if (cancelled || generation !== roundMapGeneration) return;
        const nextBank = new TextureBank();
        await nextBank.load([...coreAssets, ...nextMap.scenery.flatMap(item => item.asset ? [item.asset] : [])], nextMap.terrain.asset!, nextMap.edge.asset!, "/content/");
        if (cancelled || generation !== roundMapGeneration) return;
        pendingMap = { map: nextMap, bank: nextBank, geometry: buildMap(nextMap, nextSectors, nextBank.regions),
          scenery: new AnimatedScenery(nextMap, nextBank.regions) };
        return generation;
      };
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.tabIndex = attract ? -1 : 0;
      canvas.setAttribute("aria-label", `${map.name} ${attract ? "bot match backdrop" : serverUrl ? "online match" : "local sandbox"}`);
      if (attract) { canvas.setAttribute("aria-hidden", "true"); canvas.style.pointerEvents = "none"; }
      const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: capture || combatCapture, powerPreference: "high-performance" });
      if (!gl) throw new Error("The map renderer requires WebGL2");
      input = attract ? undefined : new InputSampler(canvas, settings);
      input?.setSuspended(paused);
      const spectator = new SpectatorController();
      let presentationPlayers: HudPresentation["players"];
      const playerName = (slot: number) => {
        if (presentationPlayers) for (let i = 0; i < presentationPlayers.length; i++) {
          if (presentationPlayers[i]!.slot === slot) return presentationPlayers[i]!.name ?? "";
        }
        return "";
      };
      const observerSlot = () => {
        const slot = online?.session.metrics.slot ?? 1;
        return spectator.observing && world?.sprites[slot - 1]?.team !== 5 && spectator.targetSlot > 0 ? spectator.targetSlot : slot;
      };
      const requestScreenshot = () => new Promise<void>((resolve, reject) => {
        if (cancelled || document.hidden) { reject(new Error("The game must be visible to take a screenshot")); return; }
        if (!diagnostics.ready || roundLoading) { reject(new Error("Simulation unavailable")); return; }
        if (screenshotRequest) { reject(new Error("A screenshot is already pending")); return; }
        screenshotRequest = { resolve, reject };
      });
      let weaponPreparation = 0;
      const syncVoiceMutes = () => {
        if (!voice || !hud || !initialVoiceState) return;
        for (const peer of initialVoiceState.state.peers) voice.setPeerMuted(peer.id, hud.isPlayerMuted(peer.slot, peer.nickname));
      };
      if (!attract && !capture) hud = await CombatHud.create(container, content.core, {
        startJet: 0, weapons, pointer: !qualification && !combatCapture ? input : undefined, weaponsMenu: !qualification && !combatCapture,
        onInputCapture: captured => { input?.reset(); if (captured) voice?.suspend(); },
        camera, sniperLine: settings.sniperLine, playerNames: settings.playerNames,
        maps: compatibleSandboxMaps(content, sandbox.mode, !!serverUrl || sandbox.bots > 0),
        observerSlot,
        onTeamChange: team => changeTeam(team),
        onLocalMuteChange: syncVoiceMutes,
        settings,
        onSettingsChange(next) {
          if (options.onSettingsChange) options.onSettingsChange(next);
          else updateGameSettings(next);
        },
        onChat(channel, text) {
          if (serverUrl) {
            if (!online) throw new Error("Online connection unavailable");
            online.session.sendChat(channel, text);
          } else {
            if (!world) throw new Error("Simulation unavailable");
            hud?.receiveChat({ type: "chat-message", channel, slot: 1, nickname: playerName(1) || settings.nickname, text });
          }
        },
        onFeature(message) {
          if (serverUrl) {
            if (!online) throw new Error("Online connection unavailable");
            online.session.sendFeature(message);
            return;
          }
          if (!host || !world || roundLoading) throw new Error("Simulation unavailable");
          if (message.type === "gesture" || message.type === "self-kill") {
            const command: SimCommand = message.type === "gesture"
              ? { kind: "gesture", slot: 1, gesture: message.gesture }
              : { kind: "kill", slot: 1 };
            const status = host.command(world.tick, command);
            if (status === SimStatus.UNSUPPORTED) throw new Error("Action unavailable in the player's current state");
            requireStatus(status, `sim_command(${command.kind})`);
            world.sync();
            return;
          }
          if (message.type === "radio") {
            if (world.sprites[0]!.team === 5) throw new Error("Spectators cannot send radio messages");
            hud?.receiveFeature({ type: "radio-message", slot: 1, nickname: playerName(1) || settings.nickname, category: message.category, direction: message.direction });
            if (!hud?.isPlayerMuted(1, playerName(1) || settings.nickname)) audio?.radio(message.category, message.direction);
            return;
          }
          throw new Error("This command requires an online match");
        },
        onVoiceTransmit(active) {
          if (!voice) {
            if (active) hud?.setVoiceStatus("Voice requires an online connection");
            return;
          }
          if (active) void voice.resumePlayback();
          voice.setTransmit(active);
        },
        async onConsoleCommand(command, args) {
          if (command === "screenshot") { await requestScreenshot(); hud?.consoleNotice("Screenshot downloaded"); return; }
          if (command === "weapons") {
            if (args.length) throw new Error("Usage: weapons");
            openGameWeapons(); return;
          }
          if (command === "team") {
            if (args.length !== 1) throw new Error("Usage: team solo|alpha|bravo|charlie|delta|spectator");
            const name = args[0]!.toLowerCase();
            const team = /^\d+$/.test(name) ? Number(name) : ["solo", "alpha", "bravo", "charlie", "delta", "spectator"].indexOf(name);
            if (!Number.isInteger(team) || team < 0 || team > 5) throw new Error("Invalid team");
            changeTeam(team); return;
          }
          if (command === "switchcam" || command === "switchcamflag") {
            if (!world || world.sprites[(online?.session.metrics.slot ?? 1) - 1]!.team !== 5) throw new Error("You are not a spectator");
            if (args.length !== 1 || !/^\d+$/.test(args[0]!)) throw new Error(`Usage: ${command} "id"`);
            refreshSpectator(online?.session.metrics.slot ?? 1);
            if (command === "switchcam") spectator.follow(Number(args[0]));
            else spectator.flag(Number(args[0]), online?.session.authoritativeRenderView() ?? world.renderView, camera);
            input?.reset();
            return;
          }
          if (!options.onShellCommand) throw new Error(`${command} is unavailable on this surface`);
          await options.onShellCommand(command, args);
        },
        weaponChoiceNotice: "Choose now after spawning; otherwise applies next respawn",
        onWeaponChoice(primary, secondary, selection) {
          const choice = ++weaponPreparation;
          void (async () => {
            await audio?.prepare({ loadout: { weapon: primary, secondaryWeapon: secondary } });
            if (cancelled || choice !== weaponPreparation) return;
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
          })().catch(error => { if (!cancelled && choice === weaponPreparation) onStatus(`Weapon choice unavailable: ${String(error)}`); });
        },
      });
      if (cancelled) return;
      hud?.setSuspended(paused);
      const openWeapons = () => hud?.openWeapons();
      if (!attract) weaponsGame = openWeapons;
      if (!attract) {
        input?.updateSettings(settings); hud?.updateSettings(settings);
        teamsGame = () => hud?.openTeams();
        teamGame = team => {
          if (serverUrl) {
            if (!online) throw new Error("Online connection unavailable");
            online.changeTeam(team);
          } else {
            if (!host || !world || roundLoading) throw new Error("Simulation unavailable");
            validateTeam(team, sandbox.mode);
            const status = host.command(world.tick, { kind: "team", slot: 1, team });
            if (status === SimStatus.UNSUPPORTED && sandbox.balanceTeams) {
              hud?.consoleNotice("Team is full; choose a smaller team or spectate");
              return;
            }
            requireStatus(status, "sim_command(team)");
            world.sync();
            refreshSpectator(1);
          }
        };
        appearanceGame = appearance => {
          validateAppearance(appearance);
          desiredAppearance = appearance;
          appearancePending = true;
          if (serverUrl) {
            if (!online || online.session.metrics.status !== "online") return;
            online.updateAppearance(appearance);
          } else {
            if (!host || !world) return;
            requireStatus(host.command(world.tick, { kind: "appearance", slot: 1, appearance }), "sim_command(appearance)");
            world.sync();
          }
          appearancePending = false;
        };
        settingsGame = next => {
          const appearanceChanged = JSON.stringify(settings.appearance) !== JSON.stringify(next.appearance);
          graphicsChanged ||= settings.filter !== next.filter || settings.mipmaps !== next.mipmaps;
          settings = next;
          input?.updateSettings(next); hud?.updateSettings(next);
          voice?.setSettings(next.voice, masterVolume);
          if (appearanceChanged) updateAppearance(next.appearance);
        };
        voiceVolumeGame = volume => voice?.setSettings(settings.voice, volume);
      }
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
      let presentationTeam: number | undefined;
      const refreshSpectator = (slot: number) => {
        if (!world) return;
        const team = world.sprites[slot - 1]?.team;
        if (presentationTeam !== undefined && presentationTeam !== team) {
          weaponPreparation++; input?.reset(); overrides.clear(); hud?.roundChanged(); bink.clear();
        }
        presentationTeam = team;
        const globals = world.renderView.globals;
        spectator.update(world.sprites, slot, globals.realistic, globals.roundEpoch);
      };
      const observeCamera = () => {
        if (input && !paused && !roundLoading && !hud?.gameplayCaptured) {
          updateSpectatorCamera(camera, spectator.target, input.pointerX, input.pointerY, width, height, spectator.free);
        }
      };
      const resetRoundPresentation = (name: string) => {
        spectator.reset();
        presentationTeam = undefined;
        weaponPreparation++; input?.reset(); overrides.clear(); combatEvents.clear(); bink.clear();
        inputBytes = eventBytes = undefined; inputView = undefined;
        world?.sync();
        if (world) {
          const player = world.sprites[(online?.session.metrics.slot ?? 1) - 1]!;
          camera.x = player.x; camera.y = player.y;
        }
        fx = host ? new SimEffectsView(host) : undefined;
        fxAvailable = true; hud?.roundChanged(); clock.reset(); frameTime = Number.NaN;
        diagnostics.map = name; canvas.setAttribute("aria-label", `${name} ${serverUrl ? "online match" : "local sandbox"}`);
        options.onRoundChange?.(name);
      };
      const continueOfflineRound = async () => {
        if (!host || !world || roundLoading) return;
        roundLoading = true; input?.reset();
        try {
          const compatible = compatibleSandboxMaps(content, sandbox.mode, sandbox.bots > 0);
          const rotation = sandbox.mapRotation.filter(name => compatible.includes(name));
          const nextMap = rotation.length ? rotation[(rotation.indexOf(map.name) + 1) % rotation.length]! : map.name;
          await prepareRoundMap(nextMap);
          if (cancelled) return;
          requireStatus(host.loadMap(nextMap), "sim_load_map(next round)");
          resetRoundPresentation(nextMap);
          if (attract) { followed = -1; switchAt = 0; }
        } catch (error) {
          if (!cancelled) { stopped = true; diagnostics.simulation = `Next round unavailable: ${String(error)}`; onStatus(diagnostics.simulation); }
        } finally { roundLoading = false; }
      };
      let followed = -1, switchAt = 0;
      const followBot = (snap = false) => {
        if (!world) return;
        const current = world.sprites[followed];
        if (!current?.active || (current.flags & SPRITE_FLAGS.dead) !== 0 || world.tick >= switchAt) {
          // Cycle living native bots without allocating a per-tick candidate list.
          for (let offset = 1; offset <= world.sprites.length; offset++) {
            const index = (Math.max(-1, followed) + offset) % world.sprites.length;
            const bot = world.sprites[index]!;
            if (!bot.active || (bot.flags & SPRITE_FLAGS.bot) === 0 || (bot.flags & SPRITE_FLAGS.dead) !== 0) continue;
            followed = index;
            switchAt = world.tick + 8 * 60;
            break;
          }
        }
        const bot = world.sprites[followed];
        if (!bot?.active || (bot.flags & SPRITE_FLAGS.dead) !== 0) return;
        if (snap) { camera.x = bot.x; camera.y = bot.y; }
        else updateCamera(camera, bot.x, bot.y, camera.x, camera.y);
      };
      applyPause = () => {
        clock.reset();
        input?.setSuspended(paused);
        if (serverPaused) input?.setSuspended(true);
        if (paused) voice?.suspend();
        hud?.setSuspended(paused);
      };
      const step = () => {
        if (roundLoading) return;
        presentationTick++;
        if (!host || !world) {
          if (!capture) updateCamera(camera, camera.x, camera.y, camera.x, camera.y);
          return;
        }
        const player = world.sprites[0]!;
        if (!attract && !qualification && !combatCapture) {
          refreshSpectator(1);
          input?.updateSpectator(spectator, paused || hud?.gameplayCaptured === true);
        }
        if (playback && world.tick >= playback.fixture.ticks) return;
        const slots = playback ? playback.active : combatCapture ? combatSlots : attract ? NO_SLOTS : LOCAL_SLOT;
        for (const slot of slots) {
          const sample = playback ? playback.input(slot, world.tick + 1) : overrides.get(slot) ??
            (slot === 1 && player.team !== 5 ? input!.sample(camera, width, height, player.x, player.y, paused || hud?.gameplayCaptured) : neutral);
          if (!inputView || inputView.buffer !== sample.buffer) inputView = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
          const memory = host.exports.memory.buffer;
          if (!inputBytes || inputBytes.buffer !== memory) inputBytes = new Uint8Array(memory, inputPtr, 12);
          inputBytes.set(sample);
          requireStatus(host.exports.sim_set_input(slot, world.tick, inputPtr), "sim_set_input");
        }
        if (fxAvailable) {
          const zoom = Math.exp(camera.z);
          requireStatus(host.fxSetView(camera.x, camera.y, camera.width * zoom, camera.height * zoom, attract ? Math.max(1, followed + 1) : 1), "fx_set_view");
        }
        requireStatus(host.step(), "sim_step");
        if (fxAvailable) {
          const status = host.exports.fx_step();
          if (status === SimStatus.UNSUPPORTED) fxAvailable = false;
          else requireStatus(status, "fx_step");
        }
        world.sync();
        if (attract) followBot();
        else if (!capture && !fixedCamera && inputView) {
          if (!qualification && !combatCapture) refreshSpectator(1);
          if (spectator.observing) observeCamera();
          else updateCamera(camera, player.x, player.y, inputView.getInt16(2, true), inputView.getInt16(4, true), settings.scope ? player.aimDistCoef : 7);
        }
        audio?.setListener(spectator.observing ? camera.x : player.x, spectator.observing ? camera.y : player.y);
        const written = requireStatus(host.exports.sim_events(eventPtr, EVENT_CAPACITY), "sim_events");
        if (written > EVENT_CAPACITY) throw new Error(`Simulation event capacity exceeded: ${written}`);
        if (!eventBytes || eventBytes.buffer !== host.exports.memory.buffer) eventBytes = new Uint8Array(host.exports.memory.buffer, eventPtr, EVENT_CAPACITY);
        audio?.drain(eventBytes, written);
        if (!attract) {
          combatEvents.drain(eventBytes, written, world.renderView);
          bink.liveStep(world.tick, eventBytes.subarray(0, written), 1);
        }
        diagnostics.soundEvents = audio?.soundEvents ?? 0; diagnostics.playedSounds = audio?.playedSounds ?? 0;
        if (playback) { playback.commands(world.tick); world.sync(); playback.recordTick(world.tick); }
        diagnostics.tick = world.tick;
        if (!playback && !combatCapture && !qualification && world.renderView.globals.roundPhase === 2) void continueOfflineRound();
      };
      const visibility = () => { if (!qualification) clock.reset(); input?.reset(); };
      const wheel = (event: WheelEvent) => { if (paused) return; event.preventDefault(); setZoom(camera, Math.max(-2, Math.min(2, camera.z + event.deltaY * 0.001))); };
      const lost = (event: Event) => { event.preventDefault(); clock.reset(); };
      const restored = () => { render?.restore(); clock.reset(); };
      const observer = new ResizeObserver(() => {
        width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight);
        resizeCamera(camera, width, height); game?.scale.resize(width, height);
      });
      class Sandbox extends Phaser.Scene {
        create() {
          render = new SoldatMap(gl!, bank, settings.filter === "linear", capture ? false : settings.mipmaps);
          if (!attract) {
            audio = new Audio(this, error => { if (!cancelled) onStatus(`Audio unavailable: ${error.message}`); });
            audio.setVolume(masterVolume);
            if (audioUnlockRequested) void audio.unlock().catch(error => { if (!cancelled) onStatus(`Audio unavailable: ${String(error)}`); });
          }
          const extern = this.add.extern();
          const framebufferState = { bindings: { framebuffer: null as unknown } };
          extern.render = (renderer, context) => {
            if (gl!.isContextLost()) return;
            if (roundLoading) { hud?.clear(); return; }
            const external = renderer as unknown as { glWrapper: { updateBindingsFramebuffer(state: unknown, force: boolean): void } };
            if (pendingMap || graphicsChanged) {
              render?.destroy();
              if (pendingMap) {
                ({ map, bank, geometry, scenery } = pendingMap);
                pendingMap = undefined;
              }
              render = new SoldatMap(gl!, bank, settings.filter === "linear", capture ? false : settings.mipmaps);
              graphicsChanged = false;
            }
            framebufferState.bindings.framebuffer = context.framebuffer;
            external.glWrapper.updateBindingsFramebuffer(framebufferState, true);
            render!.begin(camera, width, height, camera.y < 0 ? map.backgroundTop : map.backgroundBottom);
            render!.draw(geometry.background, true);
            const fraction = combatCapture || (attract && paused) ? 1 : online ? 1 : clock.fraction;
            const view = gallery?.view ?? (online ? online.session.authoritativeRenderView() : world?.renderView);
            if (!gallery) { render!.draw(geometry.edges[0]); render!.draw(geometry.polys[0]); drawProps(0); }
            combat.paused = combatPaused; combat.timeElapsed = combatCapture ? 0 : presentationTick / 60;
            if (view) render!.drawDynamic(projectiles.update(combat.bullets(fraction, view), bank.regions));
            if (world && !gallery) render!.drawDynamic(actors.update(gostek.quads(fraction, online ? online.session.present() : world,
              attract ? 0 : observerSlot(), view?.globals.realistic === true && world.sprites[(online?.session.metrics.slot ?? 1) - 1]?.team !== 5), bank.regions));
            if (view) render!.drawDynamic(objects.update(combat.things(fraction, view), bank.regions));
            if (host && fx && fxAvailable && !gallery) {
              fx.sync();
              render!.drawDynamic(particles.update(effects.quads(fraction, fx), bank.regions));
              diagnostics.sparks = fx.count;
            }
            if (!gallery) drawProps(1);
            if (view) render!.drawDynamic(combat.polygons(fraction, view, bank.regions));
            if (!gallery) { render!.draw(geometry.edges[1]); render!.draw(geometry.polys[1]); drawProps(2); }
            if (hud && view && world && gallery?.mode !== "objects") {
              const slot = online?.session.metrics.slot ?? 1;
              const presentation = hudPresentationFromRender(view, slot, gallery?.hud ?? combatEvents.presentation);
              if (!gallery) presentation.hitSprayCounter = bink.counter;
              presentationPlayers = presentation.players;
              hud.setSpectator(spectator.targetSlot, playerName(spectator.targetSlot), spectator.observing);
              hud?.update(gallery?.world ?? (online ? online.session.world : world), slot, presentation);
              if (screenshotRequest) {
                const request = screenshotRequest; screenshotRequest = undefined;
                try {
                  const frame = document.createElement("canvas");
                  frame.width = canvas.width; frame.height = canvas.height;
                  const context = frame.getContext("2d");
                  if (!context) throw new Error("Screenshot capture unavailable");
                  context.drawImage(canvas, 0, 0);
                  hud.captureTo(context, frame.width, frame.height);
                  frame.toBlob(blob => {
                    if (!blob) { request.reject(new Error("Screenshot encoding failed")); return; }
                    const url = URL.createObjectURL(blob), link = document.createElement("a");
                    link.href = url; link.download = `${map.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${diagnostics.tick}.png`;
                    link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); request.resolve();
                  }, "image/png");
                } catch (error) { request.reject(error instanceof Error ? error : new Error(String(error))); }
              }
            } else hud?.clear();
            diagnostics.ready = true; diagnostics.renders++;
          };
          document.addEventListener("visibilitychange", visibility);
          if (!attract) canvas.addEventListener("wheel", wheel, { passive: false });
          canvas.addEventListener("webglcontextlost", lost);
          canvas.addEventListener("webglcontextrestored", restored);
          observer.observe(container);
          this.events.once(Phaser.Scenes.Events.DESTROY, () => {
            observer.disconnect(); input?.destroy();
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
          if (serverUrl) void audio!.prepare().then(() => connectOnline({
            url: serverUrl, map: map.name, container, signal: abort.signal, onStatus, nickname: settings.nickname, appearance: settings.appearance,
            onChat: message => hud?.receiveChat(message),
            onNotice: text => hud?.consoleNotice(text),
            onFeature(message) {
              hud?.receiveFeature(message);
              if (message.type === "control-state") {
                serverPaused = message.state.paused;
                input?.setSuspended(paused || serverPaused);
                if (serverPaused) voice?.suspend();
              }
              if (message.type === "radio-message" && !hud?.isPlayerMuted(message.slot, message.nickname)) audio?.radio(message.category, message.direction);
              if (message.type === "voice-state") initialVoiceState = message;
              voice?.receive(message);
              if (message.type === "voice-state") syncVoiceMutes();
            },
            onClosed: () => voice?.dispose(),
            onSlotLeave: slot => spectator.invalidate(slot),
            onStateReset: () => { spectator.reset(); input?.reset(); voice?.suspend(); },
            async onRound(round) {
              const epoch = roundPresentationEpoch = round.epoch;
              hud?.setMaps(compatibleSandboxMaps(content, round.rules.mode, true));
              roundLoading = true; diagnostics.ready = false;
              voice?.suspend();
              // Clear old ownership/input/events immediately, not after potentially
              // slow image fetches. Confirmed networking continues during loading.
              resetRoundPresentation(round.map);
              const prepared = await prepareRoundMap(round.map);
              if (cancelled || prepared === undefined || epoch !== roundPresentationEpoch) return;
              world?.sync();
              const player = world?.sprites[(online?.session.metrics.slot ?? 1) - 1];
              if (player?.active) { camera.x = player.x; camera.y = player.y; }
              input?.reset();
              roundLoading = false;
            },
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
            voice = new VoiceClient({
              send: (message: FeatureClientMessage) => online!.session.sendFeature(message),
              onStatus: text => hud?.setVoiceStatus(text),
            });
            voice.setSettings(settings.voice, masterVolume);
            if (initialVoiceState) voice.receive(initialVoiceState);
            syncVoiceMutes();
            respawn = () => { throw new Error("Online respawn is server-owned"); };
            diagnostics.simulation = "online; awaiting authoritative snapshot"; onStatus(diagnostics.simulation);
          }).catch(error => {
            if (cancelled) return;
            diagnostics.simulation = `online unavailable: ${String(error)}`; onStatus(diagnostics.simulation);
          });
          else if (!capture && !qualification) void (attract ? Promise.resolve() : audio!.prepare({ loadout: hud?.loadout, bots: combatCapture ? 0 : sandbox.bots })).then(() => loadSandbox(map.name, abort.signal, combatCapture, hud?.loadout, sandbox, settings.nickname, attract, settings.appearance)).then(async loaded => {
            if (cancelled) { loaded.dispose(); return; }
            host = loaded;
            if (!attract) inputPtr = requireStatus(host.exports.sim_alloc(12), "sim_alloc(input)");
            eventPtr = requireStatus(host.exports.sim_alloc(EVENT_CAPACITY), "sim_alloc(events)");
            if ((!attract && !inputPtr) || !eventPtr) throw new Error("Simulation buffer allocation failed");
            world = new SimWorldView(host);
            fx = new SimEffectsView(host);
            if (appearancePending) appearanceGame?.(desiredAppearance);
            // Read-only qualification surface; ordinary matches keep no diagnostic copies.
            if (!attract && new URLSearchParams(location.search).has("bots-check")) window.__soldatPractice = () => {
              const hash = host!.hash(), view = world!.renderView;
              return { tick: view.tick, hash, bink: bink.counter, bullets: view.bulletCount,
                scores: Array.from(view.globals.teamScores),
                thingStyles: Array.from({ length: view.thingCount }, (_, index) => view.thing(index).style),
                players: Array.from({ length: view.slots }, (_, index) => view.sprite(index))
                  .filter(sprite => (sprite.flags & 1) !== 0)
                  .map(sprite => ({ slot: sprite.slot, name: sprite.playerName, team: sprite.team, flags: sprite.flags,
                    x: sprite.posX, y: sprite.posY, kills: sprite.kills, deaths: sprite.deaths, fired: sprite.fired, weapon: sprite.weapon, secondaryWeapon: sprite.secondaryWeapon })) };
            };
            if (!attract) respawn = () => {
              requireStatus(host!.command(world!.tick, { kind: "spawn", slot: 1 }), "sim_command(spawn)");
              world!.sync(); input?.reset(); hud?.spawned(); canvas.focus({ preventScroll: true });
            };
            // The serial capture harness exercises the original spawn command after
            // its former debug-toolbar button was removed from product gameplay.
            if (!attract && new URLSearchParams(location.search).has("capture-check")) window.__soldatCapture = { respawn: respawnGame };
            if (attract) {
              // Finish native join/spawn initialization before freezing reduced motion.
              // No forced spawn, synthetic soldier, or second simulation path.
              for (let warmup = 0; warmup < 600 && followed < 0; warmup++) step();
              if (followed < 0) throw new Error("Attract match has no living bot after native startup");
              followBot(true);
            }
            else { const player = world.sprites[0]!; camera.x = player.x; camera.y = player.y; }
            clock.reset();
            if (combatCapture) {
              const wasmSha256 = (await loadSimulationCode(abort.signal, "/sim.wasm")).sha256;
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
                  gallery = undefined; overrides.clear(); input?.reset(); clock.reset(); presentationTick = 0;
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
            diagnostics.simulation = `${attract ? "attract; 8 original AI bots" : combatCapture ? "combat sandbox" : `${sandbox.mode.toUpperCase()} practice; ${sandbox.bots} bots`}; ${fxAvailable ? "cosmetics active" : "cosmetic simulation unavailable"}; ${attract ? "muted" : "positional SFX ready"}${warnings.length ? `; WARNING ${warnings.join("; ")}` : ""}`;
            onStatus(diagnostics.simulation);
          }).catch(error => {
            if (cancelled) return;
            diagnostics.simulation = `simulation unavailable: ${String(error)}`;
            onStatus(diagnostics.simulation);
          });
        }
        update(time: number) {
          if (stopped || (roundLoading && !online) || (!qualification && document.hidden) || (paused && !online) || gl!.isContextLost()) { clock.reset(); frameTime = Number.NaN; return; }
          try {
            if (online && host && world) {
              if (appearancePending && online.session.metrics.status === "online") appearanceGame?.(desiredAppearance);
              const local = world.sprites[online.session.metrics.slot - 1]!;
              online.session.advance(
                () => {
                  refreshSpectator(local.slot);
                  input!.updateSpectator(spectator, paused || roundLoading || hud?.gameplayCaptured === true);
                  return paused || roundLoading || local.team === 5 ? neutral : online!.hook.input ?? input!.sample(camera, width, height, local.x, local.y, hud?.gameplayCaptured);
                },
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
                  if (!roundLoading && local.active) {
                    refreshSpectator(local.slot);
                    if (spectator.observing) observeCamera();
                    else updateCamera(camera, local.x, local.y, local.aimX, local.aimY, settings.scope ? local.aimDistCoef : 7);
                  }
                  audio?.setListener(spectator.observing ? camera.x : local.x, spectator.observing ? camera.y : local.y);
                },
              );
              diagnostics.tick = world.tick;
              presentationTick = world.tick; online.updateOverlay();
            } else if (!combatPaused) {
              if (qualification) clock.advance(time, step);
              else {
                if (!Number.isNaN(frameTime)) scaledTime += Math.max(0, time - frameTime) * (world?.renderView.globals.tickScale ?? 1);
                frameTime = time;
                clock.advance(scaledTime, step);
              }
            }
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
        input: attract ? { keyboard: false, mouse: false, touch: false, gamepad: false } : undefined,
        audio: attract ? { noAudio: true } : { disableWebAudio: false, context: audioContext ??= new AudioContext() }, render: { antialias: false, transparent: false, roundPixels: false },
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
      screenshotRequest?.reject(new Error("Game closed before screenshot capture"));
      voice?.dispose();
      screenshotRequest = undefined;
      if (game) await new Promise<void>(resolve => { game!.events.once(Phaser.Core.Events.DESTROY, resolve); game!.destroy(true); });
      if (online) online.dispose();
      else if (host) { if (inputPtr) host.exports.sim_free(inputPtr); if (eventPtr) host.exports.sim_free(eventPtr); host.dispose(); }
      delete window.__soldatGate;
      delete window.__soldatCombat;
      delete window.__soldatPractice;
      delete window.__soldatCapture;
      hud?.destroy();
      input?.destroy();
      if (window.__soldatClient === diagnostics) delete window.__soldatClient;
      respawn = undefined;
      if (pauseGame === setPaused) {
        pauseGame = undefined; weaponsGame = undefined; teamsGame = undefined;
        teamGame = undefined; appearanceGame = undefined; settingsGame = undefined; voiceVolumeGame = undefined;
      }
      applyPause = undefined;
    }
  });
  return () => {
    cancelled = true; abort.abort(); release();
    voice?.dispose();
    if (pauseGame === setPaused) {
      pauseGame = undefined; weaponsGame = undefined; teamsGame = undefined;
      teamGame = undefined; appearanceGame = undefined; settingsGame = undefined; voiceVolumeGame = undefined;
    }
  };
}
