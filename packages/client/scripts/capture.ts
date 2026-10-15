import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compare } from "../../render-spike/scripts/compare";
import type {} from "../src/game";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "../../.."), out = resolve(root, "tests/fixtures/render");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const base = process.env.CLIENT_URL ?? "http://127.0.0.1:5195";
try {
  const wasmSha256 = createHash("sha256").update(await readFile(resolve(root, "build-out/sim/sim.wasm"))).digest("hex");
  await page.goto(`${base}/?capture&map=Airpirates`);
  await page.waitForFunction(() => (window.__soldatClient?.renders ?? 0) > 4);
  const actual = resolve(out, "client-Airpirates.png");
  await mkdir(out, { recursive: true });
  await page.locator("canvas").screenshot({ path: actual });
  const parity = await compare(resolve(out, "phaser-Airpirates.png"), actual);
  assert.ok(parity.percent <= 0.1, `Map parity exceeds 0.1%: ${parity.percent}`);
  const nativeParity: Record<string, unknown> = {};
  for (const map of ["Airpirates", "Aero", "DesertWind", "Jungle", "inf_Biologic", "ctf_Death"]) {
    if (map !== "Airpirates") {
      await page.goto(`${base}/?capture&map=${map}`);
      await page.waitForFunction(() => (window.__soldatClient?.renders ?? 0) > 4);
      await page.locator("canvas").screenshot({ path: resolve(out, `client-${map}.png`) });
    }
    const result = await compare(resolve(out, `native-${map}.png`), resolve(out, `client-${map}.png`));
    assert.ok(result.percent <= 1, `Native ${map} parity exceeds SPEC 1%: ${result.percent}`);
    nativeParity[map] = result;
  }
  await page.goto(base);
  await page.waitForSelector("#map-choice option");
  const maps = await page.locator("#map-choice option").count();
  assert.equal(maps, 99);
  await page.getByRole("button", { name: "Credits & Licenses", exact: true }).click();
  await page.waitForSelector(".credits .notice-text", { state: "attached" });
  assert.equal(await page.locator(".notice-text").count(), 4);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Texture filtering").selectOption("nearest");
  await page.getByLabel("Use mipmaps").uncheck();
  await page.getByRole("button", { name: "Move left", exact: false }).click();
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("button", { name: "Apply settings" }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("soldat-web.settings.v1")!));
  assert.equal(saved.filter, "nearest"); assert.equal(saved.mipmaps, false); assert.equal(saved.bindings.left, "ArrowLeft");
  await page.getByRole("button", { name: "Choose map", exact: true }).click();
  await page.selectOption("#map-choice", "Airpirates");
  const soundRuns: unknown[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole("button", { name: "Start sandbox" }).click();
    await page.waitForFunction(() => {
      const state = window.__soldatClient;
      return state?.ready && state.simulation !== "loading";
    });
    assert.equal(await page.locator("canvas").count(), 1);
    await page.getByRole("button", { name: "Enable audio" }).click();
    await page.getByText("Audio enabled.", { exact: true }).waitFor();
    await page.locator("canvas").focus();
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: "right" });
    await page.waitForFunction(() => (window.__soldatClient?.playedSounds ?? 0) > 0, undefined, { timeout: 20_000 });
    await page.mouse.up({ button: "right" });
    if (cycle === 0) await page.locator("canvas").screenshot({ path: resolve(out, "client-sim-Airpirates.png") });
    await page.getByRole("button", { name: "Respawn", exact: true }).click();
    const live = await page.evaluate(() => window.__soldatClient);
    assert.ok(live && live.tick > 0 && !/unavailable|stopped/i.test(live.simulation));
    soundRuns.push(live);
    await page.getByRole("button", { name: "Main menu", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("canvas").length === 0);
  }
  assert.deepEqual(errors, []);
  const mapLoads: unknown[] = [];
  if (process.argv.includes("--maps")) {
    await page.getByRole("button", { name: "Choose map", exact: true }).click();
    const names = await page.locator("#map-choice option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    for (const name of names) {
      await page.selectOption("#map-choice", name);
      await page.getByRole("button", { name: "Start sandbox" }).click();
      await page.waitForFunction(() => (window.__soldatClient?.tick ?? 0) > 1 || /unavailable|stopped/i.test(window.__soldatClient?.simulation ?? ""), undefined, { timeout: 120_000 });
      const state = await page.evaluate(() => window.__soldatClient);
      assert.ok(state && state.tick > 1 && state.ready, `Map ${name}: ${JSON.stringify(state)}`);
      if (name === "ctf_Aftermath" || name === "ctf_Amnesia") assert.match(state!.simulation, /WARNING.*terrain/);
      if (["Bigfalls", "htf_Zajacz", "MrSnowman"].includes(name)) {
        await page.waitForFunction(() => (window.__soldatClient?.sparks ?? 0) > 0 || /unavailable|stopped/i.test(window.__soldatClient?.simulation ?? ""), undefined, { timeout: 20_000 });
        const weather = await page.evaluate(() => window.__soldatClient);
        assert.ok(weather && weather.sparks > 0, `Weather ${name}: ${JSON.stringify(weather)}`);
        Object.assign(state!, weather);
        await page.locator("canvas").screenshot({ path: resolve(out, `client-weather-${name}.png`) });
      }
      mapLoads.push({ name, ...state });
      await page.getByRole("button", { name: "Main menu", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll("canvas").length === 0);
    }
    await writeFile(resolve(root, "build-out/client-g2/maps-chrome.json"), JSON.stringify(mapLoads, null, 2) + "\n");
  }
  assert.deepEqual(errors, []);
  assert.equal(createHash("sha256").update(await readFile(resolve(root, "build-out/sim/sim.wasm"))).digest("hex"), wasmSha256, "WASM changed during capture");
  const result = { wasmSha256, browser: await browser.version(), runtime: await page.evaluate(() => navigator.userAgent), width: 1280, height: 720, parity: { ...parity, pass: parity.percent <= 0.1 }, nativeParity, maps, mapsLoaded: mapLoads.length, servedNotices: 4, settingsPersisted: true, audioGesture: true, soundRuns, remountCycles: 3, browserErrors: errors, movementHashes: "separate rendered-loop receipts in build-out/client-g2" };
  await writeFile(resolve(out, "client-results.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
