import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

// One installed Chrome, one disposable private profile, one page, serial matches.
const root = resolve(import.meta.dirname, "../../..");
const url = process.env.CLIENT_URL ?? "http://127.0.0.1:5199";
const expected = process.env.WASM_SHA256;
if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("Set WASM_SHA256 to the frozen ABI4 artifact");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (hash(await readFile(resolve(root, "build-out/sim/sim.wasm"))) !== expected) throw new Error("Local WASM differs from qualification pin");
const served = await fetch(`${url}/sim.wasm`);
if (!served.ok || hash(new Uint8Array(await served.arrayBuffer())) !== expected) throw new Error("Served WASM differs from qualification pin");
console.log(execFileSync("memory_pressure", { encoding: "utf8" }));
const screenshots = resolve(root, "tests/fixtures/render"), out = resolve(root, "build-out/client-g5");
await mkdir(screenshots, { recursive: true }); await mkdir(out, { recursive: true });
const receipt = { wasmSha256: expected, abiVersion: 0x00010004, runtime: "", privateHeadless: true, rows: [], errors: [], completed: false };
const save = () => writeFile(resolve(out, "bots-browser.json"), JSON.stringify(receipt, null, 2) + "\n");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => receipt.errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") receipt.errors.push(`${message.text()} ${message.location().url}`); });
  page.on("response", response => { if (response.status() >= 400) receipt.errors.push(`HTTP ${response.status()}: ${response.url()}`); });
  receipt.runtime = await browser.version();
  for (const mode of ["dm", "ctf"]) for (const count of [4, 8]) {
    const map = mode === "dm" ? "Arena" : "ctf_Ash";
    const row = { map, mode, bots: count, status: "running", samples: 0, movingSlots: [], shootingSlots: [], respawnedSlots: [], kills: 0, deaths: 0, scores: [], errors: [] };
    receipt.rows.push(row); await save();
    const servedWasm = await fetch(`${url}/sim.wasm`);
    if (!servedWasm.ok || hash(new Uint8Array(await servedWasm.arrayBuffer())) !== expected) throw new Error("Served WASM changed between bot matches");
    await page.goto(`${url}/?bots-check`, { waitUntil: "networkidle" });
    await page.waitForSelector("#map-choice option[value='Arena']");
    await page.selectOption("#map-choice", map);
    await page.selectOption("#game-mode", mode);
    await page.fill("#bot-count", String(count));
    await page.getByRole("button", { name: "Start sandbox", exact: true }).click();
    await page.waitForFunction(() => !!window.__soldatPractice && window.__soldatClient?.tick > 2, undefined, { timeout: 60_000 });
    // Secondary stays in limbo; primary applies immediately without fixture injections.
    const canvas = page.locator(".game-surface > canvas").first();
    await canvas.focus(); await page.keyboard.press("Control+Digit2"); await page.keyboard.press("Digit7");
    const chosen = await page.evaluate(() => window.__soldatPractice().players.find(player => player.slot === 1));
    if (chosen?.weapon !== 7 || chosen.secondaryWeapon !== 11) throw new Error("Limbo choice did not apply primary+secondary immediately");
    row.immediateWeaponChoice = { primary: chosen.weapon, secondary: chosen.secondaryWeapon };
    let previous, first;
    const moving = new Set(), shooting = new Set(), respawned = new Set(), thingStyles = new Set();
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const sample = await page.evaluate(() => ({ view: window.__soldatPractice(), diagnostics: { ...window.__soldatClient } }));
      if (/unavailable|stopped|error/i.test(sample.diagnostics.simulation)) throw new Error(sample.diagnostics.simulation);
      const view = sample.view; first ??= view; row.samples++;
      for (const style of view.thingStyles) thingStyles.add(style);
      if (view.players.length !== count + 1) throw new Error(`Expected ${count + 1} players; got ${view.players.length}`);
      const bots = view.players.filter(player => player.slot !== 1);
      for (const bot of bots) {
        const old = previous?.players.find(player => player.slot === bot.slot);
        if (!bot.name) throw new Error("Unnamed bot");
        if (mode === "dm" ? bot.team !== 0 : bot.team !== 1 && bot.team !== 2) throw new Error("Wrong bot team");
        if (old && Math.hypot(bot.x - old.x, bot.y - old.y) > 0.5) moving.add(bot.slot);
        if (old && bot.fired !== old.fired) shooting.add(bot.slot);
        if (old && (old.flags & 2) !== 0 && (bot.flags & 2) === 0) respawned.add(bot.slot);
      }
      row.tick = view.tick; row.hash = view.hash; row.kills = bots.reduce((sum, bot) => sum + bot.kills, 0);
      row.deaths = bots.reduce((sum, bot) => sum + bot.deaths, 0); row.scores = view.scores;
      row.players = view.players; row.droppedTicks = sample.diagnostics.droppedTicks;
      if (view.tick - first.tick >= 3600 && moving.size === count && shooting.size > 0 && respawned.size > 0 && row.kills > 0 && row.deaths > 0) break;
      previous = view;
      await page.waitForTimeout(100);
    }
    row.movingSlots = [...moving]; row.shootingSlots = [...shooting]; row.respawnedSlots = [...respawned];
    row.world = "original"; row.thingStyles = [...thingStyles].sort((a, b) => a - b);
    if (!thingStyles.has(16) || !thingStyles.has(17) || (mode === "ctf" && (!thingStyles.has(1) || !thingStyles.has(2))))
      row.errors.push("Original-world medikits, grenade kits or CTF flags were not observed");
    if (moving.size !== count || !shooting.size || !respawned.size || row.kills <= 0 || row.deaths <= 0) row.errors.push("Did not observe all required movement/fire/death/respawn/kill-score predicates");
    await page.keyboard.down("F1");
    const name = `bots-${mode}-${count}-${map.toLowerCase()}.png`;
    await page.screenshot({ path: resolve(screenshots, name) });
    await page.keyboard.up("F1");
    row.screenshot = `tests/fixtures/render/${name}`;
    row.status = row.errors.length ? "failed" : "passed";
    await save();
    if (row.errors.length) throw new Error(`${map}/${count}: ${row.errors.join("; ")}`);
  }
  if (hash(await readFile(resolve(root, "build-out/sim/sim.wasm"))) !== expected) throw new Error("Frozen WASM changed during capture");
  receipt.completed = receipt.rows.length === 4 && receipt.errors.length === 0;
  await save();
  if (!receipt.completed) throw new Error(`Browser errors: ${receipt.errors.join("; ")}`);
} catch (error) { receipt.errors.push(String(error)); await save(); throw error; }
finally { await browser.close(); }
console.log(JSON.stringify(receipt, null, 2));
