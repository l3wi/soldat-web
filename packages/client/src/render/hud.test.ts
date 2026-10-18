import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RENDER_ABI_VERSION, RENDER_LAYOUT, SPRITE_FLAGS, readRenderView } from "@soldat-web/sim-host";
import { CombatHud, hudPresentationFromRender, type HudPresentation } from "./hud";
import { resizeCamera } from "../camera";
import type { ImageAsset } from "./types";
import { LimboMenu } from "./limbo";

// Canvas command/ABI fixtures only: not simulation qualification or raster proof.
const manifest = JSON.parse(readFileSync(new URL("../../../../dist/content-next/manifest.json", import.meta.url), "utf8")) as {
  core: { graphics: { interface: { symbol: string; asset: ImageAsset | null }[] } };
};
interface DrawCommand { args: unknown[]; alpha: number }
interface TextCommand {
  value: string; x: number; y: number; color: string; font: string; stretch: number;
  shadow: readonly [string, number, number];
}
interface HudMathHarness {
  pixelAlign(value: number, axis?: "x" | "y"): number;
  sprite(name: string, x: number, y: number): void;
  bar(name: string, x: number, y: number, progress: number, left?: boolean): void;
  text(value: string, x: number, y: number, size?: number, color?: string, align?: CanvasTextAlign): void;
  ping(value: number, sx: number): void;
  teamBox(state: HudPresentation, sx: number): void;
  killFeed(tick: number, state: HudPresentation, sx: number): void;
}
function harness() {
  const draws: DrawCommand[] = [], texts: TextCommand[] = [];
  const stack: { alpha: number; x: number; y: number; sx: number; sy: number }[] = [];
  let tx = 0, ty = 0, sx = 1, sy = 1;
  const context = {
    globalAlpha: 1, fillStyle: "", font: "", textAlign: "left",
    shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    drawImage(...args: unknown[]) { draws.push({ args, alpha: this.globalAlpha }); },
    fillText(value: string, x: number, y: number) {
      texts.push({ value, x: tx + x * sx, y: ty + y * sy, color: this.fillStyle,
        font: this.font, stretch: sx, shadow: [this.shadowColor, this.shadowOffsetX, this.shadowOffsetY] });
    },
    measureText(value: string) { return { actualBoundingBoxLeft: 0, actualBoundingBoxRight: value.length * 5 }; },
    translate(x: number, y: number) { tx += x * sx; ty += y * sy; },
    scale(x: number, y: number) { sx *= x; sy *= y; },
    save() { stack.push({ alpha: this.globalAlpha, x: tx, y: ty, sx, sy }); },
    restore() {
      const saved = stack.pop()!;
      this.globalAlpha = saved.alpha;
      tx = saved.x; ty = saved.y; sx = saved.sx; sy = saved.sy;
    },
  };
  const images = new Map<string, { image: { naturalWidth: number; naturalHeight: number }; width: number; height: number }>();
  for (const graphic of manifest.core.graphics.interface) if (graphic.asset) {
    images.set(graphic.symbol.replace("GFX_INTERFACE_", ""), {
      image: { naturalWidth: graphic.asset.width, naturalHeight: graphic.asset.height },
      width: graphic.asset.width / graphic.asset.scale,
      height: graphic.asset.height / graphic.asset.scale,
    });
  }
  const pingTints = ["#00ff00", "#22ff00", "#54c700", "#76a700", "#938800", "#a17700", "#cc4800", "#ff0000"].map(color => ({ color }));
  // Bypass DOM construction to exercise the actual canvas-command methods.
  const hud = Object.assign(Object.create(CombatHud.prototype), {
    context, raster: context, images, pingTints, teamOrder: [1, 2, 3, 4],
    width: 1280, height: 720, logicalWidth: 853, ratio: 1, fontFamily: "Play",
  }) as HudMathHarness;
  return { hud, images, pingTints, draws, texts };
}

function renderFixture() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const pointer = 8;
  const data = new DataView(memory.buffer, pointer, RENDER_LAYOUT.totalBytes);
  const h = RENDER_LAYOUT.header;
  data.setUint32(h.version, RENDER_ABI_VERSION, true);
  data.setUint32(h.slots, RENDER_LAYOUT.slots, true);
  data.setUint32(h.spriteStride, RENDER_LAYOUT.spriteBytes, true);
  data.setUint32(h.bulletsOffset, RENDER_LAYOUT.bulletsOffset, true);
  data.setUint32(h.thingsOffset, RENDER_LAYOUT.thingsOffset, true);
  data.setUint32(h.totalBytes, RENDER_LAYOUT.totalBytes, true);
  data.setUint32(RENDER_LAYOUT.bulletsOffset + RENDER_LAYOUT.section.stride, RENDER_LAYOUT.bulletBytes, true);
  data.setUint32(RENDER_LAYOUT.thingsOffset + RENDER_LAYOUT.section.stride, RENDER_LAYOUT.thingBytes, true);
  const raw = readRenderView(memory, pointer);
  if (typeof raw === "number") throw new Error(`HUD fixture render pointer ${raw}`);
  return { memory, pointer, data, raw };
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test("native HUD logical viewport reuses camera clamping and ties-to-even rounding", () => {
  const camera = { x: 0, y: 0, z: 0, width: 640, height: 480 };
  for (const [width, height, logicalWidth] of [
    [1280, 720, 853], [640.5, 480, 640], [641.5, 480, 642],
    [4000, 720, 854], [600, 900, 600],
  ] as const) {
    resizeCamera(camera, width, height);
    assert.equal(camera.width, logicalWidth);
    assert.equal(camera.height, 480);
  }
});

test("native PixelAlign floors physical pixels before adding unscaled relative bar offsets", () => {
  const { hud, draws, images } = harness();
  // Client.pas rounds GameWidth to 853; X/Y projection factors are distinct.
  // InterfaceGraphics.pas:427–435, 542–543 floors each output-pixel anchor.
  const sx = 853 / 640, scaleX = 1280 / 853;
  near(hud.pixelAlign(439), 658 / 1.5);
  near(hud.pixelAlign(5 * sx, "x"), 10 / scaleX);
  hud.sprite("HEALTH", 5 * sx, 439);
  near(draws[0]!.args[1] as number, 10 / scaleX);
  near(draws[0]!.args[2] as number, 658 / 1.5);
  hud.bar("HEALTH_BAR", hud.pixelAlign(5 * sx, "x") + 40, hud.pixelAlign(439) + 10, 0.5);
  const args = draws[1]!.args;
  near(args[5] as number, 10 / scaleX + 40);
  near(args[6] as number, 658 / 1.5 + 10);
  // Source PNG dimensions, not the obsolete 115x9 setup dimensions, control size.
  near(args[7] as number, images.get("HEALTH_BAR")!.width / 2);
  near(args[8] as number, images.get("HEALTH_BAR")!.height);
});

test("native RenderBar clamps and crops source pixels rather than stretching a full bar", () => {
  const { hud, draws, images } = harness();
  const asset = images.get("RELOAD_BAR")!;
  hud.bar("RELOAD_BAR", 352, 449, -1);
  assert.equal(draws.length, 0, "empty/negative bars produce no quad");
  hud.bar("RELOAD_BAR", 352, 449, 0.25);
  assert.deepEqual(draws[0]!.args, [asset.image, 0, 0, asset.image.naturalWidth / 4,
    asset.image.naturalHeight, 352, 449, asset.width / 4, asset.height]);
  hud.bar("RELOAD_BAR", 409, 464, 0.25, false);
  assert.deepEqual(draws[1]!.args, [asset.image, asset.image.naturalWidth * 0.75, 0,
    asset.image.naturalWidth / 4, asset.image.naturalHeight, 409, 464, asset.width / 4, asset.height]);
  hud.bar("RELOAD_BAR", 352, 449, 2);
  assert.equal(draws[2]!.args[3], asset.image.naturalWidth);
  near(draws[2]!.args[7] as number, asset.width);
});

test("native font points convert at 96 DPI with source menu/small stretches and shadow", () => {
  const { hud, texts } = harness();
  hud.text("20", 100, 100, 12, "#f2f428");
  assert.equal(texts[0]!.font, '16px "Play"');
  assert.equal(texts[0]!.stretch, 1.5);
  assert.deepEqual(texts[0]!.shadow, ["#000", 1, 1]);
  hud.text("Ak-74", 100, 100, 8, "#fff5b1");
  assert.equal(texts[1]!.font, `${8 * (96 / 72)}px "Play"`);
  assert.equal(texts[1]!.stretch, 1.25);
});

test("native ping tint thresholds, alpha and nonuniform scale use actual ping", () => {
  const { hud, draws, images, pingTints } = harness();
  const dot = images.get("DOT")!;
  for (const [ping, tint] of [[0, 0], [50, 0], [51, 1], [100, 1], [101, 2],
    [150, 2], [151, 3], [200, 3], [201, 4], [250, 4], [251, 5],
    [300, 5], [301, 6], [350, 6], [351, 7], [600, 7]] as const) {
    hud.ping(ping, 4 / 3);
    const command = draws[draws.length - 1]!;
    assert.equal(command.args[0], pingTints[tint], `ping ${ping} native tint`);
    near(command.alpha, Math.min(1, ping / 255));
    near(command.args[1] as number, 800);
    near(command.args[3] as number, dot.width * (0.5 + ping / 600));
    near(command.args[4] as number, dot.height * (0.45 + ping / 600));
  }
});

test("native team box orders scores descending while retaining team colors and tie order", () => {
  const { hud, texts } = harness();
  hud.teamBox({ gameMode: 2, teamScores: [0, 4, 12, 12, 2, 0] }, 1);
  assert.deepEqual(texts.map(text => [text.value, text.y, text.color]), [
    ["12", 330, "#050fd2c8"], ["12", 354, "#d2d205c8"],
    ["4", 378, "#d20f05c8"], ["2", 402, "#05d205c8"],
  ]);
  near(texts[0]!.x, 865 / (1280 / 853));
  texts.length = 0;
  hud.teamBox({ gameMode: 3, teamScores: [0, 10, 20, 0, 0, 0] }, 1);
  assert.deepEqual(texts.map(text => text.value), ["20", "10"]);
  near(texts[0]!.y, Math.floor(355 * 1.5) / 1.5);
  near(texts[1]!.y, Math.floor(395 * 1.5) / 1.5);
});

test("genuine KillBullet codes select grenade icons and source console row spacing", () => {
  const { hud, draws, texts, images } = harness();
  hud.killFeed(100, { killFeedAvailable: true, killEvents: [
    { tick: 95, killer: "Alpha", victim: "Bravo", weapon: 3, killBullet: 222, killerKills: 4, killerTeam: 1, victimTeam: 2 },
    { tick: 100, killer: "Bravo", victim: "Bravo", weapon: 3, killBullet: 210, suicide: true },
  ] }, 1);
  assert.equal(draws[0]!.args[0], images.get("NADE")!.image);
  assert.equal(draws[1]!.args[0], images.get("CLUSTER_NADE")!.image);
  assert.deepEqual(texts.map(text => [text.value, text.y, text.color]), [
    ["Alpha (4)", 68, "#ffe3e3"], ["Bravo", 78, "#a0b0da"], ["Bravo", 96, "#d3b727"],
  ]);
  draws.length = 0;
  hud.killFeed(100, { killFeedAvailable: true, killEvents: [
    { tick: 100, killer: "Unknown", victim: "Victim", weapon: 3, killBullet: 999 },
  ] }, 1);
  assert.equal(draws.length, 0, "unknown native kill code must not invent a weapon icon");
});

test("ABI4 projection reuses records, distinguishes AI from authoritative humans and preserves native scores", () => {
  const { data, raw } = renderFixture();
  const s = RENDER_LAYOUT.sprite;
  const names = ["Alpha", "Bravo", "Charlie"];
  const encoder = new TextEncoder();
  for (let slot = 0; slot < 3; slot++) {
    const base = RENDER_LAYOUT.headerBytes + slot * RENDER_LAYOUT.spriteBytes;
    data.setUint32(base + s.slot, slot + 1, true);
    data.setUint32(base + s.flags, SPRITE_FLAGS.active | (slot === 2 ? SPRITE_FLAGS.bot : 0), true);
    data.setUint32(base + s.team, slot + 1, true);
    data.setUint32(base + s.controlMethod, 2, true); // Both true AI and input-authoritative humans use original BOT role.
    data.setInt32(base + s.kills, slot === 0 ? 2 : 9, true);
    data.setInt32(base + s.deaths, slot === 1 ? 8 : 1, true);
    data.setUint32(base + s.playerFlags, slot === 0 ? 1 : 0, true);
    const bytes = encoder.encode(names[slot]);
    data.setUint32(base + s.playerNameLength, bytes.length, true);
    raw.bytes.set(bytes, base + s.playerName);
  }
  const local = RENDER_LAYOUT.headerBytes;
  data.setFloat32(local + s.vest, 25, true);
  data.setUint32(local + s.weaponAmmo, 30, true);
  data.setUint32(local + s.weaponReloadTime, 150, true);
  data.setUint32(local + s.weaponFireInterval, 11, true);
  data.setUint32(local + s.fireIntervalCount, 7, true);
  data.setUint32(local + s.tertiaryWeapon, 51, true);
  const base = RENDER_LAYOUT.globalsOffset, g = RENDER_LAYOUT.globals;
  data.setInt32(base + g.startHealth, 150, true);
  data.setInt32(base + g.mapStartJet, 100, true);
  data.setInt32(base + g.gameMode, 3, true);
  data.setInt32(base + g.killLimit, 10, true);
  data.setInt32(base + g.teamScores + 4, 4, true);
  const state = hudPresentationFromRender(raw, 1, {
    rasterOnly: true, serverName: "Actual server", fireIntervalReal: 3, reloadReal: 70,
  });
  assert.deepEqual(state.players!.map(player => player.name), ["Alpha", "Charlie", "Bravo"]);
  assert.equal(state.players![1]!.bot, true);
  assert.equal(state.players![0]!.bot, false);
  assert.equal(state.players![2]!.bot, false);
  assert.equal(state.vest, 25);
  assert.equal(state.ammoCapacity, 30);
  assert.equal(state.reloadTime, 150);
  assert.equal(state.fireIntervalCount, 7);
  assert.equal(state.fireIntervalReal, 3);
  assert.equal(state.reloadReal, 70);
  assert.equal(state.tertiaryWeapon, 51);
  assert.equal(state.startHealth, 150);
  assert.equal(state.startJet, 100);
  assert.equal(state.teamScores![1], 4);
  const player = state.players![0];
  raw.bytes.set(encoder.encode("Other"), local + s.playerName);
  data.setInt32(base + g.mapStartJet, 200, true);
  data.setInt32(base + g.teamScores + 4, 8, true);
  const refreshed = hudPresentationFromRender(raw, 1);
  assert.equal(refreshed, state);
  assert.equal(refreshed.players![0], player);
  assert.equal(refreshed.players![0]!.name, "Other");
  assert.equal(refreshed.startJet, 200, "read live globals, not stale RenderView.globals snapshots");
  assert.equal(refreshed.teamScores![1], 8);
  assert.equal(refreshed.serverName, undefined, "absent metadata does not leak from previous frames");
  assert.equal(refreshed.rasterOnly, undefined);
  assert.equal(refreshed.fireIntervalReal, undefined);
  assert.equal(refreshed.reloadReal, undefined);
});

test("limbo secondary selection stays open and carries explicit apply intent before primary", () => {
  const choices: unknown[][] = [];
  const limbo = new LimboMenu();
  limbo.observe(false, 4, 0);
  const hud = Object.assign(Object.create(CombatHud.prototype), {
    limbo, lastTick: 10, form: { hidden: true }, weaponMask: 0x3fff, selectionMask: 0x3fff,
    options: { onWeaponChoice: (...choice: unknown[]) => choices.push(choice) },
  }) as { chooseWeapon(index: number): void };
  hud.chooseWeapon(11);
  assert.equal(limbo.active, true);
  hud.chooseWeapon(6);
  assert.equal(limbo.active, false);
  assert.deepEqual(choices, [[4, 11, "secondary"], [7, 11, "primary"]]);
});

test("CTF scoreboard team headers never overlap the preceding team's last bot", () => {
  const rows: { value: string; y: number }[] = [];
  const hud = Object.assign(Object.create(CombatHud.prototype), {
    logicalWidth: 640, scroll: 0, accessible: { textContent: "" },
    context: { save() {}, beginPath() {}, rect() {}, clip() {}, restore() {} },
    sprite() {}, text(value: string, _x: number, y: number) { rows.push({ value, y }); },
  }) as { drawScoreboard(world: { sprites: unknown[] }, state: HudPresentation, localSlot: number): void };
  hud.drawScoreboard({ sprites: [] }, { gameMode: 3, players: [
    { slot: 1, name: "Human", team: 1 }, { slot: 2, name: "Alpha bot", team: 1, bot: true },
    { slot: 3, name: "Bravo bot", team: 2, bot: true },
  ] }, 1);
  const y = (name: string) => rows.find(row => row.value === name)!.y;
  assert.equal(y("Alpha"), 60);
  assert.equal(y("Human"), 80);
  assert.equal(y("Alpha bot"), 100);
  assert.equal(y("Bravo"), 120);
  assert.equal(y("Bravo bot"), 140);
});

test("native rule HUD follows authoritative timer, phase and per-player unlocked weapons", () => {
  const { data, raw } = renderFixture(), s = RENDER_LAYOUT.sprite, g = RENDER_LAYOUT.globals;
  const player = RENDER_LAYOUT.headerBytes, globals = RENDER_LAYOUT.globalsOffset;
  data.setUint32(player + s.flags, SPRITE_FLAGS.active, true);
  data.setUint32(player + s.slot, 1, true);
  data.setUint32(player + s.availableWeaponsMask, 0x401, true);
  data.setInt32(player + s.respawnCounter, 87, true);
  data.setInt32(globals + g.timeLimitTicks, 3600, true);
  data.setInt32(globals + g.timeLeftTicks, 121, true);
  data.setInt32(globals + g.mapChangeCounter, 180, true);
  data.setUint32(globals + g.roundPhase, 1, true);
  data.setUint32(globals + g.roundEpoch, 8, true);
  data.setUint32(globals + g.realistic, 1, true);
  data.setUint32(globals + g.survival, 1, true);
  data.setUint32(globals + g.advance, 1, true);
  data.setUint32(globals + g.enabledWeaponsMask, 0x7ff, true);
  data.setFloat32(globals + g.tickScale, 1 / 3, true);
  for (let mode = 0; mode <= 6; mode++) {
    data.setInt32(globals + g.gameMode, mode, true);
    const state = hudPresentationFromRender(raw, 1, { timeLeftSeconds: 999 });
    assert.equal(state.gameMode, mode);
    assert.equal(state.timeLeftSeconds, 3, "native timer takes precedence over stale metadata");
    assert.equal(state.roundPhase, 1); assert.equal(state.roundEpoch, 8);
    assert.equal(state.mapChangeCounter, 180);
    assert.equal(state.realistic, true); assert.equal(state.survival, true); assert.equal(state.advance, true);
    assert.equal(state.availableWeaponsMask, 0x401); assert.equal(state.enabledWeaponsMask, 0x7ff);
    assert.equal(state.respawnCounter, 87);
  }
  data.setInt32(globals + g.timeLimitTicks, 0, true);
  assert.equal(hudPresentationFromRender(raw, 1).timeLeftSeconds, undefined, "zero limit is not an expired timer");
});

test("limbo never dispatches disabled or advance-locked primary choices", () => {
  const choices: unknown[][] = [], limbo = new LimboMenu();
  limbo.observe(true, 4, 0);
  const hud = Object.assign(Object.create(CombatHud.prototype), {
    limbo, lastTick: 1, form: { hidden: true }, weaponMask: 0x3ffe, selectionMask: 0x3ffb,
    options: { onWeaponChoice: (...choice: unknown[]) => choices.push(choice) },
  }) as { chooseWeapon(index: number): void };
  hud.chooseWeapon(0); hud.chooseWeapon(2);
  assert.deepEqual(choices, []);
  assert.equal(limbo.active, true, "invalid selection cannot dismiss picker");
  hud.chooseWeapon(1);
  assert.deepEqual(choices, [[2, 0, "primary"]]);
  assert.equal(limbo.active, false);
  limbo.observe(false, 2, 0);
  assert.equal(limbo.active, false, "selection remains closed through respawn");
});

test("two-team score box does not rank inactive Charlie and Delta above a negative team score", () => {
  const { hud, texts } = harness();
  hud.teamBox({ gameMode: 5, teamScores: [0, -1, 3, 0, 0, 0] }, 1);
  assert.deepEqual(texts.map(text => text.value), ["3", "-1"]);
});

test("objective HUD consumes native holder/base state and clears departed objectives without replacing records", () => {
  const { data, raw } = renderFixture(), f = RENDER_LAYOUT.thing;
  data.setUint32(raw.thingsOffset + RENDER_LAYOUT.section.count, 2, true);
  const first = raw.thingsOffset + RENDER_LAYOUT.sectionHeaderBytes, second = first + RENDER_LAYOUT.thingBytes;
  data.setUint32(first + RENDER_LAYOUT.movingEntity.style, 1, true);
  data.setUint32(first + f.holdingSprite, 7, true);
  data.setUint32(second + RENDER_LAYOUT.movingEntity.style, 2, true);
  data.setUint32(second + f.flags, 2, true);
  const state = hudPresentationFromRender(raw, 1), objectives = state.objectives!;
  assert.deepEqual(objectives[0], { style: 1, active: true, holder: 7, inBase: false });
  assert.deepEqual(objectives[1], { style: 2, active: true, holder: 0, inBase: true });
  const objective = objectives[0];
  data.setUint32(raw.thingsOffset + RENDER_LAYOUT.section.count, 0, true);
  const next = hudPresentationFromRender(raw, 1);
  assert.equal(next.objectives, objectives); assert.equal(next.objectives![0], objective);
  assert.equal(next.objectives!.some(value => value.active), false);
});
