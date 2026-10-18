import { RENDER_LAYOUT, SPRITE_FLAGS, type RenderView } from "@soldat-web/sim-host";
import { contentUrl } from "../content";
import { sessionFont, sessionImage } from "../session-cache";
import { resizeCamera, screenAt, worldAt } from "../camera";
import { SoldatMap, TextureBank } from "./soldat-map";
import { type WorldSprite, type WorldView } from "../world";
import type { Camera, DrawRun, Geometry, ImageAsset } from "./types";
import { LIMBO_WEAPONS, LimboMenu, limboHitIndex, limboKeyIndex, limboRowY, limboWeaponEnabled } from "./limbo";
import { cursorMoveAccuracy, cursorScale, cursorTarget } from "./cursor";
import type { ChatDelivery, FeatureClientMessage, FeatureServerMessage } from "@soldat-web/protocol";
import { DEFAULT_SETTINGS, type Settings } from "../settings";
import { bindingMatches } from "../bindings";
import { GameConsole, type ChatChannel, type ConsoleLine } from "../console";
import { tauntForKey } from "../taunts";
import { containsAdminCredential, RADIO_CATEGORIES, RADIO_DIRECTIONS, radioText, voteSecondsRemaining } from "../feature-commands";

const COMPACT_CONSOLE_LINES = 6;
const CONSOLE_LINE_HEIGHT = 17;

export interface HudContent {
  graphics: { interface: readonly { symbol: string; asset: ImageAsset | null }[] };
  font: string;
}
export interface HudOptions {
  startJet: number;
  weapons: Readonly<Record<string, { ammo: number; reloadtime: number; fireinterval: number; movementacc?: number }>>;
  onInputCapture?: (captured: boolean) => void;
  weaponsMenu?: boolean;
  pointer?: { pointerX: number; pointerY: number };
  onWeaponChoice?: (primary: number, secondary: number, selection: "primary" | "secondary") => void;
  weaponChoiceNotice?: string;
  /** One-based native WeaponActive / per-player WeaponSel, when supplied. */
  weaponActive?: readonly number[];
  weaponSelection?: readonly number[];
  camera?: Camera;
  sniperLine?: boolean;
  playerNames?: boolean;
  onTeamChange?: (team: number) => void;
  settings?: Settings;
  onChat?: (channel: ChatChannel, text: string) => void;
  onConsoleCommand?: (command: string, args: readonly string[]) => void | Promise<void>;
  onSettingsChange?: (settings: Settings) => void;
  onFeature?: (message: FeatureClientMessage) => void;
  onVoiceTransmit?: (active: boolean) => void;
  onLocalMuteChange?: () => void;
  maps?: readonly string[];
  observerSlot?: () => number;
}
export interface HudPlayer {
  slot: number;
  name?: string;
  team: number;
  kills?: number;
  deaths?: number;
  ping?: number;
  flags?: number;
  shirtColor?: number;
  dead?: boolean;
  bot?: boolean;
}
/** Only explicit native death/protocol records belong here, never health deltas. */
export interface HudKillEvent {
  tick: number;
  killer: string;
  victim: string;
  weapon: number;
  /** Native death-snapshot KillBullet code; determines grenade/special icons. */
  killBullet?: number;
  suicide?: boolean;
  killerKills?: number;
  killerTeam?: number;
  victimTeam?: number;
}
export interface HudPresentation {
  players?: readonly HudPlayer[];
  teamScores?: readonly number[];
  /** Native GAMESTYLE value (0 DM, 1 pointmatch, 2 teammatch, 3 CTF, 4 rambo, 5 INF, 6 HTF). */
  gameMode?: number;
  startHealth?: number;
  startJet?: number;
  killLimit?: number;
  timeLeftSeconds?: number;
  serverName?: string;
  serverInfo?: string;
  vest?: number;
  ammoCapacity?: number;
  reloadTime?: number;
  /** Native interpolated counters, when supplied by the rendering producer. */
  reloadReal?: number;
  fireIntervalReal?: number;
  fireInterval?: number;
  fireIntervalCount?: number;
  tertiaryWeapon?: number;
  /** Client-owned original HitSprayCounter, never a gameplay-state mutation. */
  hitSprayCounter?: number;
  ping?: number;
  killEvents?: readonly HudKillEvent[];
  /** True only when the producer actually supplies the death-event stream. */
  killFeedAvailable?: boolean;
  /** Evidence gallery only: native raster section through line 2281, Fire disabled. */
  rasterOnly?: boolean;
  roundPhase?: number;
  roundEpoch?: number;
  mapChangeCounter?: number;
  realistic?: boolean;
  survival?: boolean;
  survivalEndRound?: boolean;
  advance?: boolean;
  bulletTime?: boolean;
  tickScale?: number;
  sniperLine?: boolean;
  enabledWeaponsMask?: number;
  availableWeaponsMask?: number;
  respawnCounter?: number;
  bonusStyle?: number;
  bonusTime?: number;
  objectives?: readonly HudObjective[];
}
export interface HudObjective { style: number; active: boolean; holder: number; inBase: boolean }
interface HudImage { image: HTMLImageElement; width: number; height: number }
const EMPTY_PRESENTATION: HudPresentation = {};
const TEAM_NAMES = ["Player", "Alpha", "Bravo", "Charlie", "Delta", "Spectator"];
const MODE_NAMES = ["Deathmatch", "Pointmatch", "Teammatch", "Capture the Flag", "Rambomatch", "Infiltration", "Hold the Flag"];
const MODE_OBJECTIVES = ["Most kills wins", "Carry the yellow flag for doubled kill points", "Score kills for your team",
  "Capture the enemy flag; return yours", "Find the Rambo bow to score", "Alpha: steal the black flag · Bravo: defend it", "Hold the yellow flag to score for your team"];
const TEAM_MODES = [2, 3, 5, 6];
const TEAM_COLORS = ["#e9e4d4", "#ff3732", "#7278ff", "#d2d205", "#05d205", "#dc32c8"];
// Weapons.pas weapon NUMs, not the distinct Guns[] indices.
const WEAPONS: Readonly<Record<number, readonly [string, string, string]>> = {
  0: ["USSOCOM", "ussocom", "SOCOM"],
  1: ["Desert Eagles", "desert eagles", "DEAGLES"],
  2: ["HK MP5", "hk mp5", "MP5"],
  3: ["Ak-74", "ak-74", "AK74"],
  4: ["Steyr AUG", "steyr aug", "STEYR"],
  5: ["Spas-12", "spas-12", "SPAS"],
  6: ["Ruger 77", "ruger 77", "RUGER"],
  7: ["M79", "m79", "M79"],
  8: ["Barrett M82A1", "barret m82a1", "BARRETT"],
  9: ["FN Minimi", "fn minimi", "MINIMI"],
  10: ["XM214 Minigun", "xm214 minigun", "MINIGUN"],
  11: ["Combat Knife", "combat knife", "KNIFE"],
  12: ["Chainsaw", "chainsaw", "CHAINSAW"],
  13: ["LAW", "m72 law", "LAW"],
  14: ["Flamer", "flamer", "FLAMER"],
  15: ["Bow", "rambo bow", "BOW"],
  16: ["Flame Bow", "flamed arrows", "BOW"],
  30: ["M2 MG", "stationary gun", "M2"],
  255: ["Hands", "punch", "FIST"],
};
// NetworkClientSprite.pas:490–503; these are NOT weapon NUMs.
const KILL_ICONS: Readonly<Record<number, string>> = {
  0: "GUNS_SOCOM", 1: "GUNS_DEAGLES", 2: "GUNS_MP5", 3: "GUNS_AK74",
  4: "GUNS_STEYR", 5: "GUNS_SPAS", 6: "GUNS_RUGER", 7: "GUNS_M79",
  8: "GUNS_BARRETT", 9: "GUNS_MINIMI", 10: "GUNS_MINIGUN",
  205: "GUNS_FLAMER", 206: "GUNS_FIST", 207: "GUNS_BOW", 208: "GUNS_BOW",
  210: "CLUSTER_NADE", 211: "GUNS_KNIFE", 212: "GUNS_CHAINSAW",
  222: "NADE", 224: "GUNS_LAW", 225: "GUNS_M2",
};
const KILLER_COLORS = ["#52d119", "#ffe3e3", "#d3e3ff", "#ffffe3", "#d3ffe3"];
const VICTIM_COLORS = ["#801304", "#dab0b0", "#a0b0da", "#d0d0b0", "#a0d0ba"];
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const shown = (value: number | undefined): string => value === undefined ? "unavailable" : String(value);

interface PresentationCache {
  data: DataView;
  state: HudPresentation;
  players: HudPlayer[];
  slots: HudPlayer[];
  names: Uint8Array[];
  nameLengths: number[];
  scores: number[];
  objectives: HudObjective[];
}
const presentationCaches = new WeakMap<ArrayBufferLike, Map<number, PresentationCache>>();
const playerNameDecoder = new TextDecoder();

/**
 * Borrowed, reusable ABI3 HUD projection. Refresh after sim calls/memory growth;
 * consume before another projection of the same buffer. Does not allocate full
 * RenderSprite objects or skeleton views. Strings decode only when bytes change.
 * Optional protocol metadata is authoritative, and is never synthesized here.
 */
export function hudPresentationFromRender(
  view: RenderView, localSlot: number, metadata: HudPresentation = EMPTY_PRESENTATION,
): HudPresentation {
  let buffers = presentationCaches.get(view.bytes.buffer);
  if (!buffers) {
    buffers = new Map();
    presentationCaches.set(view.bytes.buffer, buffers);
  }
  let cache = buffers.get(view.bytes.byteOffset);
  if (!cache) {
    cache = {
      data: new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength),
      state: {}, players: [], slots: [], names: [], nameLengths: [], scores: [0, 0, 0, 0, 0, 0],
      objectives: [1, 2, 3, 15].map(style => ({ style, active: false, holder: 0, inBase: false })),
    };
    for (let i = 0; i < RENDER_LAYOUT.slots; i++) {
      cache.slots.push({ slot: i + 1, team: 0 });
      cache.names.push(new Uint8Array(RENDER_LAYOUT.playerNameBytes));
      cache.nameLengths.push(-1);
    }
    buffers.set(view.bytes.byteOffset, cache);
  }
  const { data, state, players } = cache;
  const s = RENDER_LAYOUT.sprite;
  players.length = 0;
  state.vest = state.ammoCapacity = state.reloadTime = state.fireInterval =
    state.fireIntervalCount = state.tertiaryWeapon = state.ping = undefined;
  state.availableWeaponsMask = state.respawnCounter = state.bonusStyle = state.bonusTime = undefined;
  for (let i = 0; i < RENDER_LAYOUT.slots; i++) {
    const base = RENDER_LAYOUT.headerBytes + i * RENDER_LAYOUT.spriteBytes;
    const flags = data.getUint32(base + s.flags, true);
    if ((flags & SPRITE_FLAGS.active) === 0) continue;
    const player = cache.slots[i]!;
    player.slot = data.getUint32(base + s.slot, true);
    player.team = data.getUint32(base + s.team, true);
    player.kills = data.getInt32(base + s.kills, true);
    player.deaths = data.getInt32(base + s.deaths, true);
    player.ping = data.getUint32(base + s.ping, true);
    player.flags = data.getUint32(base + s.playerFlags, true);
    player.shirtColor = data.getUint32(base + s.shirtColor, true);
    player.dead = (flags & SPRITE_FLAGS.dead) !== 0;
    player.bot = (flags & SPRITE_FLAGS.bot) !== 0;
    const length = data.getUint32(base + s.playerNameLength, true);
    if (length > RENDER_LAYOUT.playerNameBytes) throw new Error("Unsupported HUD player name length");
    const name = cache.names[i]!;
    let changed = length !== cache.nameLengths[i];
    for (let n = 0; n < length; n++) {
      const byte = data.getUint8(base + s.playerName + n);
      if (name[n] !== byte) changed = true;
      name[n] = byte;
    }
    if (changed) {
      player.name = playerNameDecoder.decode(name.subarray(0, length));
      cache.nameLengths[i] = length;
    }
    players.push(player);
    if (player.slot === localSlot) {
      state.vest = data.getFloat32(base + s.vest, true);
      state.ammoCapacity = data.getUint32(base + s.weaponAmmo, true);
      state.reloadTime = data.getUint32(base + s.weaponReloadTime, true);
      state.fireInterval = data.getUint32(base + s.weaponFireInterval, true);
      state.fireIntervalCount = data.getUint32(base + s.fireIntervalCount, true);
      state.tertiaryWeapon = data.getUint32(base + s.tertiaryWeapon, true);
      state.ping = player.ping;
      state.availableWeaponsMask = data.getUint32(base + s.availableWeaponsMask, true);
      state.respawnCounter = data.getInt32(base + s.respawnCounter, true);
      state.bonusStyle = data.getInt32(base + s.bonusStyle, true);
      state.bonusTime = data.getInt32(base + s.bonusTime, true);
    }
  }
  // Game.pas SortPlayers: captures descending, kills descending, deaths ascending.
  players.sort((a, b) => (b.flags! - a.flags!) || (b.kills! - a.kills!) ||
    (a.deaths! - b.deaths!) || a.slot - b.slot);
  const base = RENDER_LAYOUT.globalsOffset, g = RENDER_LAYOUT.globals;
  for (let team = 0; team < 6; team++) cache.scores[team] = data.getInt32(base + g.teamScores + team * 4, true);
  state.players = players;
  state.teamScores = cache.scores;
  state.startHealth = data.getInt32(base + g.startHealth, true);
  state.startJet = data.getInt32(base + g.mapStartJet, true);
  state.gameMode = data.getInt32(base + g.gameMode, true);
  state.killLimit = data.getInt32(base + g.killLimit, true);
  state.serverName = metadata.serverName;
  state.serverInfo = metadata.serverInfo;
  const globals = view.globals;
  state.timeLeftSeconds = globals.timeLimitTicks > 0 ? Math.max(0, Math.ceil(globals.timeLeftTicks / 60)) : undefined;
  state.roundPhase = globals.roundPhase;
  state.roundEpoch = globals.roundEpoch;
  state.mapChangeCounter = globals.mapChangeCounter;
  state.realistic = globals.realistic;
  state.survival = globals.survival;
  state.survivalEndRound = globals.survivalEndRound;
  state.advance = globals.advance;
  state.bulletTime = globals.bulletTime;
  state.tickScale = globals.tickScale;
  state.sniperLine = globals.sniperLine;
  state.enabledWeaponsMask = globals.enabledWeaponsMask;
  for (const objective of cache.objectives) objective.active = false;
  for (let i = 0; i < view.thingCount; i++) {
    const thing = view.thingsOffset + RENDER_LAYOUT.sectionHeaderBytes + i * RENDER_LAYOUT.thingBytes;
    const style = data.getUint32(thing + RENDER_LAYOUT.movingEntity.style, true);
    const objective = style >= 1 && style <= 3 ? cache.objectives[style - 1] : style === 15 ? cache.objectives[3] : undefined;
    if (!objective) continue;
    objective.active = true;
    objective.holder = data.getUint32(thing + RENDER_LAYOUT.thing.holdingSprite, true);
    objective.inBase = (data.getUint32(thing + RENDER_LAYOUT.thing.flags, true) & 2) !== 0;
  }
  state.objectives = cache.objectives;
  state.killEvents = metadata.killEvents;
  state.killFeedAvailable = metadata.killFeedAvailable;
  state.rasterOnly = metadata.rasterOnly;
  state.reloadReal = metadata.reloadReal;
  state.fireIntervalReal = metadata.fireIntervalReal;
  return state;
}

/**
 * Native GL_LINEAR sampling through the existing PMA renderer. Canvas2D uses a
 * different downsampling reconstruction filter; it remains text-only here.
 */
class HudRaster {
  globalAlpha = 1;
  tint = 0xffffff;
  private readonly bank = new TextureBank();
  private readonly renderer: SoldatMap;
  private readonly keys = new Map<CanvasImageSource, string>();
  private readonly geometry: Geometry = { runs: [] };
  private readonly clearColor = [0, 0, 0, 0];
  private readonly pool: DrawRun[] = [];
  private readonly camera: Camera = { x: 320, y: 240, width: 640, height: 480, z: 0 };
  private lost = false;
  constructor(private readonly canvas: HTMLCanvasElement, sources: readonly CanvasImageSource[]) {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 HUD renderer unavailable");
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i] as HTMLImageElement | HTMLCanvasElement;
      const key = String(i);
      this.keys.set(source, key);
      this.bank.sources.set(key, { source, repeat: false });
    }
    this.renderer = new SoldatMap(gl, this.bank, true, false);
    canvas.addEventListener("webglcontextlost", this.contextLost);
    canvas.addEventListener("webglcontextrestored", this.contextRestored);
  }
  begin(width: number, height: number, logicalWidth: number): void {
    this.geometry.runs.length = 0;
    if (this.lost) return;
    this.camera.x = logicalWidth / 2;
    this.camera.width = logicalWidth;
    this.renderer.begin(this.camera, width, height, this.clearColor);
  }
  drawImage(
    source: HTMLImageElement | HTMLCanvasElement, a: number, b: number, c: number, d: number,
    x?: number, y?: number, width?: number, height?: number,
  ): void {
    const key = this.keys.get(source);
    if (key === undefined || this.lost) return;
    const cropped = x !== undefined;
    const dx = cropped ? x : a, dy = cropped ? y! : b;
    const dw = cropped ? width! : c, dh = cropped ? height! : d;
    const u0 = cropped ? a / source.width : 0, v0 = cropped ? b / source.height : 0;
    const u1 = cropped ? (a + c) / source.width : 1, v1 = cropped ? (b + d) / source.height : 1;
    const index = this.geometry.runs.length;
    let run = this.pool[index];
    if (!run) {
      const color = [255, 255, 255, 255];
      run = { key, repeat: false, vertices: Array.from({ length: 6 }, () => ({ x: 0, y: 0, u: 0, v: 0, color })) };
      this.pool[index] = run;
    }
    run.key = key;
    const color = run.vertices[0]!.color;
    color[0] = this.tint >>> 16 & 255; color[1] = this.tint >>> 8 & 255; color[2] = this.tint & 255;
    color[3] = Math.round(this.globalAlpha * 255);
    for (let i = 0; i < 6; i++) {
      const right = i === 1 || i === 2 || i === 3;
      const bottom = i === 2 || i === 3 || i === 4;
      const vertex = run.vertices[i]!;
      vertex.x = dx + (right ? dw : 0);
      vertex.y = dy + (bottom ? dh : 0);
      vertex.u = right ? u1 : u0;
      vertex.v = bottom ? v1 : v0;
    }
    this.geometry.runs.push(run);
  }
  drawRotatedImage(source: HTMLImageElement, x: number, y: number, width: number, height: number, angle: number): void {
    const index = this.geometry.runs.length;
    this.drawImage(source, x, y, width, height);
    const run = this.geometry.runs[index];
    if (!run) return;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    for (const vertex of run.vertices) {
      const dx = vertex.x - x, dy = vertex.y - y;
      vertex.x = x + dx * cosine - dy * sine;
      vertex.y = y + dx * sine + dy * cosine;
    }
  }
  finish(): void {
    if (!this.lost) this.renderer.drawDynamic(this.geometry);
  }
  clear(): void {
    if (this.lost) return;
    const gl = this.renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  private readonly contextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
  };
  private readonly contextRestored = (): void => {
    this.renderer.restore();
    this.lost = false;
  };
  destroy(): void {
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.contextRestored);
    this.renderer.destroy();
    this.keys.clear();
    this.bank.sources.clear();
  }
}

/**
 * Original default interface, drawn per frame outside React. Coordinates and
 * anchor-relative offsets: InterfaceGraphics.pas LoadDefaultInterfaceData,
 * RenderBar, RenderPlayerInterfaceTexts and RenderInterface. Native scaled
 * interface uses a 480-high logical viewport; only anchors expand horizontally.
 * Imported asset.scale is the source high-resolution divisor, not a stretch.
 */
export class CombatHud {
  private readonly root = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly graphicsCanvas = document.createElement("canvas");
  private raster!: HudRaster;
  private readonly viewport: Camera = { x: 0, y: 0, width: 640, height: 480, z: 0 };
  private readonly form = document.createElement("form");
  private readonly input = document.createElement("input");
  private readonly inputLabel = document.createElement("label");
  private readonly consoleLog = document.createElement("div");
  private readonly console: GameConsole;
  private readonly matchButton = document.createElement("button");
  private readonly featureStatus = document.createElement("div");
  private radioCategory: 0 | 1 | 2 | 3 = 0;
  private radioMenu = false;
  private matchMenu: "main" | "vote-player" | "admin-player" | "player-actions" | "match" | "vote-map" | "admin-map" | null = null;
  private menuPage = 0;
  private menuSlot = 0;
  private menuPlayerName = "";
  private voteReceivedAt = 0;
  private voteSeconds = -1;
  private controlStatus = "";
  private voiceStatus = "";
  private voiceKey = "";
  private voiceBinding = "";
  private chatChannel: ChatChannel = "public";
  private consoleScroll = 0;
  private readonly consoleRows: ConsoleLine[] = [];
  private lastChatChannel: ChatChannel = "public";
  private localTeam = 0;
  private spectatorText = "";
  private spectatorObserving = false;
  private spectatorTargetSlot = -1;
  private spectatorTargetName = "";
  private scoreboardKey = "";
  private readonly chatStatus = document.createElement("span");
  private readonly accessible = document.createElement("div");
  private readonly context: CanvasRenderingContext2D;
  private readonly images = new Map<string, HudImage>();
  private readonly pingTints: HTMLCanvasElement[] = [];
  private readonly teamOrder = [1, 2, 3, 4];
  private readonly observer: ResizeObserver;
  private font?: FontFace;
  private readonly fontFamily: string;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private logicalWidth = 640;
  private scoreboard = false;
  private scroll = 0;
  private destroyed = false;
  private suspended = false;
  private focusedBeforeChat: HTMLElement | null = null;
  private scoreboardText = "";
  private chatNotice = "";
  private chatNoticeUntil = 0;
  private readonly limbo = new LimboMenu();
  private limboPlayer = false;
  private menuHover = -1;
  private lastTick = 0;
  private readonly previousCursor: string;
  private teamMenu = false;
  private gameMode = 0;
  private weaponMask = 0x3fff;
  private selectionMask = 0x3fff;
  private readonly projected = { x: 0, y: 0 };
  private readonly aim = { x: 0, y: 0 };
  private ruleBits = -1;
  private ruleText = "";

  private constructor(private readonly host: HTMLElement, private readonly options: HudOptions) {
    this.console = new GameConsole(options.settings ?? DEFAULT_SETTINGS, {
      onChat: options.onChat,
      onConsoleCommand: (command, args) => {
        if (command === "matchmenu") { this.openMatchControls(); return; }
        if (!options.onConsoleCommand) throw new Error(`${command} is unavailable in this session`);
        return options.onConsoleCommand(command, args);
      },
      onFeature: options.onFeature,
      onLocalMuteChange: options.onLocalMuteChange,
      onSettingsChange: settings => { this.updateSettings(settings); options.onSettingsChange?.(settings); },
    });
    this.fontFamily = `SoldatHud${CombatHud.nextFont++}`;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D HUD renderer unavailable");
    this.context = context;
    this.previousCursor = host.style.cursor;
    this.root.className = "soldat-combat-hud";
    this.root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:3";
    this.canvas.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none";
    this.graphicsCanvas.style.cssText = this.canvas.style.cssText;
    this.canvas.setAttribute("aria-hidden", "true");
    this.graphicsCanvas.setAttribute("aria-hidden", "true");
    this.accessible.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:pre";
    this.accessible.setAttribute("role", "region");
    this.accessible.setAttribute("aria-label", "Scoreboard. Hold F1 to show. Tab controls weapons menu. T opens chat, Y team chat, slash console.");
    this.accessible.hidden = true;
    this.form.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;align-items:baseline;gap:2px;pointer-events:auto;color:#ffe6aa;white-space:nowrap";
    this.form.hidden = true;
    this.inputLabel.textContent = "Say:";
    this.input.type = "text";
    this.input.maxLength = 512;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-label", "Chat or console command. Enter sends; Escape cancels; Up and Down recall history.");
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.addEventListener("input", this.concealCredential);
    this.input.style.cssText = "font:inherit;color:inherit;background:transparent;border:0;padding:0;outline:none;width:400px;box-shadow:none;border-radius:0;min-height:0";
    this.inputLabel.append(this.input);
    this.chatStatus.textContent = "Enter sends · Esc cancels";
    this.chatStatus.setAttribute("role", "status");
    this.form.append(this.inputLabel, this.chatStatus);
    this.consoleLog.style.cssText = this.accessible.style.cssText;
    this.consoleLog.setAttribute("role", "log");
    this.consoleLog.setAttribute("aria-label", "Chat and console output");
    this.consoleLog.setAttribute("aria-live", "polite");
    this.root.append(this.graphicsCanvas, this.canvas, this.form, this.accessible, this.consoleLog);
    this.matchButton.type = "button";
    this.matchButton.className = "soldat-match-controls";
    this.matchButton.textContent = "Match controls";
    this.matchButton.hidden = !options.onFeature;
    this.matchButton.style.cssText = "position:absolute;right:8px;top:34px;pointer-events:auto;background:#0009;color:#ffe6aa;border:1px solid #8a7c59;padding:3px 6px";
    this.matchButton.addEventListener("click", this.matchClick);
    this.featureStatus.style.cssText = this.accessible.style.cssText;
    this.featureStatus.setAttribute("role", "status");
    this.featureStatus.setAttribute("aria-label", "Match, voting and voice status");
    this.root.append(this.matchButton, this.featureStatus);
    this.host.append(this.root);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(this.host);
    this.resize();
    window.addEventListener("keydown", this.keyDown, true);
    window.addEventListener("keyup", this.keyUp, true);
    window.addEventListener("mousedown", this.menuMouseDown, true);
    window.addEventListener("mousedown", this.boundMouseDown, true);
    window.addEventListener("mouseup", this.boundMouseUp, true);
    window.addEventListener("blur", this.blur);
    window.addEventListener("pagehide", this.blur);
    window.addEventListener("focusin", this.releaseVoice);
    document.addEventListener?.("visibilitychange", this.visibilityChanged);
    this.host.addEventListener("wheel", this.wheel, { passive: false });
    this.form.addEventListener("submit", this.submit);
  }

  private static nextFont = 0;
  static async create(host: HTMLElement, content: HudContent, options: HudOptions): Promise<CombatHud> {
    const hud = new CombatHud(host, options);
    try {
      const font = await sessionFont(hud.fontFamily, contentUrl(content.font));
      document.fonts.add(font);
      hud.font = font;
      await Promise.all(content.graphics.interface.map(async graphic => {
        if (!graphic.asset) throw new Error(`Missing original HUD graphic ${graphic.symbol}`);
        const asset = graphic.asset;
        const image = await sessionImage(contentUrl(asset.frames[0]!.object));
        hud.images.set(graphic.symbol.replace("GFX_INTERFACE_", ""), {
          image, width: asset.width / asset.scale, height: asset.height / asset.scale,
        });
      }));
      const dot = hud.images.get("DOT");
      if (dot) {
        for (const color of ["#00ff00", "#22ff00", "#54c700", "#76a700", "#938800", "#a17700", "#cc4800", "#ff0000"]) {
          const canvas = document.createElement("canvas");
          canvas.width = dot.image.naturalWidth;
          canvas.height = dot.image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas ping tint unavailable");
          context.drawImage(dot.image, 0, 0);
          context.globalCompositeOperation = "source-in";
          context.fillStyle = color;
          context.fillRect(0, 0, canvas.width, canvas.height);
          hud.pingTints.push(canvas);
        }
      }
      hud.raster = new HudRaster(hud.graphicsCanvas, [
        ...Array.from(hud.images.values(), asset => asset.image), ...hud.pingTints,
      ]);
      hud.form.style.font = `9px "${hud.fontFamily}"`;
      hud.matchButton.style.font = `12px "${hud.fontFamily}"`;
      hud.refreshConsoleLog();
      return hud;
    } catch (error) {
      hud.destroy();
      throw error;
    }
  }

  get inputActive(): boolean { return !this.form.hidden; }
  get gameplayCaptured(): boolean { return this.inputActive || this.limbo.active || this.teamMenu || this.radioMenu || this.matchMenu !== null; }
  /** Current limbo primary/secondary original weapon numbers, used as the join loadout. */
  get loadout(): { weapon: number; secondaryWeapon: number } { return { weapon: this.limbo.primary, secondaryWeapon: this.limbo.secondary }; }

  updateSettings(settings: Pick<Settings, "sniperLine" | "playerNames"> & Partial<Settings>): void {
    this.releaseVoice();
    this.options.sniperLine = settings.sniperLine;
    this.options.playerNames = settings.playerNames;
    this.console.settings = { ...this.console.settings, ...settings };
  }
  receiveChat(message: ChatDelivery): void {
    if (this.console.receiveChat(message)) this.refreshConsoleLog();
  }
  isPlayerMuted(slot: number, nickname: string): boolean {
    return this.console.isPlayerMuted(slot, nickname);
  }
  consoleNotice(text: string): void {
    this.console.notice(text);
    this.refreshConsoleLog();
  }
  receiveFeature(message: FeatureServerMessage): void {
    if (message.type === "control-state") {
      const previous = this.console.controls;
      this.console.controls = message.state;
      this.voteReceivedAt = Date.now();
      this.voteSeconds = -1;
      if (message.state.paused || message.state.muted) this.releaseVoice();
      if (previous.paused !== message.state.paused) this.consoleNotice(message.state.paused ? "Server paused" : "Server resumed");
      if (previous.admin !== message.state.admin || previous.host !== message.state.host)
        this.consoleNotice(message.state.admin ? "Operator authenticated" : message.state.host ? "Friend-match host controls active" : "Player controls active");
      if (previous.muted !== message.state.muted) this.consoleNotice(message.state.muted ? "You are server-muted (chat, radio and voice)" : "Server mute removed");
      const vote = message.state.vote;
      if (vote && vote.phase !== "active" && (previous.vote?.id !== vote.id || previous.vote.phase !== vote.phase))
        this.consoleNotice(`Vote ${vote.phase}: ${vote.targetLabel}${vote.reason ? ` — ${vote.reason}` : ""}`);
      this.controlStatus = `${message.state.admin ? "Operator" : message.state.host ? "Host" : "Player"}${message.state.paused ? "; server paused" : ""}${message.state.muted ? "; server-muted" : ""}${vote ? `; Vote ${vote.targetLabel}: ${vote.yes} yes, ${vote.no} no, ${vote.required} required of ${vote.eligible}; ${vote.phase}; ${vote.myVote ? `voted ${vote.myVote}` : vote.canVote ? "eligible" : "not eligible"}` : ""}`;
      this.featureStatus.textContent = `${this.controlStatus}; ${this.voiceStatus}`;
    } else if (message.type === "admin-bans") {
      this.consoleNotice(message.bans.length ? "Active bans:" : "No active bans");
      for (const ban of message.bans) this.consoleNotice(`${ban.id}: ${ban.nickname} (${ban.global ? "server" : "match"}) — ${ban.reason || "No reason"}; expires ${new Date(ban.expiresAt).toLocaleString()}`);
    } else if (message.type === "radio-message") {
      this.console.receiveChat({ type: "chat-message", channel: "team", slot: message.slot, nickname: message.nickname, text: radioText(message.category, message.direction) });
      this.refreshConsoleLog();
    }
  }
  setVoiceStatus(text: string): void {
    if (text === this.voiceStatus) return;
    this.voiceStatus = text;
    this.featureStatus.textContent = `${this.controlStatus}; ${text}`;
  }
  openMatchControls(): void {
    if (this.suspended || this.inputActive || !this.options.onFeature) return;
    this.releaseVoice(); this.radioMenu = false; this.teamMenu = false;
    this.matchMenu = "main"; this.menuPage = 0;
    this.options.onInputCapture?.(true);
  }
  setMaps(maps: readonly string[]): void {
    this.options.maps = maps;
    this.menuPage = 0;
  }
  private readonly matchClick = (): void => { this.openMatchControls(); };
  private readonly concealCredential = (): void => {
    this.input.type = containsAdminCredential(this.input.value) ? "password" : "text";
  };
  private readonly visibilityChanged = (): void => {
    if (document.hidden) this.blur();
  };
  private readonly releaseVoice = (): void => {
    if (!this.voiceKey) return;
    this.voiceKey = ""; this.voiceBinding = "";
    this.options.onVoiceTransmit?.(false);
  };
  private closeFeatureMenu(): void {
    this.radioMenu = false; this.radioCategory = 0; this.matchMenu = null;
    this.options.onInputCapture?.(this.gameplayCaptured);
  }
  private openRadio(): void {
    this.releaseVoice();
    if (this.localTeam === 5) { this.consoleNotice("Spectators cannot send radio"); return; }
    if (this.console.controls.muted) { this.consoleNotice("You are server-muted"); return; }
    if (this.limbo.active || this.teamMenu || this.matchMenu || this.console.controls.paused) return;
    this.radioMenu = !this.radioMenu; this.radioCategory = 0;
    this.options.onInputCapture?.(this.gameplayCaptured);
  }
  private menuRows(): string[] {
    const authority = this.console.controls.admin || this.console.controls.host;
    if (this.matchMenu === "main") return ["Vote map…", "Vote kick…", "Team radio", ...(authority ? ["Moderate player…", "Manage match…"] : []), this.console.controls.admin ? "Operator logout" : "Operator login…"];
    if (this.matchMenu === "vote-map" || this.matchMenu === "admin-map")
      return [...(this.options.maps ?? []).slice(this.menuPage * 6, this.menuPage * 6 + 6), "Previous maps", "Next maps"];
    if (this.matchMenu === "vote-player" || this.matchMenu === "admin-player") {
      const players = this.matchMenu === "vote-player" ? this.console.players.filter(player => !player.bot) : this.console.players;
      return [...players.slice(this.menuPage * 6, this.menuPage * 6 + 6).map(player => `${player.slot}: ${player.name ?? "Player"}`), "Previous players", "Next players"];
    }
    if (this.matchMenu === "player-actions") return ["Kick…", "Ban…", "Server mute", "Server unmute", "Force kill", "Force team…"];
    if (this.matchMenu === "match") return [this.console.controls.paused ? "Unpause" : "Pause", "Next map", "Restart round", "Change map…", "List bans", "Unban…", ...(this.console.controls.admin ? ["Operator logout"] : [])];
    return [];
  }
  private menuChoice(index: number): void {
    const authority = this.console.controls.admin || this.console.controls.host;
    if ((this.matchMenu === "admin-player" || this.matchMenu === "player-actions" || this.matchMenu === "match" || this.matchMenu === "admin-map") && !authority) {
      this.closeFeatureMenu(); this.consoleNotice("Host or operator authorization required"); return;
    }
    const prompt = (command: string): void => {
      this.closeFeatureMenu(); this.openChat("public", true);
      this.input.value = `/${command}`; this.concealCredential();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    };
    if (index < 0 || index >= this.menuRows().length) return;
    if (this.matchMenu === "main") {
      if (index === 0) {
        if (this.options.maps?.length) { this.matchMenu = "vote-map"; this.menuPage = 0; }
        else prompt("vote map ");
      }
      else if (index === 1) { this.matchMenu = "vote-player"; this.menuPage = 0; }
      else if (index === 2) { this.closeFeatureMenu(); this.openRadio(); }
      else if (index === 3 && authority) { this.matchMenu = "admin-player"; this.menuPage = 0; }
      else if (index === 4 && authority) this.matchMenu = "match";
      else if (index === (authority ? 5 : 3)) {
        if (this.console.controls.admin) { this.options.onFeature?.({ type: "admin-logout" }); this.closeFeatureMenu(); }
        else prompt("admin ");
      }
    } else if (this.matchMenu === "vote-map" || this.matchMenu === "admin-map") {
      const maps = this.options.maps ?? [], page = maps.slice(this.menuPage * 6, this.menuPage * 6 + 6);
      if (index >= page.length) this.menuPage = Math.max(0, Math.min(Math.max(0, Math.ceil(maps.length / 6) - 1), this.menuPage + (index === page.length ? -1 : 1)));
      else {
        const map = page[index]!;
        this.options.onFeature?.(this.matchMenu === "vote-map" ? { type: "vote-start", proposal: { kind: "map", map } } : { type: "admin-action", action: { kind: "map", map } });
        this.closeFeatureMenu();
      }
    } else if (this.matchMenu === "vote-player" || this.matchMenu === "admin-player") {
      const players = this.matchMenu === "vote-player" ? this.console.players.filter(player => !player.bot) : this.console.players;
      const page = players.slice(this.menuPage * 6, this.menuPage * 6 + 6);
      if (index >= page.length) {
        this.menuPage = Math.max(0, Math.min(Math.max(0, Math.ceil(players.length / 6) - 1), this.menuPage + (index === page.length ? -1 : 1)));
      } else {
        const player = page[index]!;
        if (this.matchMenu === "vote-player") prompt(`vote kick ${player.slot} `);
        else { this.menuSlot = player.slot; this.menuPlayerName = player.name ?? ""; this.matchMenu = "player-actions"; }
      }
    } else if (this.matchMenu === "player-actions") {
      if (!this.console.players.some(player => player.slot === this.menuSlot && (player.name ?? "") === this.menuPlayerName)) {
        this.closeFeatureMenu(); this.consoleNotice("Player left; select a current player"); return;
      }
      if (index === 0) prompt(`kick ${this.menuSlot} `);
      else if (index === 1) prompt(`ban ${this.menuSlot} 30 `);
      else if (index === 5) prompt(`setteam ${this.menuSlot} `);
      else {
        const kind = index === 2 ? "mute" : index === 3 ? "unmute" : "kill";
        this.options.onFeature?.({ type: "admin-action", action: { kind, slot: this.menuSlot } }); this.closeFeatureMenu();
      }
    } else if (this.matchMenu === "match") {
      if (index === 3) {
        if (this.options.maps?.length) { this.matchMenu = "admin-map"; this.menuPage = 0; }
        else prompt("map ");
      }
      else if (index === 5) prompt("unban ");
      else if (index === 6) { this.options.onFeature?.({ type: "admin-logout" }); this.closeFeatureMenu(); }
      else {
        const kind = index === 0 ? this.console.controls.paused ? "unpause" : "pause" : index === 1 ? "nextmap" : index === 2 ? "restart" : "bans";
        this.options.onFeature?.({ type: "admin-action", action: { kind } }); this.closeFeatureMenu();
      }
    }
  }
  private drawFeatures(): void {
    if (this.console.controls.paused && !this.matchMenu && !this.teamMenu && !this.limbo.active) this.text("Server paused", this.logicalWidth / 2, 328, 12, "#eaeaea", "center");
    if (this.voiceStatus && !this.matchMenu) this.text(this.voiceStatus, this.logicalWidth - 8, 316, 7, "#a5e6ff", "right");
    if (this.radioMenu) {
      this.sprite("BACK", 5, 248, 370, 64, 0.56);
      this.text("Radio:    Escape: cancel", 10, 252, 9, "#eaeaea");
      for (let i = 0; i < 3; i++) {
        this.text(`${i + 1}: ${RADIO_CATEGORIES[i]}`, 10, 270 + i * 12, 8, this.radioCategory === i + 1 ? "#eaea72" : "#c8c8c8");
        if (this.radioCategory) this.text(`${i + 1}: ${RADIO_DIRECTIONS[i]}`, 220, 270 + i * 12, 8, "#c8c8c8");
      }
    }
    if (this.matchMenu) {
      const rows = this.menuRows(), x = Math.max(45, this.logicalWidth / 2 - 190);
      this.sprite("BACK", x, 140, 380, rows.length * 20 + 60, 0.72);
      this.text(this.matchMenu === "player-actions" ? `Moderate ${this.menuPlayerName || this.menuSlot}` : this.matchMenu === "vote-player" ? "Vote kick" : this.matchMenu === "admin-player" ? "Select player" : this.matchMenu === "match" ? "Manage match" : `Match controls (${this.console.controls.admin ? "operator" : this.console.controls.host ? "host" : "player"})`, x + 15, 148, 12, "#eaeaea");
      for (let i = 0; i < rows.length; i++) this.text(`${i + 1} ${rows[i]}`, x + 15, 178 + i * 20, 9, "#ffe6aa");
      this.text("Escape: cancel", x + 15, 178 + rows.length * 20, 8, "#fff5b1");
    }
  }
  private drawVote(now: number): void {
    const vote = this.console.controls.vote;
    if (!vote || vote.phase !== "active") return;
    const seconds = voteSecondsRemaining(vote.remainingMs, this.voteReceivedAt, now);
    if (this.voteSeconds !== seconds) {
      this.voteSeconds = seconds;
      this.featureStatus.textContent = `${this.controlStatus}; ${seconds} seconds remaining; ${this.voiceStatus}`;
    }
    this.sprite("BACK", 5, 380, Math.max(300, this.logicalWidth - 10), 54, 0.56);
    this.text(`${vote.proposal.kind === "kick" ? "Kick" : "Map"}: ${vote.targetLabel} — ${seconds}s`, 10, 382, 9, "#e0daf4");
    this.text(`Voter: ${vote.initiator}${vote.proposal.kind === "kick" ? ` · Reason: ${vote.proposal.reason}` : ""}`, 10, 395, 8, "#e0daf4");
    this.text(`Yes ${vote.yes} / ${vote.required} required · No ${vote.no} · Eligible ${vote.eligible}`, 10, 408, 8, "#e0daf4");
    const yes = Object.entries(this.console.settings.commandBindings).find(([, value]) => value === "vote yes")?.[0];
    const no = Object.entries(this.console.settings.commandBindings).find(([, value]) => value === "vote no")?.[0];
    this.text(vote.myVote ? `You voted ${vote.myVote}` : !vote.canVote ? "Not eligible" : seconds === 0 ? "Awaiting server result" : `${yes ?? "/vote yes"} — Yes   ${no ?? "/vote no"} — No`, 10, 422, 8, "#eaea72");
  }
  setSpectator(targetSlot: number, targetName: string, observing: boolean): void {
    if (this.spectatorTargetSlot === targetSlot && this.spectatorTargetName === targetName && this.spectatorObserving === observing) return;
    this.spectatorTargetSlot = targetSlot; this.spectatorTargetName = targetName;
    this.spectatorObserving = observing;
    this.spectatorText = targetSlot > 0 ? `Following ${targetName || `Player ${targetSlot}`}` : "Free camera";
  }
  private refreshConsoleLog(): void {
    this.consoleLog.textContent = this.console.lines.map(line => line.text).join("\n");
    this.consoleRows.length = 0;
    this.context.save();
    this.context.font = `${9 * 96 / 72}px "${this.fontFamily}"`;
    for (const line of this.console.lines) {
      let row = "";
      for (const character of line.text) {
        if (row && this.context.measureText(row + character).width * 1.25 > Math.max(40, this.logicalWidth - 10)) {
          this.consoleRows.push({ ...line, text: row }); row = character;
        } else row += character;
      }
      this.consoleRows.push({ ...line, text: row });
    }
    this.context.restore();
  }
  roundChanged(): void {
    this.releaseVoice(); this.radioMenu = false; this.matchMenu = null;
    this.limbo.resetRound(); this.teamMenu = false; this.scroll = 0;
    this.chatNotice = ""; this.options.onInputCapture?.(this.gameplayCaptured);
  }
  openTeams(): void {
    if (!this.options.onTeamChange || this.suspended || this.inputActive) return;
    this.releaseVoice(); this.radioMenu = false; this.matchMenu = null;
    this.teamMenu = true; this.limbo.active = false;
    this.options.onInputCapture?.(true);
  }
  private weaponEnabled(index: number): boolean {
    return limboWeaponEnabled(index, this.options.weaponActive, this.options.weaponSelection) &&
      ((this.weaponMask & this.selectionMask) & (1 << index)) !== 0;
  }

  /** Explicit sandbox spawn commands can replace a living soldier in one tick. */
  spawned(): void { if (this.options.weaponsMenu) this.limbo.spawn(); }

  /** Show original limbo only; native weapon-choice/apply still owns life legality. */
  openWeapons(): void {
    if (!this.options.weaponsMenu || !this.limboPlayer || this.inputActive || this.limbo.active || this.teamMenu) return;
    this.releaseVoice(); this.radioMenu = false; this.matchMenu = null;
    this.limbo.active = true;
    this.chatNotice = "Choose weapons; changes apply when native spawn rules allow";
    this.chatNoticeUntil = this.lastTick + 180;
    this.options.onInputCapture?.(this.gameplayCaptured);
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (suspended) this.blur();
  }

  /** Hide the per-frame overlay for map-only/object-only gallery captures. */
  clear(): void {
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.raster?.clear();
  }

  /** Composite already-rendered buffers, never redraw the HUD for evidence. */
  captureTo(context: CanvasRenderingContext2D, width: number, height: number): void {
    context.drawImage(this.graphicsCanvas, 0, 0, width, height);
    context.drawImage(this.canvas, 0, 0, width, height);
  }

  private readonly resize = (): void => {
    if (this.destroyed) return;
    this.width = this.host.clientWidth;
    this.height = this.host.clientHeight;
    this.ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(this.width * this.ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * this.ratio));
    this.graphicsCanvas.width = this.canvas.width;
    this.graphicsCanvas.height = this.canvas.height;
    resizeCamera(this.viewport, this.width, this.height || 1);
    this.logicalWidth = this.viewport.width;
    const scaleX = this.width / this.logicalWidth, scaleY = this.height / 480;
    this.form.style.transform = `translate(${5 * scaleX}px,${408 * scaleY}px) scale(${scaleX},${scaleY})`;
    this.input.style.width = `${Math.max(100, this.logicalWidth - 205)}px`;
    this.refreshConsoleLog();
  };

  update(world: WorldView, localSlot: number, state: HudPresentation = EMPTY_PRESENTATION): void {
    if (this.destroyed || this.height <= 0) return;
    if (this.ratio !== (window.devicePixelRatio || 1)) this.resize();
    const c = this.context;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.raster.begin(this.graphicsCanvas.width, this.graphicsCanvas.height, this.logicalWidth);
    c.setTransform(this.width / this.logicalWidth * this.ratio, 0, 0, this.height / 480 * this.ratio, 0, 0);
    c.imageSmoothingEnabled = true;
    c.textBaseline = "top";
    const sx = this.logicalWidth / 640;
    const healthAnchor = this.pixelAlign(5 * sx, "x");
    const ammoAnchor = this.pixelAlign(275 * sx, "x");
    const jetAnchor = this.pixelAlign(480 * sx, "x");
    const barAnchorY = this.pixelAlign(439);
    const me = world.sprites.find(sprite => sprite.slot === localSlot && sprite.active);
    this.lastTick = world.tick;
    this.gameMode = state.gameMode ?? 0;
    this.weaponMask = state.enabledWeaponsMask ?? 0x3fff;
    this.selectionMask = state.availableWeaponsMask ?? 0x3fff;
    this.console.players = state.players ?? [];
    if (this.localTeam !== (me?.team ?? 0)) this.releaseVoice();
    this.localTeam = me?.team ?? 0;
    this.limboPlayer = !!me && me.team !== 5 && (state.roundPhase ?? 0) === 0;
    if (document.querySelector("dialog[open]") || this.gameplayCaptured || !me || (state.roundPhase ?? 0) !== 0) this.releaseVoice();
    if (this.options.weaponsMenu && this.limboPlayer && me && !state.rasterOnly)
      this.limbo.observe((me.flags & SPRITE_FLAGS.dead) !== 0, me.weapon, me.secondaryWeapon);
    if (!this.limboPlayer) this.limbo.active = false;
    if (me) {
      const gun = WEAPONS[me.weapon];
      const config = gun ? this.options.weapons[gun[1]] : undefined;
      if (me.team !== 5) {
        this.sprite("HEALTH", 5 * sx, 439);
        this.bar("HEALTH_BAR", healthAnchor + 40, barAnchorY + 10, me.health / (state.startHealth ?? 150));
        if (state.vest !== undefined && state.vest > 0)
          this.bar("VEST_BAR", healthAnchor + 40, barAnchorY + 20, state.vest / 100);
        this.sprite("AMMO", 275 * sx, 439);
        const capacity = state.ammoCapacity ?? config?.ammo;
        const reloadTime = state.reloadTime ?? config?.reloadtime;
        if (me.ammo === 0 && me.weapon !== 5 && reloadTime !== undefined && reloadTime > 0)
          this.bar("RELOAD_BAR", ammoAnchor + 77, barAnchorY + 10, 1 - (state.reloadReal ?? me.reload) / reloadTime);
        else if (me.ammo > 0 && capacity !== undefined && capacity > 0)
          this.bar("RELOAD_BAR", ammoAnchor + 77, barAnchorY + 10, me.ammo / capacity);
        if (!state.rasterOnly) {
          this.sprite("FIRE_BAR_R", 275 * sx + 127, 464);
          if (state.fireIntervalCount !== undefined && state.fireInterval !== undefined && state.fireInterval > 0)
            this.bar("FIRE_BAR", ammoAnchor + 134, barAnchorY + 25, (state.fireIntervalReal ?? state.fireIntervalCount) / state.fireInterval, false);
        }
        this.sprite("JET", 480 * sx, 439);
        const jetCapacity = state.startJet ?? this.options.startJet;
        if (jetCapacity > 0) this.bar("JET_BAR", jetAnchor + 40, barAnchorY + 10, me.fuel / jetCapacity);
        const nade = state.tertiaryWeapon === 51 ? "CLUSTER_NADE" : "NADE";
        const image = this.images.get(nade);
        if (image) for (let i = 1; i <= me.grenades; i++)
          this.sprite(nade, 275 * sx + 33 + image.width * i, 462);
        if (!state.rasterOnly && (me.flags & SPRITE_FLAGS.dead) === 0) {
          this.text(String(me.ammo), 275 * sx + 73, 451, 12, "#f2f428", "right");
          if (gun) this.text(gun[0], 275 * sx + 10, 454, 8, "#fff5b1", "right");
        }
      }
      if (state.rasterOnly) { this.raster.finish(); return; }
      this.status(state, localSlot, sx);
      this.ping(state.ping ?? state.players?.find(player => player.slot === localSlot)?.ping, sx);
    }
    const pointer = this.options.pointer;
    const dialog = document.querySelector("dialog[open]") !== null;
    const customCursor = !!me && !!pointer && !state.rasterOnly && !this.inputActive && !dialog && !this.suspended;
    this.host.style.cursor = customCursor ? "none" : this.previousCursor;
    if (this.limbo.active && !this.teamMenu && !this.matchMenu && !this.radioMenu && !this.inputActive && !dialog && !this.suspended) this.drawLimbo();
    if (this.teamMenu && !dialog && !this.suspended) this.drawTeams();
    if (!this.inputActive && !dialog && !this.suspended) this.drawFeatures();
    if (customCursor && me && pointer) {
      const x = pointer.pointerX / this.width * this.logicalWidth;
      const y = pointer.pointerY / this.height * 480;
      const menuCursor = this.gameplayCaptured || (state.roundPhase ?? 0) !== 0 || (me.flags & SPRITE_FLAGS.dead) !== 0 || me.team === 5;
      const asset = this.images.get(menuCursor ? "MENUCURSOR" : "CURSOR");
      if (asset) {
        const gun = WEAPONS[me.weapon];
        const movement = gun ? this.options.weapons[gun[1]]?.movementacc ?? 0 : 0;
        const sniperLine = !menuCursor && this.options.sniperLine === true && state.sniperLine === true;
        const scale = menuCursor ? 1 : cursorScale(cursorMoveAccuracy(me, movement), state.hitSprayCounter ?? 0, sniperLine);
        const camera = this.options.camera;
        let target: WorldSprite | undefined;
        if ((!menuCursor || (this.spectatorObserving && !this.teamMenu && !this.limbo.active)) && camera) {
          worldAt(camera, pointer.pointerX, pointer.pointerY, this.width, this.height, this.aim);
          const observer = world.sprites.find(sprite => sprite.slot === (this.options.observerSlot?.() ?? localSlot)) ?? me;
          target = cursorTarget(world, observer, this.aim.x, this.aim.y, state.realistic === true && me.team !== 5);
          if (sniperLine) this.drawSight(me, camera, x, y);
        }
        if (target) {
          const friendly = me.team > 0 && me.team < 5 && target.team === me.team;
          this.raster.tint = friendly ? 0x33ff33 : 0xff3333;
          const name = state.players?.find(player => player.slot === target!.slot)?.name;
          if (name && this.options.playerNames !== false)
            this.text(friendly ? `${name} ${Math.round(target.health / (state.startHealth ?? 150) * 100)}%` : name, x, y + 10, 8, "#ffffff77", "center");
        }
        // Native cursor sprites are output-pixel sized, unlike the scaled interface.
        const width = asset.width * scale / (this.width / this.logicalWidth);
        const height = asset.height * scale / (this.height / 480);
        this.sprite(menuCursor ? "MENUCURSOR" : "CURSOR", x - (menuCursor ? 0 : width / 2),
          y - (menuCursor ? 0 : height / 2), width, height, target ? 150 / 255 : sniperLine ? 100 / 255 : 200 / 255);
        this.raster.tint = 0xffffff;
      }
    }
    this.teamBox(state, sx);
    this.killFeed(world.tick, state, sx);
    const consoleNow = Date.now(), latestLine = this.consoleRows.at(-1);
    // Native chat owns the top-left; supplemental mode/objective captions sit below it.
    const captionTop = latestLine && consoleNow - latestLine.at <= 10000 ? COMPACT_CONSOLE_LINES * CONSOLE_LINE_HEIGHT + 6 : 0;
    if (!this.inputActive) {
      if (!this.matchMenu && !this.radioMenu) {
        this.objectiveStatus(world, state, captionTop);
        this.matchStatus(world, state, me, captionTop);
      }
    }
    if (this.options.playerNames && this.options.camera && !this.teamMenu) this.playerNames(world, state, me);
    if (this.scoreboard || (state.roundPhase ?? 0) > 0) this.drawScoreboard(world, state, localSlot);
    if (this.spectatorObserving && !this.inputActive && this.console.controls.vote?.phase !== "active") {
      const canFree = me?.team === 5 || !state.realistic;
      this.text(this.spectatorTargetSlot === 0 && !canFree ? "Choose a teammate to follow" : this.spectatorText, this.logicalWidth / 2, 365, 9, "#ffe6aa", "center");
      this.text(!canFree ? "Fire / Jet: next / previous teammate" : this.spectatorTargetSlot === 0
        ? "Mouse: pan · Fire / Jet: follow · F2: change team"
        : "Fire / Jet: next / previous · Jump: free camera · F2: change team", this.logicalWidth / 2, 382, 8, "#a5e6ff", "center");
    }
    if (this.chatNotice && world.tick <= this.chatNoticeUntil)
      this.text(this.chatNotice, 5, this.console.controls.vote?.phase === "active" ? 362 : 400, 9, "#ffe6aa");
    this.drawConsole(consoleNow);
    if (!this.inputActive && !this.scoreboard && (state.roundPhase ?? 0) === 0) this.drawVote(consoleNow);
    this.raster.finish();
  }

  private drawSight(me: WorldSprite, camera: Camera, x: number, y: number): void {
    const image = this.images.get("SIGHT");
    if (!image) return;
    screenAt(camera, me.current[28]!, me.current[29]!, this.logicalWidth, 480, this.projected);
    const dx = x - this.projected.x, dy = y - this.projected.y, distance = Math.hypot(dx, dy);
    if (distance >= 1200) return;
    this.raster.globalAlpha = clamp(distance / 240 * (this.width / this.logicalWidth) * 32 / 255);
    this.raster.drawRotatedImage(image.image, this.projected.x - 1, this.projected.y - 1,
      image.width * distance / 240, image.height * distance / 480, Math.atan2(dy, dx));
    this.raster.globalAlpha = 1;
  }

  private playerNames(world: WorldView, state: HudPresentation, me: WorldSprite | undefined): void {
    if (!me || me.team === 0) return;
    const camera = this.options.camera!, spectator = me.team === 5;
    for (const player of state.players ?? []) {
      const sprite = world.sprites[player.slot - 1];
      if (!sprite?.active || player.slot === me.slot || player.team < 1 || player.team > 4 ||
        (!spectator && player.team !== me.team)) continue;
      screenAt(camera, sprite.current[12]!, sprite.current[13]!, this.logicalWidth, 480, this.projected);
      this.projected.y += (spectator ? 20 : 5) / Math.max(1, camera.z);
      if (!spectator && this.projected.x >= 0 && this.projected.x <= this.logicalWidth &&
        this.projected.y >= 0 && this.projected.y <= 480) continue;
      const name = player.name ?? "";
      this.context.save();
      this.context.font = `${9 * 96 / 72}px "${this.fontFamily}"`;
      const width = this.context.measureText(name).width * 1.25;
      this.context.restore();
      const dx = Math.max(1, Math.abs(me.current[12]! - sprite.current[12]!));
      const dy = Math.max(1, Math.abs(me.current[13]! - sprite.current[13]!));
      const alpha = Math.min(255, 50 + Math.round(100000 / (dx + dy / 2))).toString(16).padStart(2, "0");
      const carrying = state.objectives?.some(objective => objective.active && objective.style < 4 && objective.holder === player.slot);
      const color = carrying ? "#dcdc33" : (sprite.flags & SPRITE_FLAGS.dead) !== 0 ? "#983333" : "#99df99";
      this.text(name, Math.max(width / 2, Math.min(this.logicalWidth - width / 2, this.projected.x)),
        Math.max(0, Math.min(464, this.projected.y)), 9, color + alpha, "center");
    }
  }

  private objectiveStatus(world: WorldView, state: HudPresentation, top: number): void {
    let row = 0;
    for (const objective of state.objectives ?? []) {
      if (!objective.active || objective.style === 15) continue;
      const holder = objective.holder > 0 ? state.players?.find(player => player.slot === objective.holder) : undefined;
      const label = objective.style === 3 ? "Yellow flag" : state.gameMode === 5
        ? (objective.style === 1 ? "White flag" : "Black flag") : objective.style === 1 ? "Alpha flag" : "Bravo flag";
      const status = objective.holder > 0 ? holder?.name ?? `Slot ${objective.holder}` :
        objective.inBase ? "at base" : objective.style === 3 ? "on map" : "dropped";
      this.text(`${label}: ${status}`, 5, top + 88 + row++ * 14, 8, objective.style === 3 ? "#f2f428" : TEAM_COLORS[objective.style]);
    }
    if (state.gameMode === 4) {
      const rambo = world.sprites.find(player => player.active && (player.flags & SPRITE_FLAGS.dead) === 0 &&
        (player.weapon === 15 || player.weapon === 16 || player.secondaryWeapon === 15 || player.secondaryWeapon === 16));
      const name = rambo ? state.players?.find(player => player.slot === rambo.slot)?.name ?? `Slot ${rambo.slot}` : undefined;
      if (name) this.text(`Rambo: ${name}`, 5, top + 88, 8, "#f2f428");
      else if (state.objectives?.some(objective => objective.style === 15 && objective.active))
        this.text("Rambo bow: on map", 5, top + 88, 8, "#f2f428");
    }
  }

  private matchStatus(world: WorldView, state: HudPresentation, me: WorldSprite | undefined, top: number): void {
    this.text(MODE_NAMES[state.gameMode ?? 0] ?? "Match", 5, top + 6, 9, "#e9b40c");
    this.text(MODE_OBJECTIVES[state.gameMode ?? 0] ?? "", 5, top + 22, 7, "#fff5b1");
    const bits = Number(state.realistic) | Number(state.survival) << 1 | Number(state.advance) << 2 |
      Number(state.tickScale !== undefined && state.tickScale < 1) << 3;
    if (bits !== this.ruleBits) {
      this.ruleBits = bits;
      this.ruleText = `${state.realistic ? "Realistic · " : ""}${state.survival ? "Survival · " : ""}${state.advance ? "Advance · " : ""}${bits & 8 ? "Bullet time · " : ""}`.slice(0, -3);
    }
    if (this.ruleText) this.text(this.ruleText, 5, top + 36, 7, "#aaa0c8");
    if (state.timeLeftSeconds !== undefined)
      this.text(`${Math.floor(state.timeLeftSeconds / 60)}:${String(state.timeLeftSeconds % 60).padStart(2, "0")}`, this.logicalWidth / 2, 6, 9, "#aaa0c8", "center");
    if ((state.roundPhase ?? 0) > 0) {
      const countdown = Math.max(0, Math.ceil((state.mapChangeCounter ?? 0) / 60));
      this.text(state.roundPhase === 2 ? "Loading next round…" : `Round complete · Next round in ${countdown}`,
        this.logicalWidth / 2, 404, 12, "#73ff64", "center");
      return;
    }
    if (me?.team === 5) return;
    if (me && state.survival) {
      let alive = 0;
      for (const player of world.sprites)
        if (player.active && player.team !== 5 && (player.flags & SPRITE_FLAGS.dead) === 0 &&
          (!(me.team > 0 && me.team < 5) || player.team === me.team)) alive++;
      const message = state.survivalEndRound
        ? ((me.flags & SPRITE_FLAGS.dead) === 0 ? "You have survived" : `End of round… ${((state.respawnCounter ?? 0) / 60).toFixed(1)}`)
        : `${alive} ${me.team > 0 ? "team players" : "players"} left`;
      this.text(message, this.logicalWidth / 2, 52, 9, "#73ff64", "center");
      if (me.ceaseFireCounter > 0)
        this.text(`Round starts in ${Math.ceil(me.ceaseFireCounter / 60)}`, this.logicalWidth / 2, 70, 12, "#73ff64", "center");
    } else if ((state.respawnCounter ?? 0) > 0 && me && (me.flags & SPRITE_FLAGS.dead) !== 0) {
      this.text(`Respawn in… ${(state.respawnCounter! / 60).toFixed(1)}`, this.logicalWidth / 2, 52, 12, "#ff4137", "center");
    }
    if ((state.bonusTime ?? 0) > 0) {
      const bonus = state.bonusStyle === 18 ? "Flame god" : state.bonusStyle === 19 ? "Predator" : state.bonusStyle === 21 ? "Berserker" : undefined;
      if (bonus) this.text(`${bonus} ${Math.ceil(state.bonusTime! / 60)}`, 5, 390, 9, "#fff5b1");
    }
  }

  private teamAllowed(team: number): boolean {
    return team === 5 || (TEAM_MODES.includes(this.gameMode) ? team >= 1 && team <= (this.gameMode === 2 ? 4 : 2) : team === 0);
  }
  private drawTeams(): void {
    this.sprite("BACK", 45, 140, 252, 180, 0.56);
    this.text("Change team", 65, 148, 12, "#eaeaea");
    let row = 0;
    for (let team = 0; team <= 5; team++) if (this.teamAllowed(team))
      this.text(`${team + 1} ${TEAM_NAMES[team]}`, 65, 178 + row++ * 22, 9, TEAM_COLORS[team]);
    this.text("Escape: cancel", 65, 300, 8, "#fff5b1");
  }
  private chooseTeam(team: number): void {
    if (!this.teamAllowed(team)) return;
    try { this.options.onTeamChange?.(team); this.teamMenu = false; }
    catch (error) { this.chatNotice = String(error); this.chatNoticeUntil = this.lastTick + 180; }
    this.options.onInputCapture?.(this.gameplayCaptured);
  }

  private drawLimbo(): void {
    this.sprite("BACK", 45, 140, 252, 210, 0.56);
    this.sprite("BACK", 45, 350, 252, 80, 0.56);
    this.text("Primary Weapon:", 65, 142, 9, "#eaeaea");
    this.text("Secondary Weapon:", 65, 337, 9, "#d6d6d6");
    const pointer = this.options.pointer;
    this.menuHover = pointer ? limboHitIndex(pointer.pointerX / this.width * this.logicalWidth, pointer.pointerY / this.height * 480) : -1;
    for (let i = 0; i < LIMBO_WEAPONS.length; i++) {
      if (!this.weaponEnabled(i)) continue;
      const weapon = LIMBO_WEAPONS[i]!, image = this.images.get(`GUNS_${weapon.image}`);
      const selected = this.limbo.selected(i), hover = this.menuHover === i;
      const imageY = i < 10 ? 157 + 18 * i : 157 + 18 * (i + 1);
      if (image) this.sprite(`GUNS_${weapon.image}`, 55, imageY + Math.max(0, 18 - image.height) / 2,
        undefined, undefined, i < 10 || selected ? 1 : 0.5);
      const caption = i < 10 ? `${(i + 1) % 10} ${weapon.name}` : weapon.name;
      this.text(caption, 120 + (!selected && hover ? 1 : 0), limboRowY(i) + 6 - (!selected && hover ? 1 : 0),
        9, selected ? (hover ? "#556937" : "#37a537") : "#ffffff");
    }
    this.text("Ctrl+1–4: secondary · 1–0: primary", 45, 112, 8, "#ffffe6");
    this.text(this.options.weaponChoiceNotice ?? "Choices apply on next respawn", 45, 125, 8, "#ffffe6");
  }

  private chooseWeapon(index: number): void {
    if (!this.weaponEnabled(index)) return;
    const weapon = LIMBO_WEAPONS[index]!;
    try {
      if (!this.options.onWeaponChoice) throw new Error("Weapon selection unavailable");
      this.options.onWeaponChoice(index < 10 ? weapon.num : this.limbo.primary, index >= 10 ? weapon.num : this.limbo.secondary, index < 10 ? "primary" : "secondary");
      this.limbo.choose(index);
      if (index >= 10 && !LIMBO_WEAPONS.some((_, i) => i < 10 && this.weaponEnabled(i)))
        this.limbo.active = false;
      this.chatNotice = "Weapon choice selected";
    } catch (error) {
      this.chatNotice = error instanceof Error ? error.message : String(error);
    }
    this.chatNoticeUntil = this.lastTick + 360;
    this.options.onInputCapture?.(this.gameplayCaptured);
  }

  private readonly menuMouseDown = (event: MouseEvent): void => {
    if (this.suspended || this.matchMenu || this.radioMenu || (!this.limbo.active && !this.teamMenu) || this.inputActive || event.button !== 0 || document.querySelector("dialog[open]")) return;
    if (!(event.target instanceof HTMLCanvasElement) || !this.host.contains(event.target)) return;
    const rect = this.host.getBoundingClientRect();
    event.target.focus({ preventScroll: true });
    if (this.teamMenu) {
      const x = (event.clientX - rect.left) / rect.width * this.logicalWidth;
      const y = (event.clientY - rect.top) / rect.height * 480;
      event.preventDefault(); event.stopImmediatePropagation();
      let row = 0;
      for (let team = 0; team <= 5; team++) if (this.teamAllowed(team)) {
        if (x >= 45 && x <= 297 && y >= 178 + row * 22 && y < 200 + row * 22) { this.chooseTeam(team); return; }
        row++;
      }
      return;
    }
    const index = limboHitIndex((event.clientX - rect.left) / rect.width * this.logicalWidth, (event.clientY - rect.top) / rect.height * 480);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (index >= 0) this.chooseWeapon(index);
    else { this.limbo.active = false; this.options.onInputCapture?.(this.gameplayCaptured); }
  };

  /** InterfaceGraphics PixelAlign: snap in output pixels, not logical units. */
  private pixelAlign(value: number, axis: "x" | "y" = "y"): number {
    const scale = (axis === "x" ? this.width / this.logicalWidth : this.height / 480) * this.ratio;
    return Math.floor(value * scale) / scale;
  }

  private sprite(name: string, x: number, y: number, width?: number, height?: number, alpha = 1): void {
    const asset = this.images.get(name);
    if (!asset) return;
    this.raster.globalAlpha = alpha;
    this.raster.drawImage(asset.image, this.pixelAlign(x, "x"), this.pixelAlign(y), width ?? asset.width, height ?? asset.height);
    this.raster.globalAlpha = 1;
  }

  private bar(name: string, x: number, y: number, progress: number, left = true): void {
    const asset = this.images.get(name);
    if (!asset) return;
    const p = clamp(progress);
    if (p <= 0) return;
    // Native RenderBar crops the original image; it never stretches a full bar.
    const sourceX = left ? 0 : asset.image.naturalWidth * (1 - p);
    this.raster.drawImage(asset.image, sourceX, 0, asset.image.naturalWidth * p,
      asset.image.naturalHeight, x, y, asset.width * p, asset.height);
  }

  private text(value: string, x: number, y: number, size = 9, color = "#ffffe6", align: CanvasTextAlign = "left"): void {
    const c = this.context;
    c.save();
    // Gfx.RequestFontSize converts points at 96 DPI; Cvar default stretches
    // FONT_MENU 150% and FONT_SMALL/WEAPONS_MENU 125% horizontally.
    const stretch = size === 12 ? 1.5 : 1.25;
    c.font = `${size * (96 / 72)}px "${this.fontFamily}"`;
    let textX = x;
    if (align !== "left") {
      const metrics = c.measureText(value);
      const width = (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) * stretch;
      textX -= align === "right" ? width : width / 2;
    }
    c.translate(this.pixelAlign(textX, "x"), this.pixelAlign(y));
    c.scale(stretch, 1);
    c.fillStyle = color;
    c.textAlign = "left";
    c.shadowColor = "#000";
    c.shadowBlur = 0;
    c.shadowOffsetX = 1;
    c.shadowOffsetY = 1;
    c.fillText(value, 0, 0);
    c.restore();
  }

  private status(state: HudPresentation, slot: number, sx: number): void {
    const players = state.players;
    const me = players?.find(player => player.slot === slot);
    if (players && me?.kills !== undefined) {
      let rank = 0, count = 0, best = me.kills, second = me.kills;
      for (const player of players) if (player.team !== 5 && player.kills !== undefined) {
        count++;
        if (count === 1) best = player.kills;
        if (count === 2) second = player.kills;
        if (player.slot === slot) rank = count;
      }
      if (rank > 0) this.text(`${rank}/${count}`, 575 * sx, 421, 9, "#58ff5a");
      const difference = me.kills - (rank === 1 && count > 1 ? second : best);
      this.text(`${me.kills} (${difference > 0 ? "+" : ""}${difference})`, 575 * sx, 431, 9, "#ff3732");
    } else this.text("Score unavailable", 575 * sx, 421, 7, "#b4b4b4");
    this.text(shown(state.killLimit), 575 * sx, 441, 9, "#7278ff");
  }

  private teamBox(state: HudPresentation, sx: number): void {
    if (![2, 3, 5, 6].includes(state.gameMode ?? -1)) return;
    const x = 575 * sx;
    this.sprite("BACK", x, 330, 57, 88, 0.56);
    const count = state.gameMode === 2 ? 4 : 2;
    this.teamOrder.length = count;
    for (let i = 0; i < count; i++) this.teamOrder[i] = i + 1;
    if (state.teamScores) this.teamOrder.sort((a, b) => state.teamScores![b]! - state.teamScores![a]!);
    // Game.SortPlayers uses native ui_status_transparency=200 in team colors.
    const colors = ["", "#d20f05c8", "#050fd2c8", "#d2d205c8", "#05d205c8"];
    for (let i = 0; i < count; i++) {
      const team = this.teamOrder[i]!;
      this.text(shown(state.teamScores?.[team]), x + 2,
        (count === 4 ? 330 : 355) + (count === 4 ? 24 : 40) * i, 12, colors[team]);
    }
  }

  private ping(value: number | undefined, sx: number): void {
    if (value === undefined) { this.text("Ping unavailable", 600 * sx, 18, 7, "#b4b4b4", "right"); return; }
    const asset = this.images.get("DOT");
    if (!asset) return;
    // Source ping-dot scale, color thresholds and alpha (InterfaceGraphics 2418).
    const image = this.pingTints[Math.min(7, Math.max(0, Math.ceil(value / 50) - 1))];
    if (!image) return;
    const c = this.raster;
    c.globalAlpha = clamp(value / 255);
    c.drawImage(image, 600 * sx, 18, asset.width * (0.5 + value / 600), asset.height * (0.45 + value / 600));
    c.globalAlpha = 1;
  }

  private killFeed(tick: number, state: HudPresentation, sx: number): void {
    if (!state.killFeedAvailable) {
      this.text("Kill feed unavailable", 595 * sx, 60, 7, "#b4b4b4", "right");
      return;
    }
    let lines = 0, separation = 0;
    const events = state.killEvents;
    if (!events) return;
    for (let i = Math.max(0, events.length - 5); i < events.length; i++) {
      const event = events[i]!;
      if (tick - event.tick > 600 || event.tick > tick) continue;
      const gun = WEAPONS[event.weapon];
      const icon = event.killBullet === undefined
        ? (gun ? `GUNS_${gun[2]}` : undefined) : KILL_ICONS[event.killBullet];
      if (icon) separation += 8;
      const y = 60 + lines * 10 + separation;
      const killer = event.killerKills === undefined ? event.killer : `${event.killer} (${event.killerKills})`;
      this.text(killer, 595 * sx, y, killer.length > 14 ? 7 : 8,
        event.suicide ? "#d3b727" : KILLER_COLORS[event.killerTeam ?? 0], "right");
      if (!event.suicide) this.text(event.victim, 595 * sx, y + 10,
        event.victim.length > 14 ? 7 : 8, VICTIM_COLORS[event.victimTeam ?? 0], "right");
      if (icon) {
        const image = this.images.get(icon);
        if (image) this.sprite(icon, 605 * sx, y - 1, image.width * 0.8, image.height * 0.8);
      }
      lines += event.suicide ? 1 : 2;
    }
  }

  private drawScoreboard(world: WorldView, state: HudPresentation, localSlot: number): void {
    const x = Math.floor(this.logicalWidth / 2 - 300) - 25;
    const players = state.players;
    let count = 0;
    for (const sprite of world.sprites) if (sprite.active) count++;
    const rows = players?.length ?? count;
    let groups = 0;
    if (state.gameMode !== undefined && [2, 3, 5, 6].includes(state.gameMode) && players)
      for (let team = 0; team <= 5; team++) if (players.some(player => player.team === team)) groups++;
    const bottom = 70 + (rows + 1) * 20 + groups * 15;
    const maxScroll = Math.max(0, Math.ceil((bottom - 400) / 20));
    this.scroll = Math.min(this.scroll, maxScroll);
    const y = -this.scroll * 20;
    this.sprite("BACK", x + 25, y + 5, 590, bottom, 112 / 255);
    this.context.save();
    this.context.beginPath();
    this.context.rect(x + 25, 5, 590, 395);
    this.context.clip();
    this.text(state.serverName ?? "Server name unavailable", x + 30, y + 15, 9, "#e9b40c");
    this.text(state.serverInfo ?? "", x + 30, y + 30, 9, "#c89600");
    this.text(`Players ${rows}`, x + 330, y + 15, 9, "#c8beb4");
    const remaining = state.timeLeftSeconds;
    this.text(remaining === undefined ? "No time limit" : `Time ${Math.floor(remaining / 60)}:${String(Math.max(0, remaining % 60)).padStart(2, "0")}`, x + 485, y + 15, 9, "#aaa0c8");
    this.text(state.gameMode === 0 || state.gameMode === 2 ? "Kills:" : "Points:", x + 280, y + 40, 12);
    this.text("Deaths:", x + 390, y + 40, 12);
    this.text("Ping:", x + 530, y + 40, 12);
    let row = 0;
    let accessible = "Player\tKills / points\tDeaths\tPing\n";
    const renderPlayer = (player: HudPlayer): void => {
      const py = y + (groups > 0 ? 60 : 80) + row++ * 20;
      const color = player.shirtColor === undefined ? TEAM_COLORS[player.team] : `#${(player.shirtColor & 0xffffff).toString(16).padStart(6, "0")}`;
      this.text(player.name ?? `Slot ${player.slot} (name unavailable)`, x + 44, py, 9, color);
      this.text(shown(player.kills), x + 284, py, 9, color);
      this.text(shown(player.deaths), x + 394, py, 9, color);
      if (!player.bot) this.text(shown(player.ping), x + 534, py, 9, color);
      if (player.flags) this.text(`x${player.flags}`, x + 348, py, 9, color);
      if (player.dead) this.sprite("DEADDOT", x + 30, py + 1, undefined, undefined, 200 / 255);
      if (player.slot === localSlot) this.sprite("SMALLDOT", x + 31, py + 1, undefined, undefined, 200 / 255);
      if (player.bot) this.sprite("BOT", x + 534, py, undefined, undefined, 200 / 255);
      accessible += `${player.name ?? `Slot ${player.slot}`}\t${shown(player.kills)}\t${shown(player.deaths)}\t${player.bot ? "bot" : shown(player.ping)}\n`;
    };
    if (players) {
      if (groups > 0) {
        for (const team of [1, 2, 3, 4, 0, 5]) {
          if (!players.some(player => player.team === team)) continue;
          this.text(TEAM_NAMES[team]!, x + 35, y + 60 + row++ * 20, 9, TEAM_COLORS[team]);
          for (const player of players) if (player.team === team) renderPlayer(player);
        }
      } else for (const player of players) renderPlayer(player);
    } else {
      for (const sprite of world.sprites) if (sprite.active)
        renderPlayer({ slot: sprite.slot, team: sprite.team, dead: (sprite.flags & SPRITE_FLAGS.dead) !== 0 });
    }
    this.context.restore();
    if (maxScroll > 0) this.sprite("SCROLL", x + 580, 240);
    // Accessibility DOM is updated only when visible content actually changes.
    if (accessible !== this.scoreboardText) {
      this.scoreboardText = accessible;
      this.accessible.textContent = accessible;
    }
  }

  private drawConsole(now: number): void {
    const c = this.context, lines = this.consoleRows;
    const limit = this.inputActive ? 20 : COMPACT_CONSOLE_LINES;
    if (this.inputActive) {
      c.fillStyle = "#000000b8";
      c.fillRect(0, 0, this.logicalWidth, 428);
    }
    c.save();
    c.beginPath(); c.rect(0, 0, this.logicalWidth, 405); c.clip();
    let row = 0;
    const end = Math.max(0, lines.length - this.consoleScroll);
    for (let i = Math.max(0, end - limit); i < end; i++) {
      const line = lines[i]!;
      if (!this.inputActive && now - line.at > 10000) continue;
      this.text(line.text, 5, 5 + row++ * CONSOLE_LINE_HEIGHT, 9, line.color);
    }
    c.restore();
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || this.suspended || document.hidden || event.isComposing || document.querySelector("dialog[open]")) { this.releaseVoice(); return; }
    const target = event.target ?? document.activeElement;
    const outsideEditor = target instanceof Element && !this.root.contains(target) &&
      target.closest('input, textarea, select, button, dialog, [contenteditable]:not([contenteditable="false"])');
    if (outsideEditor) { this.releaseVoice(); return; }
    if (this.inputActive) {
      this.releaseVoice();
      if (event.code === "Escape" || (event.code === "Backspace" && this.input.value === "/")) {
        event.preventDefault(); this.closeChat();
      } else if ((event.code === "Enter" || event.code === "NumpadEnter") && !event.repeat) {
        event.preventDefault(); this.sendEntry();
      } else if (event.code === "ArrowUp" || event.code === "ArrowDown") {
        event.preventDefault();
        this.input.value = this.console.history.move(event.code === "ArrowUp" ? -1 : 1, this.input.value);
        this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      } else if (event.code === "PageUp" || event.code === "PageDown") {
        event.preventDefault();
        this.consoleScroll = Math.max(0, Math.min(Math.max(0, this.consoleRows.length - 20),
          this.consoleScroll + (event.code === "PageUp" ? 10 : -10)));
      } else if (event.key === "/" && this.input.value === "/" && this.console.history.entries.length) {
        event.preventDefault();
        this.input.value = this.console.history.entries.at(-1)!;
        this.chatChannel = this.lastChatChannel;
        this.inputLabel.firstChild!.textContent = this.chatChannel === "team" ? "Team:" : "Say:";
        this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      }
      this.concealCredential();
      // Preserve browser editing shortcuts, but never leak input into a gameplay listener.
      event.stopImmediatePropagation();
      return;
    }
    if (this.radioMenu || this.matchMenu) {
      event.preventDefault(); event.stopImmediatePropagation();
      this.releaseVoice();
      if (event.repeat) return;
      if (event.code === "Escape") { this.closeFeatureMenu(); return; }
      if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      const number = /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(5)) : 0;
      if (this.matchMenu) {
        if (number) {
          try { this.menuChoice(number - 1); }
          catch (error) { this.consoleNotice(`Error: ${error instanceof Error ? error.message : String(error)}`); }
        }
      } else if (number >= 1 && number <= 3) {
        if (!this.radioCategory) this.radioCategory = number as 1 | 2 | 3;
        else {
          try {
            if (!this.options.onFeature) throw new Error("Radio is unavailable in this session");
            this.options.onFeature({ type: "radio", category: this.radioCategory, direction: number as 1 | 2 | 3 });
          } catch (error) { this.consoleNotice(`Error: ${error instanceof Error ? error.message : String(error)}`); }
          this.closeFeatureMenu();
        }
      }
      return;
    }
    if (this.teamMenu) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.code === "Escape") { this.teamMenu = false; this.options.onInputCapture?.(this.gameplayCaptured); }
      else if (!event.repeat && /^Digit[1-6]$/.test(event.code)) this.chooseTeam(Number(event.code.slice(5)) - 1);
      return;
    }
    const settings = this.console.settings;
    const binding = Object.keys(settings.commandBindings).find(key => bindingMatches(key, event));
    const command = binding ? settings.commandBindings[binding] : undefined;
    if (command === "+weapons" && this.options.weaponsMenu && this.limboPlayer) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) {
        this.releaseVoice();
        this.limbo.toggle();
        this.chatNotice = this.limbo.locked ? "Weapons menu disabled" : "Weapons menu active";
        this.chatNoticeUntil = this.lastTick + 180;
        this.options.onInputCapture?.(this.gameplayCaptured);
      }
      return;
    }
    if (this.limbo.active) {
      const index = limboKeyIndex(event.code, event.ctrlKey, event.shiftKey, event.altKey, event.metaKey);
      if (index >= 0) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) this.chooseWeapon(index);
        return;
      }
    }
    if (command) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      if (command === "+chat") this.openChat("public");
      else if (command === "+radio") this.openRadio();
      else if (command === "+matchcontrols") this.openMatchControls();
      else if (command === "+voicechat") {
        if (this.gameplayCaptured || this.scoreboard || this.console.controls.paused || this.console.controls.muted) return;
        if (!settings.voice.enabled) { this.setVoiceStatus("Voice disabled; enable it in settings"); return; }
        if (!this.options.onVoiceTransmit) { this.setVoiceStatus("Voice unavailable in this session"); return; }
        this.voiceKey = event.code; this.voiceBinding = binding!;
        this.options.onVoiceTransmit(true);
      } else if (command === "+teamchat") {
        if (TEAM_MODES.includes(this.gameMode) || this.localTeam === 5)
          this.openChat("team");
        else this.consoleNotice("Team chat is only available to teams and spectators");
      } else if (command === "+cmd") this.openChat("public", true);
      else if (command === "+statsmenu") this.openTeams();
      else if (command === "+fragslist") {
        this.releaseVoice();
        this.scoreboard = true; this.scoreboardKey = event.code; this.accessible.hidden = false;
      } else if (!this.limbo.active) {
        void this.console.execute(command).then(() => this.refreshConsoleLog());
      }
      return;
    }
    const taunt = tauntForKey(settings.taunts, event, { paused: this.suspended || this.console.controls.paused, editing: this.inputActive, overlay: this.limbo.active || this.teamMenu });
    if (taunt) {
      event.preventDefault(); event.stopImmediatePropagation();
      try { this.console.sendChat(taunt.channel, taunt.text); }
      catch (error) { this.consoleNotice(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };

  private readonly keyUp = (event: KeyboardEvent): void => {
    if (this.voiceKey && (event.code === this.voiceKey || !bindingMatches(this.voiceBinding, { code: this.voiceKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey }))) {
      const trigger = event.code === this.voiceKey;
      this.releaseVoice();
      if (trigger) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
    if (this.scoreboard && event.code === this.scoreboardKey) { this.scoreboard = false; this.accessible.hidden = true; }
    if (this.inputActive) event.stopImmediatePropagation();
  };
  private readonly boundMouseDown = (event: MouseEvent): void => {
    if (this.gameplayCaptured || this.suspended) {
      if (this.radioMenu || this.matchMenu) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    const target = document.pointerLockElement ?? event.target;
    if (!(target instanceof Element) || !this.host.contains(target)) return;
    const key = new KeyboardEvent("keydown", {
      code: `Mouse${event.button}`, ctrlKey: event.ctrlKey, altKey: event.altKey,
      shiftKey: event.shiftKey, metaKey: event.metaKey, cancelable: true,
    });
    this.keyDown(key);
    if (key.defaultPrevented) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private readonly boundMouseUp = (event: MouseEvent): void => {
    if (this.voiceKey === `Mouse${event.button}`) { this.releaseVoice(); event.preventDefault(); event.stopImmediatePropagation(); }
    if (this.scoreboard && this.scoreboardKey === `Mouse${event.button}`) {
      this.scoreboard = false; this.accessible.hidden = true;
    }
  };
  private readonly wheel = (event: WheelEvent): void => {
    if (!this.scoreboard) return;
    event.preventDefault();
    this.scroll = Math.max(0, this.scroll + Math.sign(event.deltaY));
  };
  private readonly submit = (event: SubmitEvent): void => {
    event.preventDefault();
    this.sendEntry();
  };
  private sendEntry(): void {
    if (this.input.value.trim()) this.lastChatChannel = this.chatChannel;
    void this.console.submit(this.input.value, this.chatChannel).then(() => this.refreshConsoleLog());
    this.closeChat();
  }
  private openChat(channel: ChatChannel, command = false): void {
    this.releaseVoice(); this.radioMenu = false; this.matchMenu = null;
    this.chatChannel = channel;
    this.consoleScroll = 0;
    this.console.history.reset();
    this.focusedBeforeChat = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (document.pointerLockElement) document.exitPointerLock();
    this.form.hidden = false;
    this.form.style.display = "flex";
    this.inputLabel.firstChild!.textContent = command ? "Cmd:" : channel === "team" ? "Team:" : "Say:";
    this.input.value = command ? "/" : "";
    this.input.type = "text";
    this.input.focus();
    this.options.onInputCapture?.(true);
  }
  private closeChat(): void {
    this.form.hidden = true;
    this.form.style.display = "none";
    this.input.value = "";
    this.input.type = "text";
    this.options.onInputCapture?.(this.gameplayCaptured);
    this.focusedBeforeChat?.focus({ preventScroll: true });
    this.focusedBeforeChat = null;
  }
  private readonly blur = (): void => {
    this.releaseVoice(); this.closeFeatureMenu();
    this.scoreboard = false;
    this.accessible.hidden = true;
    if (this.inputActive) this.closeChat();
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseVoice();
    this.observer.disconnect();
    window.removeEventListener("keydown", this.keyDown, true);
    window.removeEventListener("keyup", this.keyUp, true);
    window.removeEventListener("mousedown", this.menuMouseDown, true);
    window.removeEventListener("mousedown", this.boundMouseDown, true);
    window.removeEventListener("mouseup", this.boundMouseUp, true);
    window.removeEventListener("blur", this.blur);
    window.removeEventListener("pagehide", this.blur);
    window.removeEventListener("focusin", this.releaseVoice);
    document.removeEventListener?.("visibilitychange", this.visibilityChanged);
    this.input.removeEventListener("input", this.concealCredential);
    this.matchButton.removeEventListener("click", this.matchClick);
    this.host.removeEventListener("wheel", this.wheel);
    this.form.removeEventListener("submit", this.submit);
    if (this.inputActive) this.options.onInputCapture?.(false);
    if (this.font) document.fonts.delete(this.font);
    this.raster?.destroy();
    this.images.clear();
    this.pingTints.length = 0;
    this.host.style.cursor = this.previousCursor;
    this.root.remove();
  }
}
