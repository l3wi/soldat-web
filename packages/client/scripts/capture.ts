import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compare } from "../../render-spike/scripts/compare";
import type {} from "../src/game";
import { createHash } from "node:crypto";
import { enterShell, openPractice, choosePracticeMap, leaveGame } from "./shell-driver.mjs";
import { stringifyReceipt } from "../../../scripts/receipt-paths.mjs";

const root = resolve(import.meta.dir, "../../.."), out = resolve(root, "tests/fixtures/render");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--mute-audio", "--force-device-scale-factor=1"] });
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
  await page.goto(`${base}/?capture-check`);
  await enterShell(page);
  await openPractice(page);
  await page.getByRole("button", { name: /^Map / }).click();
  const names = await page.getByRole("option").allTextContents();
  const maps = names.length;
  assert.equal(maps, 99);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Credits & licenses", exact: true }).click();
  await page.getByText("Notices, licenses & source provenance", { exact: true }).click();
  await page.waitForSelector(".credits .notice-text", { state: "attached" });
  assert.equal(await page.locator(".notice-text").count(), 4);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: /^Graphics & controls\b/ }).click();
  await page.getByLabel("Texture filtering").selectOption("nearest");
  await page.getByLabel("Use mipmaps").uncheck();
  await page.getByRole("button", { name: "Move left", exact: false }).click();
  await page.keyboard.press("ArrowLeft");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("soldat-web.settings.v1")!));
  assert.equal(saved.filter, "nearest"); assert.equal(saved.mipmaps, false); assert.equal(saved.bindings.left, "ArrowLeft");
  await page.getByRole("button", { name: "Back [Esc]", exact: true }).click();
  await openPractice(page);
  await choosePracticeMap(page, "Airpirates");
  const soundRuns: unknown[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole("button", { name: "Start practice [Enter]", exact: true }).click();
    await page.waitForFunction(() => {
      const state = window.__soldatClient;
      return state?.ready && state.simulation !== "loading";
    });
    const game = page.locator('canvas[aria-label$="local sandbox"]');
    assert.equal(await game.count(), 1);
    await game.focus();
    // Initial original limbo captures gameplay until primary selection.
    await page.keyboard.press("Digit4");
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: "right" });
    await page.waitForFunction(() => (window.__soldatClient?.playedSounds ?? 0) > 0, undefined, { timeout: 20_000 });
    await page.mouse.up({ button: "right" });
    if (cycle === 0) await game.screenshot({ path: resolve(out, "client-sim-Airpirates.png") });
    await page.evaluate(() => window.__soldatCapture!.respawn());
    const live = await page.evaluate(() => window.__soldatClient);
    assert.ok(live && live.tick > 0 && !/unavailable|stopped/i.test(live.simulation));
    soundRuns.push(live);
    await leaveGame(page);
    await openPractice(page);
  }
  assert.deepEqual(errors, []);
  const mapLoads: unknown[] = [];
  if (process.argv.includes("--maps")) {
    for (const label of names) {
      const name = label.replace(/^\d+\s*/, "");
      await choosePracticeMap(page, name);
      await page.getByRole("button", { name: "Start practice [Enter]", exact: true }).click();
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
      await leaveGame(page);
      await openPractice(page);
    }
    await writeFile(resolve(root, "build-out/client-g2/maps-chrome.json"), stringifyReceipt(mapLoads) + "\n");
  }
  assert.deepEqual(errors, []);
  assert.equal(createHash("sha256").update(await readFile(resolve(root, "build-out/sim/sim.wasm"))).digest("hex"), wasmSha256, "WASM changed during capture");
  const result = { wasmSha256, browser: await browser.version(), runtime: await page.evaluate(() => navigator.userAgent), width: 1280, height: 720, parity: { ...parity, pass: parity.percent <= 0.1 }, nativeParity, maps, mapsLoaded: mapLoads.length, servedNotices: 4, settingsPersisted: true, audioGesture: true, soundRuns, remountCycles: 3, browserErrors: errors, movementHashes: "separate rendered-loop receipts in build-out/client-g2" };
  await writeFile(resolve(out, "client-results.json"), stringifyReceipt(result) + "\n");
  console.log(stringifyReceipt(result));
} finally { await browser.close(); }
