import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compare } from "./compare";
const root = resolve("../.."),
  out = resolve(root, "tests/fixtures/render");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: !process.argv.includes("--headed"),
  args: [
    "--mute-audio",
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
    "--force-device-scale-factor=1",
  ],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
const backend = process.argv.includes("--pixi") ? "pixi" : "phaser";
const base =
  (process.env.RENDER_URL ?? "http://127.0.0.1:5194") +
  (backend === "pixi" ? "/pixi.html" : "/");
const fixtures = process.argv.includes("--quick")
  ? ["synthetic"]
  : ["Airpirates", "Aero", "DesertWind", "Jungle", "inf_Biologic", "synthetic"];
const results = [];
for (const name of fixtures) {
  await page.goto(`${base}?capture&time=1&map=${name}&width=1280&height=720`);
  await page.waitForFunction(() => window.spike?.ready);
  await page.waitForFunction(() => window.spike.metrics().frames > 4);
  const path = resolve(out, `${backend}-${name}.png`);
  await page.locator("canvas").screenshot({ path });
  try {
    results.push(
      await compare(
        resolve(out, `native-${name === "synthetic" ? "Synthetic" : name}.png`),
        path,
      ),
    );
  } catch (error) {
    results.push({ name, error: String(error) });
  }
}
let gallery: unknown,
  performanceResult: unknown,
  lifecycle: unknown,
  performancePass: boolean | undefined,
  lifecyclePass: boolean | undefined;
if (!process.argv.includes("--quick")) {
  await page.goto(
    `${base}?capture&time=1&gostek&map=Airpirates&width=1280&height=720`,
  );
  await page.waitForFunction(
    () => window.spike?.ready && window.spike.metrics().frames > 4,
  );
  const galleryPath = resolve(out, `${backend}-gostek.png`);
  await page.locator("canvas").screenshot({ path: galleryPath });
  gallery = await page.evaluate(() => window.spike.metrics());
  results.push(await compare(resolve(out, "native-Gostek.png"), galleryPath));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(
    `${base}?capture&stress&map=ctf_Death&width=1920&height=1080`,
  );
  await page.waitForFunction(
    () => window.spike?.ready && window.spike.metrics().frames > 300,
  );
  await page.evaluate(() => window.spike.reset());
  await page.waitForTimeout(process.argv.includes("--long") ? 30000 : 5000);
  const measured = await page.evaluate(() => window.spike.metrics());
  performanceResult = measured;
  performancePass =
    measured.cpuP99 <= 6.94 &&
    measured.intervalP99 <= 6.94 &&
    measured.averageFps >= 144;
  const before = await page.evaluate(() => window.spike.metrics());
  await page.evaluate(() => window.spike.setTime(2));
  await page.waitForTimeout(100);
  const scratch = resolve(root, "build-out/render-spike");
  await mkdir(scratch, { recursive: true });
  const beforePath = resolve(scratch, `${backend}-before.png`);
  await page.locator("canvas").screenshot({ path: beforePath });
  await page.evaluate(() => window.spike.loseContext());
  await page.waitForFunction(() => window.spike.metrics().contextRestores > 0);
  await page.waitForTimeout(100);
  const restored = await page.evaluate(() => window.spike.metrics());
  const restoredPath = resolve(scratch, `${backend}-restored.png`);
  await page.locator("canvas").screenshot({ path: restoredPath });
  const restoreComparison = await compare(beforePath, restoredPath);
  const session = await page.context().newCDPSession(page);
  await session.send("HeapProfiler.collectGarbage");
  const heapBefore = await session.send("Runtime.getHeapUsage");
  const cycles = [];
  for (let i = 0; i < 3; i++)
    cycles.push(await page.evaluate(() => window.spike.recreate()));
  await session.send("HeapProfiler.collectGarbage");
  const heapAfter = await session.send("Runtime.getHeapUsage");
  lifecyclePass =
    restoreComparison.pass &&
    cycles.every((c) => c.created - c.destroyed === 1 && c.canvases === 1);
  lifecycle = {
    before,
    restored,
    restoreComparison,
    cycles,
    heapBefore,
    heapAfter,
  };
}
const gpu = await page.evaluate(() => {
  const gl = document.querySelector("canvas")!.getContext("webgl2")!,
    ext = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    vendor: ext
      ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR),
    renderer: ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
  };
});
const result = {
  browser: await browser.version(),
  gpu,
  userAgent: await page.evaluate(() => navigator.userAgent),
  platform: process.platform,
  arch: process.arch,
  fixtures: results,
  gallery,
  performance: performanceResult,
  performancePass,
  lifecycle,
  lifecyclePass,
  errors,
};
await writeFile(
  resolve(out, `${backend}-results.json`),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
await browser.close();
if (
  errors.length ||
  performancePass === false ||
  lifecyclePass === false ||
  results.some(
    (result) => "error" in result || ("pass" in result && !result.pass),
  )
)
  process.exitCode = 1;
