import { RENDER_LAYOUT, SPRITE_FLAGS, type RenderView } from "@soldat-web/sim-host";
import { contentUrl } from "../content";
import { resizeCamera } from "../camera";
import { SoldatMap, TextureBank } from "./soldat-map";
import type { WorldView } from "../world";
import type { Camera, DrawRun, Geometry, ImageAsset } from "./types";

export interface HudContent {
  graphics: { interface: readonly { symbol: string; asset: ImageAsset | null }[] };
  font: string;
}
export interface HudOptions {
  startJet: number;
  weapons: Readonly<Record<string, { ammo: number; reloadtime: number; fireinterval: number }>>;
  onInputCapture?: (captured: boolean) => void;
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
  ping?: number;
  killEvents?: readonly HudKillEvent[];
  /** True only when the producer actually supplies the death-event stream. */
  killFeedAvailable?: boolean;
  /** Evidence gallery only: native raster section through line 2281, Fire disabled. */
  rasterOnly?: boolean;
}
interface HudImage { image: HTMLImageElement; width: number; height: number }
const EMPTY_PRESENTATION: HudPresentation = {};
const TEAM_NAMES = ["Player", "Alpha", "Bravo", "Charlie", "Delta", "Spectator"];
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
    player.bot = data.getUint32(base + s.controlMethod, true) === 2;
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
  state.timeLeftSeconds = metadata.timeLeftSeconds;
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
    run.vertices[0]!.color[3] = Math.round(this.globalAlpha * 255);
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
  private focusedBeforeChat: HTMLElement | null = null;
  private scoreboardText = "";
  private chatNotice = "";
  private chatNoticeUntil = 0;

  private constructor(private readonly host: HTMLElement, private readonly options: HudOptions) {
    this.fontFamily = `SoldatHud${CombatHud.nextFont++}`;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D HUD renderer unavailable");
    this.context = context;
    this.root.className = "soldat-combat-hud";
    this.root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:3";
    this.canvas.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none";
    this.graphicsCanvas.style.cssText = this.canvas.style.cssText;
    this.canvas.setAttribute("aria-hidden", "true");
    this.graphicsCanvas.setAttribute("aria-hidden", "true");
    this.accessible.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:pre";
    this.accessible.setAttribute("role", "region");
    this.accessible.setAttribute("aria-label", "Scoreboard. Hold Tab to show. T or Enter opens local chat input.");
    this.accessible.hidden = true;
    this.form.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;align-items:baseline;gap:2px;pointer-events:auto;color:#ffe6aa;white-space:nowrap";
    this.form.hidden = true;
    const label = document.createElement("label");
    label.textContent = "Say:";
    this.input.type = "text";
    this.input.maxLength = 120;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-label", "Local chat draft. Enter saves locally; Escape cancels. Not transmitted.");
    this.input.style.cssText = "font:inherit;color:inherit;background:transparent;border:0;padding:0;outline:none;width:400px;box-shadow:none;border-radius:0;min-height:0";
    label.append(this.input);
    this.chatStatus.textContent = "Local only — not transmitted";
    this.chatStatus.setAttribute("role", "status");
    this.form.append(label, this.chatStatus);
    this.root.append(this.graphicsCanvas, this.canvas, this.form, this.accessible);
    this.host.append(this.root);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(this.host);
    this.resize();
    window.addEventListener("keydown", this.keyDown, true);
    window.addEventListener("keyup", this.keyUp, true);
    window.addEventListener("blur", this.blur);
    this.host.addEventListener("wheel", this.wheel, { passive: false });
    this.form.addEventListener("submit", this.submit);
  }

  private static nextFont = 0;
  static async create(host: HTMLElement, content: HudContent, options: HudOptions): Promise<CombatHud> {
    const hud = new CombatHud(host, options);
    try {
      const font = new FontFace(hud.fontFamily, `url("${contentUrl(content.font)}")`);
      await font.load();
      document.fonts.add(font);
      hud.font = font;
      await Promise.all(content.graphics.interface.map(async graphic => {
        if (!graphic.asset) throw new Error(`Missing original HUD graphic ${graphic.symbol}`);
        const asset = graphic.asset;
        const image = new Image();
        image.src = contentUrl(asset.frames[0]!.object);
        await image.decode();
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
      return hud;
    } catch (error) {
      hud.destroy();
      throw error;
    }
  }

  get inputActive(): boolean { return !this.form.hidden; }

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
    this.teamBox(state, sx);
    this.killFeed(world.tick, state, sx);
    if (this.scoreboard) this.drawScoreboard(world, state, localSlot);
    if (this.chatNotice && world.tick <= this.chatNoticeUntil)
      this.text(this.chatNotice, 5, 400, 9, "#ffe6aa");
    this.raster.finish();
  }

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
    for (let i = 0; i < 4; i++) this.teamOrder[i] = i + 1;
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
    this.text(remaining === undefined ? "Time unavailable" : `Time ${Math.floor(remaining / 60)}:${String(Math.max(0, remaining % 60)).padStart(2, "0")}`, x + 485, y + 15, 9, "#aaa0c8");
    this.text(state.gameMode === 0 || state.gameMode === 2 ? "Kills:" : "Points:", x + 280, y + 40, 12);
    this.text("Deaths:", x + 390, y + 40, 12);
    this.text("Ping:", x + 530, y + 40, 12);
    let row = 0;
    let accessible = "Player\tKills / points\tDeaths\tPing\n";
    const renderPlayer = (player: HudPlayer): void => {
      const py = y + 80 + row++ * 20;
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

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || event.isComposing) return;
    const target = event.target;
    const outsideEditor = target instanceof Element && !this.root.contains(target) &&
      target.closest('input, textarea, select, button, dialog, [contenteditable="true"]');
    if (outsideEditor) return;
    if (event.code === "Tab" && !this.inputActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.scoreboard = true;
      this.accessible.hidden = false;
      return;
    }
    if (this.inputActive) {
      if (event.code === "Escape") {
        event.preventDefault();
        this.closeChat();
      } else if (event.code === "Enter" && !event.repeat) {
        event.preventDefault();
        this.saveDraft();
      }
      // Keep native text-input behavior, but never route typing to game bindings.
      event.stopPropagation();
      return;
    }
    if (!event.repeat && (event.code === "KeyT" || event.code === "Enter")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.focusedBeforeChat = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (document.pointerLockElement) document.exitPointerLock();
      this.form.hidden = false;
      this.form.style.display = "flex";
      this.input.focus();
      this.options.onInputCapture?.(true);
    }
  };

  private readonly keyUp = (event: KeyboardEvent): void => {
    if (event.code === "Tab") {
      this.scoreboard = false;
      this.accessible.hidden = true;
    }
  };
  private readonly wheel = (event: WheelEvent): void => {
    if (!this.scoreboard) return;
    event.preventDefault();
    this.scroll = Math.max(0, this.scroll + Math.sign(event.deltaY));
  };
  private readonly submit = (event: SubmitEvent): void => {
    event.preventDefault();
    this.saveDraft();
  };
  private saveDraft(): void {
    const draft = this.input.value.trim();
    if (draft) {
      this.chatNotice = `Local draft (not transmitted): ${draft}`;
      this.chatNoticeUntil = Infinity;
      this.chatStatus.textContent = this.chatNotice;
    }
    this.closeChat();
  }
  private closeChat(): void {
    this.form.hidden = true;
    this.form.style.display = "none";
    this.input.value = "";
    this.options.onInputCapture?.(false);
    this.focusedBeforeChat?.focus({ preventScroll: true });
    this.focusedBeforeChat = null;
  }
  private readonly blur = (): void => {
    this.scoreboard = false;
    this.accessible.hidden = true;
    if (this.inputActive) this.closeChat();
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer.disconnect();
    window.removeEventListener("keydown", this.keyDown, true);
    window.removeEventListener("keyup", this.keyUp, true);
    window.removeEventListener("blur", this.blur);
    this.host.removeEventListener("wheel", this.wheel);
    this.form.removeEventListener("submit", this.submit);
    if (this.inputActive) this.options.onInputCapture?.(false);
    if (this.font) document.fonts.delete(this.font);
    this.raster?.destroy();
    this.images.clear();
    this.pingTints.length = 0;
    this.root.remove();
  }
}
