import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { compare } from "../../render-spike/scripts/compare.ts";

// Usage: bun packages/client/scripts/combat-capture.mjs --wasm-sha256 FINAL_SHA256
// Prerequisites: running client dev server, ego-browser, and native combat captures.
// No render-only gallery row is counted as simulation/gameplay evidence.
const root = resolve(import.meta.dir, "../../..");
const options = { "wasm-sha256": "", url: process.env.CLIENT_URL ?? "http://127.0.0.1:5195", map: "Arena", space: "" };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  if (!(key in options) || !process.argv[i + 1]) throw new Error("Usage: bun packages/client/scripts/combat-capture.mjs --wasm-sha256 FINAL_SHA256 [--url URL] [--map Arena] [--space ID]");
  options[key] = process.argv[i + 1];
}
if (!/^[a-f0-9]{64}$/.test(options["wasm-sha256"])) throw new Error("An explicit final WASM SHA-256 is required; capture never silently blesses a rebuilt artifact");
if (options.space && !/^[1-9][0-9]*$/.test(options.space)) throw new Error("--space requires an existing positive TaskSpace ID");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const out = resolve(root, "tests/fixtures/render"), receipts = resolve(root, "build-out/client-g3");
await mkdir(out, { recursive: true }); await mkdir(receipts, { recursive: true });
const identity = { expectedWasmSha256: options["wasm-sha256"], abiVersion: 0x00010003,
  supersededWasmSha256: "181b959c27fab6e6bcba973ce3c5dd708554b73e79530a20bab3427dfc5a0393",
  reason: "Coordinator-authorized presentation-only ABI3; no acceptance across artifact identities" };
const localWasm = await readFile(resolve(root, "build-out/sim/sim.wasm"));
if (hash(localWasm) !== identity.expectedWasmSha256) throw new Error("Local WASM differs from explicit capture pin");
const servedResponse = await fetch(`${options.url}/sim.wasm`);
if (!servedResponse.ok || hash(new Uint8Array(await servedResponse.arrayBuffer())) !== identity.expectedWasmSha256) throw new Error("Served WASM differs from explicit capture pin");
const mapResponse = await fetch(`${options.url}/content/maps/${encodeURIComponent(options.map)}.json`);
if (!mapResponse.ok) throw new Error(`Capture map HTTP ${mapResponse.status}`);
const map = await mapResponse.json();
if (!map || !Array.isArray(map.polygons) || !map.polygons.every(poly => Number.isInteger(poly.polytype) && Array.isArray(poly.vertices) && poly.vertices.length === 3 && poly.vertices.every(v => Number.isFinite(v.x) && Number.isFinite(v.y)))) throw new Error("Malformed shipped map geometry");
// Use a real upper solid edge whose entire combat corridor is outside every
// solid triangle. A long edge alone can be buried under another map polygon.
const solids = map.polygons.filter(poly => poly.polytype === 0);
const lanes = [];
for (const [polygon, poly] of map.polygons.entries()) {
  if (poly.polytype !== 0) continue;
  for (let edge = 0; edge < 3; edge++) {
    let a = poly.vertices[edge], b = poly.vertices[(edge + 1) % 3];
    const c = poly.vertices[(edge + 2) % 3];
    if (a.x > b.x) [a, b] = [b, a];
    if (b.x - a.x < 140 || Math.abs((b.y - a.y) / (b.x - a.x)) > 0.6 || c.y <= (a.y + b.y) / 2 + 8) continue;
    const middle = (a.x + b.x) / 2;
    let clear = true;
    for (let x = middle - 60; clear && x <= middle + 60; x += 10) {
      const surface = a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x);
      for (let height = 2; clear && height <= 90; height += 5) {
        const y = surface - height;
        clear = !solids.some(poly => {
          const signs = poly.vertices.map((v, i) => {
            const next = poly.vertices[(i + 1) % 3];
            return (next.x - v.x) * (y - v.y) - (next.y - v.y) * (x - v.x);
          });
          return signs.every(sign => sign >= 0) || signs.every(sign => sign <= 0);
        });
      }
    }
    if (!clear) continue;
    lanes.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, length: b.x - a.x, polygon, edge });
  }
}
lanes.sort((a, b) => b.length - a.length);
const lane = lanes[0];
if (!lane) throw new Error("Map has no qualifying solid combat lane; select a stock map with a long upper edge");
const centerX = (lane.x1 + lane.x2) / 2;
const floor = x => lane.y1 + (x - lane.x1) * (lane.y2 - lane.y1) / (lane.x2 - lane.x1);
const anchors = { left: { x: centerX - 55, y: floor(centerX - 55) - 32 }, right: { x: centerX + 55, y: floor(centerX + 55) - 32 }, camera: { x: centerX, y: floor(centerX) - 120 } };
let nativeCapture;
try {
  nativeCapture = JSON.parse(await readFile(resolve(root, "build-out/refclient/combat-capture.json"), "utf8"));
  if (nativeCapture.version !== 1 || nativeCapture.source !== "original-native-renderer" || nativeCapture.renderingOnly !== true || !Array.isArray(nativeCapture.captures)) throw new Error("Malformed native capture receipt");
  if (nativeCapture.helperSha256 !== hash(await readFile(resolve(root, "tools/refclient/ReferenceCombat.inc"))) ||
      nativeCapture.executableSha256 !== hash(await readFile(resolve(root, "build-out/refclient/cmake/bin/opensoldat")))) throw new Error("Native capture helper/executable no longer matches its receipt");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const galleries = [];
for (const mode of ["objects", "hud", "hud-reload", "hud-full"]) {
  const source = resolve(root, `build-out/refclient/combat-gallery-${mode}.json`);
  try {
    const bytes = await readFile(source), data = JSON.parse(bytes.toString());
    if (data.kind !== "native-render-gallery" || data.mode !== mode || data.width !== 1280 || data.height !== 720 || data.filter !== "linear" || data.mipmaps !== false) throw new Error("Native gallery metadata does not match capture contract");
    const nativeRow = nativeCapture?.captures.find(row => row.mode === mode);
    if (!nativeRow) throw Object.assign(new Error("Native capture receipt missing"), { code: "ENOENT" });
    if (nativeRow.stateSha256 !== hash(bytes) || nativeRow.imageSha256 !== hash(await readFile(resolve(root, nativeRow.image)))) throw new Error(`Native ${mode} framebuffer/state capture identity mismatch`);
    galleries.push({ mode, source, sha256: hash(bytes), data });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    galleries.push({ mode, source, pending: "Run sh tools/refclient/build-combat.sh && sh tools/refclient/capture-combat.sh" });
  }
}
const weapons = [
  [1, "eagles"], [2, "mp5"], [3, "ak74"], [4, "steyr"], [5, "spas"], [6, "ruger"], [7, "m79"], [8, "barrett"], [9, "minimi"], [10, "minigun"],
  [0, "socom"], [11, "knife"], [12, "chainsaw"], [13, "law"], [14, "flamer"], [15, "bow"], [16, "flamebow"], [30, "m2"], [255, "fists"],
].map(([weapon, name]) => ({ weapon: Number(weapon), name: String(name) }));
const runId = `combat-${Date.now()}`;
const plan = [...galleries.map(g => ({ name: `native-${g.mode}`, source: "native-render-gallery", status: "pending" })),
  ...weapons.map(w => ({ name: `fire-${w.name}`, source: "actual-local-sim", status: "pending", observations: [] })),
  ...["grenade", "clusters", "knife-throw", "pickup-16", "pickup-17", "pickup-7", "flag-grab-drop-1", "flag-grab-drop-2", "death-ragdoll-respawn", "hud-reload"]
    .map(name => ({ name, source: "actual-local-sim", status: "pending", observations: [] }))];
const config = { runId, plan, root, out, receipts, spaceId: options.space ? Number(options.space) : undefined, url: options.url, map: options.map, identity, lane, anchors, galleries, weapons, nativeCapture, mapSha256: map.mapSha256 };
await writeFile(resolve(receipts, "combat-browser.json"), JSON.stringify({ version: 1, runId, ...identity, rows: plan, errors: [], completed: false }, null, 2) + "\n");

// This function is serialized into the ego-browser Node runtime. Static imports
// in browserScript provide fs; the hook uses the repository's input encoder.
async function browserCapture(config) {
  const task = await taskSpace(config.spaceId ?? "Soldat native combat qualification");
  console.log(JSON.stringify({ taskSpaceId: task.spaceId }));
  const page = task.page("p1");
  const rows = config.plan, errors = [];
  const reportPath = `${config.receipts}/combat-browser.json`;
  let completed = false;
  await fs.writeFile(`${config.receipts}/combat-frames.jsonl`, "");
  const save = async () => {
    await fs.writeFile(reportPath, JSON.stringify({ version: 1, runId: config.runId, ...config.identity, map: config.map, mapSha256: config.mapSha256, nativeCapture: config.nativeCapture,
      lane: config.lane, anchors: config.anchors, taskSpaceId: task.spaceId, rows, errors,
      captureMethod: "browser-canvas-framebuffer-readback",
      captureLimitations: "Actual preserved WebGL framebuffer plus actual HUD 2D canvas; external DOM chat/menus are not covered",
      bootNote: "Coordinator reported Page.screenshot/CDP capture timeouts before this harness run; those failed attempts wrote no screenshot file",
      evidenceBoundary: "Native gallery is rendering-only; gameplay rows use original local sim commands and input-driven updates", completed }, null, 2) + "\n");
  };
  const evaluate = async (action, args = null) => page.evaluate(async ({ action, args }) => {
    const hook = window.__soldatCombat;
    if (!hook) throw new Error("window.__soldatCombat unavailable");
    if (action === "reset") { await hook.reset(); hook.pause(true); return; }
    if (action === "command") { hook.command(args); return; }
    if (action === "control") { hook.control(args.slot, args.control); return; }
    if (action === "camera") { hook.camera(args.x, args.y, args.z ?? 0); hook.render(); return; }
    if (action === "state") return hook.state();
    if (action === "identity") return hook.identity();
    if (action === "gallery") { hook.gallery(args.data, args.mode); hook.render(); return; }
    if (action !== "drive") throw new Error(`Unknown capture action ${action}`);
    const samples = [];
    const scalar = v => typeof v === "number" ? v : v?.decimal;
    for (let tick = 0; tick < args.ticks; tick++) {
      if (args.trackTarget) {
        const before = hook.state(), target = before.sprites.find(sprite => sprite.id === 2);
        if (!target) throw new Error("Actual aim target unavailable");
        const point = target.skeleton[8].pos;
        hook.control(1, { ...args.trackTarget, MouseAimX: Math.round(scalar(point[0])), MouseAimY: Math.round(scalar(point[1])), MouseDist: 500 });
      }
      hook.step(1);
      const state = hook.state();
      if (!Array.isArray(state.sprites) || !Array.isArray(state.bullets) || !Array.isArray(state.things)) throw new Error("Combat diagnostic arrays unavailable");
      const { sprites, bullets, things } = state;
      const player = sprites.find(s => s.id === 1), target = sprites.find(s => s.id === 2);
      samples.push({ tick: state.tick, sprites: sprites.map(s => ({ id: s.id, dead: s.dead, health: s.health, particle: s.particle,
        weapon: s.weapon, tertiaryWeapon: s.tertiaryWeapon, heldThing: s.heldThing, body: s.body, legs: s.legs, onGround: s.onGround })), bullets, things, combatHits: state.combatHits });
      let found = false;
      if (args.until === "shot") found = player?.weapon?.ammo < args.ammo || bullets.some(b => b.owner === 1 && b.weapon === args.weapon) || scalar(target?.health) < args.targetHealth;
      if (args.until === "grenade") found = bullets.some(b => b.owner === 1 && b.style === 2) && player?.tertiaryWeapon?.ammo < args.grenades;
      if (args.until === "cluster-kit") found = player?.tertiaryWeapon?.num === 51 && player.tertiaryWeapon.ammo > 0;
      if (args.until === "bullet-style") found = bullets.some(b => b.owner === 1 && b.style === args.style && b.weapon === args.weapon);
      if (args.until === "dead") found = target?.dead === true;
      if (args.until === "alive") found = target?.dead === false && scalar(target?.health) > 0;
      if (args.until === "held") found = things.some(t => t.style === args.style && t.holdingSprite === 1) && player?.heldThing > 0;
      if (args.until === "released") found = things.some(t => t.style === args.style && t.holdingSprite === 0 && !t.inBase) && player?.heldThing === 0;
      if (args.until === "pickup") found = args.style === 16 ? scalar(player?.health) > args.health : args.style === 17 ? player?.tertiaryWeapon?.ammo > args.grenades : player?.weapon?.num === args.weapon;
      if (args.until === "dropped-weapon") found = player?.weapon?.num === 255 && things.some(t => t.style === 7 && t.owner === 1);
      if (args.until === "reload") found = player?.weapon?.ammo === 0 && player?.weapon?.reload > 0;
      if (found) return { found, state, samples };
    }
    return { found: false, state: hook.state(), samples };
  }, { action, args });
  const scalar = v => {
    const n = typeof v === "number" ? v : v?.decimal;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("Diagnostic scalar unavailable");
    return n;
  };
  const actor = (state, slot) => {
    const value = state.sprites.find(s => s.id === slot);
    if (!value) throw new Error(`Actual sprite ${slot} missing`);
    return value;
  };
  const input = async (slot, control) => evaluate("control", { slot, control });
  const state = () => evaluate("state");
  const drive = async (ticks, until, extra = {}) => {
    const result = await evaluate("drive", { ticks, until, ...extra });
    await fs.appendFile(`${config.receipts}/combat-frames.jsonl`, result.samples.map(sample => JSON.stringify(sample)).join("\n") + "\n");
    return result;
  };
  const screenshot = async (name, snapshot) => {
    const dataURL = await page.evaluate(() => {
      const canvas = document.querySelector("canvas"), hook = window.__soldatCombat;
      if (!canvas || typeof hook?.screenshot !== "function") throw new Error("Actual combat framebuffer readback unavailable");
      const r = canvas.getBoundingClientRect();
      if (canvas.width !== 1280 || canvas.height !== 720 || r.width !== 1280 || r.height !== 720 || devicePixelRatio !== 1) throw new Error(`Unmatched canvas ${canvas.width}x${canvas.height}/${r.width}x${r.height}@${devicePixelRatio}`);
      return hook.screenshot();
    });
    if (typeof dataURL !== "string" || !dataURL.startsWith("data:image/png;base64,")) throw new Error("Framebuffer hook did not return a PNG data URL");
    const bytes = Buffer.from(dataURL.slice("data:image/png;base64,".length), "base64");
    if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) !== 1280 || bytes.readUInt32BE(20) !== 720) throw new Error("Framebuffer PNG does not match native 1280x720 capture");
    const path = `${config.out}/combat-${name}.png`;
    await fs.writeFile(path, bytes);
    await fs.writeFile(`${config.receipts}/${name}.state.json`, JSON.stringify(snapshot, null, 2) + "\n");
    return path;
  };
  const aim = (snapshot, slot = 2) => {
    const soldier = actor(snapshot, slot), point = soldier.skeleton[8].pos;
    return { MouseAimX: Math.round(scalar(point[0])), MouseAimY: Math.round(scalar(point[1])), MouseDist: 500 };
  };
  const setup = async (weapon = 3, targetHealth = 10000, near = false, playerHealth = 150, grenades = 3) => {
    await evaluate("reset");
    await page.waitForFunction(() => !!window.__soldatClient?.ready && !!window.__soldatCombat);
    await input(1, {}); await input(2, {});
    const left = config.anchors.left, right = near ? { x: left.x + 17, y: left.y } : config.anchors.right;
    // Native pickup and automatic respawn consult Brain.FavWeapon, not merely
    // the current gun assigned by spawn. Choose the actual loadout first.
    await evaluate("command", { kind: "weapon-choice", slot: 1, weapon, secondaryWeapon: 0 });
    await evaluate("command", { kind: "weapon-choice", slot: 2, weapon: 2, secondaryWeapon: 0 });
    await evaluate("command", { kind: "spawn", slot: 1, spawn: 1, x: left.x, y: left.y, weapon, secondaryWeapon: 0, health: playerHealth, grenades });
    await evaluate("command", { kind: "spawn", slot: 2, spawn: 1, x: right.x, y: right.y, weapon: 2, secondaryWeapon: 0, health: targetHealth, grenades: 3 });
    await evaluate("camera", config.anchors.camera);
    await drive(90);
    const value = await state();
    if (actor(value, 1).dead || actor(value, 2).dead) throw new Error("Actors did not survive settling on the selected shipped-map lane");
    await input(1, aim(value)); await input(2, aim(value, 1));
    return value;
  };
  const scenario = async (name, run) => {
    const row = rows.find(row => row.name === name);
    try { await run(row); if (row.status === "pending") row.status = "pass"; }
    catch (error) { row.status = "fail"; row.error = String(error); }
    await save();
  };
  try {
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await page.goto(config.url);
    const originalSettings = await page.evaluate(() => {
      const key = "soldat-web.settings.v1", original = localStorage.getItem(key);
      let settings = {};
      try { settings = JSON.parse(original ?? "{}") ?? {}; } catch { /* Preserve default bindings if saved settings are malformed. */ }
      localStorage.setItem(key, JSON.stringify({ ...settings, filter: "linear", mipmaps: false }));
      return original;
    });
    await page.goto(`${config.url}/?combat&map=Airpirates`);
    await page.waitForFunction(() => !!window.__soldatCombat && window.__soldatClient?.ready, undefined, { timeout: 120_000 });
    const actualIdentity = await evaluate("identity");
    if (actualIdentity.wasmSha256 !== config.identity.expectedWasmSha256 || actualIdentity.abiVersion !== config.identity.abiVersion) throw new Error(`Browser simulation identity mismatch: ${JSON.stringify(actualIdentity)}`);
    if (actualIdentity.filter !== "linear" || actualIdentity.mipmaps !== false || actualIdentity.gameWidth !== 853 || actualIdentity.gameHeight !== 480) throw new Error(`Unmatched native/browser projection or filtering: ${JSON.stringify(actualIdentity)}`);
    for (const gallery of config.galleries) {
      const row = rows.find(row => row.name === `native-${gallery.mode}`);
      row.nativeJsonSha256 = gallery.sha256;
      if (gallery.pending) { row.reason = gallery.pending; continue; }
      try {
        await evaluate("gallery", { data: gallery.data, mode: gallery.mode });
        row.image = await screenshot(`browser-${gallery.mode}`, gallery.data);
        row.status = "captured-awaiting-comparison";
      } catch (error) { row.status = "fail"; row.error = String(error); }
      await save();
    }
    await page.goto(`${config.url}/?combat&map=${encodeURIComponent(config.map)}`);
    await page.waitForFunction(() => !!window.__soldatCombat && window.__soldatClient?.ready, undefined, { timeout: 120_000 });
    for (const weapon of config.weapons) await scenario(`fire-${weapon.name}`, async row => {
      const initial = await setup(weapon.weapon, 10000, [11, 12, 255].includes(weapon.weapon));
      const before = actor(initial, 1), target = actor(initial, 2);
      await input(1, { ...aim(initial), Fire: true, ...(weapon.weapon === 13 ? { Down: true } : {}) });
      const fired = await drive(420, "shot", { weapon: weapon.weapon, ammo: before.weapon.ammo, targetHealth: scalar(target.health) });
      row.observations.push({ kind: "input-driven-fire", observed: fired.found, tick: fired.state.tick,
        ammoBefore: before.weapon.ammo, ammoAfter: actor(fired.state, 1).weapon.ammo,
        bulletStyles: [...new Set(fired.samples.flatMap(s => s.bullets.filter(b => b.owner === 1).map(b => b.style)))] });
      row.image = await screenshot(`sim-fire-${weapon.name}`, fired.state);
      if (!fired.found) throw new Error("No ammunition decrement, matching owner projectile, or target health loss observed for the stock weapon");
      await drive(30); await input(1, aim(fired.state));
    });
    await scenario("grenade", async row => {
      const initial = await setup(), before = actor(initial, 1).tertiaryWeapon.ammo;
      await input(1, { ...aim(initial), ThrowNade: true });
      const thrown = await drive(90, "grenade", { grenades: before });
      row.observations.push({ kind: "grenade-release-and-inventory", observed: thrown.found, tick: thrown.state.tick });
      row.image = await screenshot("sim-grenade", thrown.state);
      if (!thrown.found) throw new Error("No native frag projectile plus inventory decrement observed");
      await input(1, aim(thrown.state)); await drive(210);
    });
    await scenario("clusters", async row => {
      const initial = await setup(), player = actor(initial, 1), p = player.particle.pos;
      await evaluate("command", { kind: "thing", style: 22, owner: 0, x: scalar(p[0]), y: scalar(p[1]) - 8 });
      const kit = await drive(120, "cluster-kit");
      row.observations.push({ kind: "original-cluster-kit-pickup", weapon: 51, observed: kit.found, tick: kit.state.tick });
      if (!kit.found) throw new Error("Original cluster kit did not produce cluster grenade inventory");
      row.kitImage = await screenshot("sim-cluster-kit", kit.state);
      const pos = actor(kit.state, 1).particle.pos;
      await input(1, { ThrowNade: true, MouseAimX: Math.round(scalar(pos[0]) + 200), MouseAimY: Math.round(scalar(pos[1]) - 100), MouseDist: 500 });
      const thrown = await drive(90, "bullet-style", { style: 9, weapon: 51 });
      row.observations.push({ kind: "input-driven-cluster-grenade", weapon: 51, observed: thrown.found, tick: thrown.state.tick });
      row.grenadeImage = await screenshot("sim-cluster-grenade", thrown.state);
      if (!thrown.found) throw new Error("No original cluster grenade emitted through ThrowNade");
      await input(1, aim(thrown.state));
      const fragments = await drive(240, "bullet-style", { style: 10, weapon: 52 });
      row.observations.push({ kind: "native-cluster-split-not-selectable-fire", weapon: 52, observed: fragments.found, tick: fragments.state.tick });
      row.fragmentsImage = await screenshot("sim-cluster-fragments", fragments.state);
      if (!fragments.found) throw new Error("No original cluster fragments observed after native grenade collision");
    });
    await scenario("knife-throw", async row => {
      const initial = await setup(11);
      await input(1, { ...aim(initial), ThrowWeapon: true });
      const thrown = await drive(90, "bullet-style", { style: 13, weapon: 53 });
      row.observations.push({ kind: "original-knife-throw", weapon: 53, observed: thrown.found, tick: thrown.state.tick });
      row.image = await screenshot("sim-thrown-knife", thrown.state);
      if (!thrown.found) throw new Error("No original thrown knife emitted through ThrowWeapon");
    });
    for (const style of [16, 17, 7]) await scenario(`pickup-${style}`, async row => {
      let initial = await setup(3, 10000, false, style === 16 ? 50 : 150, style === 17 ? 0 : 3);
      if (style === 7) {
        await input(1, { ...aim(initial), ThrowWeapon: true });
        const dropped = await drive(90, "dropped-weapon");
        row.observations.push({ kind: "input-driven-dropped-weapon", observed: dropped.found, tick: dropped.state.tick });
        row.dropImage = await screenshot("sim-dropped-weapon", dropped.state);
        if (!dropped.found) throw new Error("ThrowWeapon did not create an actual dropped AK74 and unarmed player");
        await input(1, aim(dropped.state)); await drive(35);
        initial = await state();
      }
      const player = actor(initial, 1), p = player.particle.pos;
      await evaluate("command", { kind: "thing", style, owner: 0, x: scalar(p[0]), y: scalar(p[1]) - 8, ammo: 20 });
      const spawned = await state();
      row.beforeImage = await screenshot(`sim-pickup-${style}-before`, spawned);
      const picked = await drive(120, "pickup", { style, health: scalar(player.health), grenades: player.tertiaryWeapon.ammo, weapon: 3 });
      row.observations.push({ kind: "original-pickup-effects", style, observed: picked.found, tick: picked.state.tick });
      row.image = await screenshot(`sim-pickup-${style}-after`, picked.state);
      if (!picked.found) throw new Error("Spawned native thing did not produce its pickup inventory/health transition");
    });
    for (const style of [1, 2]) await scenario(`flag-grab-drop-${style}`, async row => {
      let initial = await setup();
      if (style === 1) {
        await evaluate("command", { kind: "team", slot: 1, team: 2 });
        await evaluate("command", { kind: "spawn", slot: 1, spawn: 1, ...config.anchors.left, weapon: 3, health: 150, grenades: 3 });
        await drive(90); initial = await state();
      }
      const p = actor(initial, 1).particle.pos;
      await evaluate("command", { kind: "thing", style, owner: 0, x: scalar(p[0]), y: scalar(p[1]) - 8, ammo: 255 });
      const grabbed = await drive(180, "held", { style });
      row.observations.push({ kind: "flag-held", style, observed: grabbed.found, tick: grabbed.state.tick });
      row.grabImage = await screenshot(`sim-flag-${style}-held`, grabbed.state);
      if (!grabbed.found) throw new Error("Enemy flag not acquired by actual collision logic");
      const flagger = actor(grabbed.state, 1).particle.pos;
      await input(1, { MouseAimX: Math.round(scalar(flagger[0]) + 200), MouseAimY: Math.round(scalar(flagger[1]) - 150), MouseDist: 500, FlagThrow: true });
      const dropped = await drive(60, "released", { style });
      row.observations.push({ kind: "flag-released", style, observed: dropped.found, tick: dropped.state.tick });
      row.dropImage = await screenshot(`sim-flag-${style}-dropped`, dropped.state);
      if (!dropped.found) throw new Error("Flag did not enter unheld out-of-base state through FlagThrow input");
    });
    await scenario("death-ragdoll-respawn", async row => {
      const initial = await setup(3, 150);
      await input(1, { ...aim(initial), Fire: true });
      const dead = await drive(420, "dead", { trackTarget: { Fire: true } });
      row.observations.push({ kind: "damage-death", observed: dead.found, tick: dead.state.tick });
      row.deathImage = await screenshot("sim-death", dead.state);
      if (!dead.found) throw new Error("Target did not die from original input-driven firing");
      await input(1, aim(dead.state));
      const later = await drive(15), a = actor(dead.state, 2), b = actor(later.state, 2);
      const moved = b.dead && JSON.stringify(a.skeleton.map(p => p.pos)) !== JSON.stringify(b.skeleton.map(p => p.pos));
      row.observations.push({ kind: "dead-skeleton-motion", observed: moved, fromTick: dead.state.tick, toTick: later.state.tick });
      row.ragdollImage = await screenshot("sim-ragdoll", later.state);
      const alive = await drive(900, "alive");
      row.observations.push({ kind: "automatic-respawn", observed: alive.found, tick: alive.state.tick });
      row.respawnImage = await screenshot("sim-respawn", alive.state);
      if (!moved || !alive.found) throw new Error("Missing actual dead-skeleton motion or automatic respawn");
    });
    await scenario("hud-reload", async row => {
      const initial = await setup(3, 10000, false, 75, 2);
      row.beforeImage = await screenshot("sim-hud", initial);
      await input(1, { ...aim(initial), Fire: true });
      const shot = await drive(420, "shot", { weapon: 3, ammo: actor(initial, 1).weapon.ammo, targetHealth: scalar(actor(initial, 2).health) });
      row.observations.push({ kind: "partial-magazine-before-manual-reload", observed: shot.found && actor(shot.state, 1).weapon.ammo < actor(initial, 1).weapon.ammo, tick: shot.state.tick });
      if (!shot.found || actor(shot.state, 1).weapon.ammo >= actor(initial, 1).weapon.ammo) throw new Error("Manual reload requires an actually fired, partial magazine");
      await input(1, { ...aim(initial), Reload: true });
      const reload = await drive(90, "reload");
      row.observations.push({ kind: "reload-counter", observed: reload.found, tick: reload.state.tick });
      row.image = await screenshot("sim-hud-reload", reload.state);
      if (!reload.found) throw new Error("Reload input did not reach genuine empty-ammo reload state");
    });
    const events = await page.events();
    for (const event of events) if (event.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(event.params));
    await page.evaluate(original => {
      if (original === null) localStorage.removeItem("soldat-web.settings.v1");
      else localStorage.setItem("soldat-web.settings.v1", original);
    }, originalSettings);
    completed = true;
    await save();
  } catch (error) {
    errors.push(String(error)); await save(); throw error;
  }
}

const browserScript = `import * as fs from "node:fs/promises"; await (${browserCapture.toString()})(${JSON.stringify(config)});`;
const completion = Promise.withResolvers();
const child = spawn("ego-browser", ["nodejs", "-e", browserScript], { cwd: root, stdio: "inherit" });
child.once("error", completion.reject);
child.once("close", status => completion.resolve(status ?? 1));
const code = await completion.promise;
let browserResult;
try { browserResult = JSON.parse(await readFile(resolve(receipts, "combat-browser.json"), "utf8")); }
catch (error) { throw new Error(`Browser capture produced no receipt (exit ${code}): ${String(error)}`); }
if (browserResult.runId !== runId) throw new Error("Stale browser receipt rejected");
const comparisons = [];
for (const gallery of galleries) {
  const row = browserResult.rows.find(r => r.name === `native-${gallery.mode}`);
  if (row?.status !== "captured-awaiting-comparison") { comparisons.push({ mode: gallery.mode, status: row?.status ?? "pending", reason: row?.reason ?? row?.error }); continue; }
  try {
    const metrics = await compare(resolve(out, `combat-native-${gallery.mode}.png`), row.image, 8);
    row.status = metrics.pass ? "pass" : "fail";
    comparisons.push({ mode: gallery.mode, source: "actual-native-framebuffer-versus-browser-canvas", status: row.status, ...metrics });
  } catch (error) { row.status = "pending"; comparisons.push({ mode: gallery.mode, status: "pending", reason: String(error) }); }
}
const unchanged = hash(await readFile(resolve(root, "build-out/sim/sim.wasm"))) === identity.expectedWasmSha256;
const result = { ...browserResult, comparisons, wasmUnchangedDuringCapture: unchanged, threshold: { channelDeltaExclusive: 8, maxDifferingPixelPercent: 1 },
  status: code === 0 && unchanged && browserResult.completed && browserResult.errors.length === 0 && browserResult.rows.every(row => row.status === "pass") ? "pass" : "fail" };
await writeFile(resolve(receipts, "combat-results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (result.status !== "pass") process.exitCode = 1;
else {
  const finishing = Promise.withResolvers();
  const closer = spawn("ego-browser", ["nodejs", "-e", `const task = await taskSpace(${browserResult.taskSpaceId}); await task.finish({ keep: [] });`], { cwd: root, stdio: "inherit" });
  closer.once("error", finishing.reject);
  closer.once("close", status => finishing.resolve(status ?? 1));
  if (await finishing.promise !== 0) throw new Error("Combat capture passed but TaskSpace completion failed");
}
