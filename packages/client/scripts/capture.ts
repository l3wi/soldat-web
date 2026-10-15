import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compare } from "../../render-spike/scripts/compare";
import type {} from "../src/game";

const root = resolve(import.meta.dir, "../../.."), out = resolve(root, "tests/fixtures/render");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const base = process.env.CLIENT_URL ?? "http://127.0.0.1:5195";
try {
  await page.goto(`${base}/?capture&map=Airpirates`);
  await page.waitForFunction(() => (window.__soldatClient?.renders ?? 0) > 4);
  const actual = resolve(out, "client-Airpirates.png");
  await mkdir(out, { recursive: true });
  await page.locator("canvas").screenshot({ path: actual });
  const parity = await compare(resolve(out, "phaser-Airpirates.png"), actual);
  assert.ok(parity.percent <= 0.1, `Map parity exceeds 0.1%: ${parity.percent}`);
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
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole("button", { name: "Start sandbox" }).click();
    await page.waitForFunction(() => {
      const state = window.__soldatClient;
      return state?.ready && state.simulation !== "loading";
    });
    assert.equal(await page.locator("canvas").count(), 1);
    await page.getByRole("button", { name: "Enable audio" }).click();
    await page.getByText("Audio enabled.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Main menu", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("canvas").length === 0);
  }
  assert.deepEqual(errors, []);
  const result = { browser: await browser.version(), runtime: await page.evaluate(() => navigator.userAgent), width: 1280, height: 720, parity: { ...parity, pass: parity.percent <= 0.1 }, maps, servedNotices: 4, settingsPersisted: true, audioGesture: true, remountCycles: 3, browserErrors: errors, movementHashes: "pending G1 sim.wasm and Node receipts" };
  await writeFile(resolve(out, "client-results.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
