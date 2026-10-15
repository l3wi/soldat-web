import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(() => {
  Object.assign(window, { renderDrawCalls: 0 });
  const prototype = WebGL2RenderingContext.prototype;
  const arrays = prototype.drawArrays;
  const elements = prototype.drawElements;
  const arraysInstanced = prototype.drawArraysInstanced;
  const elementsInstanced = prototype.drawElementsInstanced;
  // Test-only driver-boundary instrumentation, not a Phaser/Pixi source patch.
  prototype.drawArrays = function (...args) {
    window.renderDrawCalls++;
    return arrays.apply(this, args);
  };
  prototype.drawElements = function (...args) {
    window.renderDrawCalls++;
    return elements.apply(this, args);
  };
  prototype.drawArraysInstanced = function (...args) {
    window.renderDrawCalls++;
    return arraysInstanced.apply(this, args);
  };
  prototype.drawElementsInstanced = function (...args) {
    window.renderDrawCalls++;
    return elementsInstanced.apply(this, args);
  };
});
const results = [];
for (const backend of ["phaser", "pixi"]) {
  const entry = backend === "pixi" ? "pixi.html" : "";
  await page.goto(
    `http://127.0.0.1:5194/${entry}?capture&stress&map=ctf_Death&width=1920&height=1080`,
  );
  await page.waitForFunction(
    () => window.spike?.ready && window.spike.metrics().frames > 100,
  );
  const before = await page.evaluate(() => ({
    calls: window.renderDrawCalls,
    frames: window.spike.metrics().frames,
  }));
  await page.waitForFunction(
    (frames) => window.spike.metrics().frames >= frames + 600,
    before.frames,
  );
  const after = await page.evaluate(() => ({
    calls: window.renderDrawCalls,
    frames: window.spike.metrics().frames,
    ownCalls: window.spike.metrics().drawCalls,
  }));
  results.push({
    backend,
    frames: after.frames - before.frames,
    drawCalls: after.calls - before.calls,
    drawCallsPerFrame:
      (after.calls - before.calls) / (after.frames - before.frames),
    soldatCallsPerFrame: after.ownCalls,
  });
}
await writeFile(
  resolve("../../tests/fixtures/render/draw-calls.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify(results, null, 2));
await browser.close();

declare global {
  interface Window {
    renderDrawCalls: number;
  }
}
