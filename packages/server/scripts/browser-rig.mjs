import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arenaControl } from "./workload.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Run inside ego-browser nodejs; pass its taskSpace helper explicitly.
 * Example: await (await import("file:///.../browser-rig.mjs")).runBrowserRig({taskSpace, clientUrl:"http://127.0.0.1:5195",out:"build-out/net-g4/browser-browser",browserPlayers:2});
 */
export async function runBrowserRig({ taskSpace, clientUrl, out, players = 2, browserPlayers = 2, seconds = 120, impaired = false, combat = false, capturePixels = false, spaceId, task: existingTask, finishTask = true }) {
  out = resolve(root, out); await mkdir(out, { recursive: true });
  const task = existingTask ?? await taskSpace(spaceId ?? "Soldat Phase 4 real networking qualification");
  console.log(JSON.stringify({ type: "browser-space", spaceId: task.spaceId }));
  const child = spawn("node", ["--experimental-transform-types", "packages/server/scripts/run.ts", "--players", String(players), "--browser-players", String(browserPlayers), "--seconds", String(seconds), "--out", out, ...(impaired ? ["--impaired"] : []), ...(combat ? ["--combat"] : [])], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", remainder = "";
  let listeningResolve, listeningReject;
  const listening = new Promise((resolveReady, reject) => { listeningResolve = resolveReady; listeningReject = reject; });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { if (code === 0) resolveExit(); else reject(new Error(`Real WSS rig exited ${code}/${signal}: ${stderr}`)); });
  });
  // Keep rejection handled until teardown awaits the child.
  exited.catch(error => listeningReject(error));
  child.stdout.on("data", chunk => {
    stdout += chunk.toString(); remainder += chunk.toString();
    const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
    for (const line of lines) {
      try { const message = JSON.parse(line); if (message.type === "rig-listening") listeningResolve(message); } catch { /* Non-JSON runtime warnings remain in raw stdout. */ }
    }
  });
  const captureErrors = [];
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const samples = [], finals = [], events = [], errors = [], pages = [];
  const pageScripts = [];
  let completed = false;
  try {
    let listenTimeout;
    const server = await Promise.race([listening, new Promise((_, reject) => { listenTimeout = setTimeout(() => reject(new Error("WSS rig did not listen")), 90_000); })]).finally(() => clearTimeout(listenTimeout));
    for (let i = 0; i < browserPlayers; i++) {
      const page = i === 0 ? task.page("p1") : await task.newPage(); pages.push(page);
      await page.cdp("Security.setIgnoreCertificateErrors", { ignore: true });
      const instrumentation = await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        const Native = window.WebSocket;
        window.__netG4Bytes = { sent: 0, received: 0 };
        window.WebSocket = class extends Native {
          constructor(...args) { super(...args); this.addEventListener('message', event => { window.__netG4Bytes.received += event.data.byteLength ?? event.data.size ?? 0; }); }
          send(data) { window.__netG4Bytes.sent += data.byteLength ?? data.size ?? 0; return super.send(data); }
        };
        window.__netG4Errors = [];
        window.addEventListener('error', event => window.__netG4Errors.push(event.message));
        window.addEventListener('unhandledrejection', event => window.__netG4Errors.push(String(event.reason)));
        window.__netG4Samples = []; window.__netG4Events = [];
        window.__netG4InputsSent = 0;
        let online;
        Object.defineProperty(window, '__soldatOnline', { configurable: true, get() { return online; }, set(hook) {
          online = hook; if (!hook) return;
          const originalSend = hook.session.options.send;
          hook.session.options.send = message => { if (message.type === 'input') window.__netG4InputsSent++; originalSend(message); };
          hook.onSnapshot = metrics => window.__netG4Samples.push({ type: 'snapshot', player: ${i + 1}, at: performance.now(), measurementElapsedMs: window.__netG4MeasurementStart === undefined ? -1 : performance.now() - window.__netG4MeasurementStart, metrics: { ...metrics }, bytesSent: window.__netG4Bytes.sent, bytesReceived: window.__netG4Bytes.received, inputsSent: window.__netG4InputsSent, visibility: document.visibilityState, renders: window.__soldatClient?.renders ?? 0 });
          const original = hook.session.options.onEvent, seen = new Set();
          hook.session.options.onEvent = event => {
            window.__netG4Events.push({ type: 'logical-event', player: ${i + 1}, id: event.id, tick: event.tick, kind: new DataView(event.header.buffer, event.header.byteOffset).getUint32(0, true), duplicate: seen.has(event.id) });
            seen.add(event.id); original?.(event);
          };
        } });
      })();` });
      pageScripts.push({ page, identifier: instrumentation.identifier });
      const url = new URL(clientUrl); url.searchParams.set("server", server.url); url.searchParams.set("map", "Arena"); url.searchParams.set("nickname", `Browser-${i + 1}`);
      await page.goto(url.href);
      await page.waitForFunction(() => window.__soldatOnline?.metrics.hashMatches > 0, undefined, { timeout: 60_000 });
      await page.evaluate(({ player, controlSource, combat }) => {
        const control = (0, eval)(`(${controlSource})`);
        const names = ["Left", "Right", "Up", "Down", "Fire", "Jetpack", "ThrowNade", "ChangeWeapon", "ThrowWeapon", "Reload", "Prone", "FlagThrow"];
        const hook = window.__soldatOnline;
        window.__netG4InputTimer = setInterval(() => {
          const c = control(hook.metrics.predictedTick, player, combat);
          const input = new Uint8Array(12), view = new DataView(input.buffer);
          let bits = 0; names.forEach((name, bit) => { if (c[name]) bits |= 1 << bit; });
          view.setUint16(0, bits, true); view.setInt16(2, c.MouseAimX ?? 0, true); view.setInt16(4, c.MouseAimY ?? 0, true); view.setInt16(6, c.MouseDist ?? 0, true); view.setUint16(8, c.pressOrder ?? 0, true);
          hook.input = input;
        }, 8);
        window.__netG4AgeTimer = setInterval(() => window.__netG4Samples.push({ type: "render-age", player, at: performance.now(), measurementElapsedMs: window.__netG4MeasurementStart === undefined ? -1 : performance.now() - window.__netG4MeasurementStart, metrics: { ...hook.metrics }, bytesSent: window.__netG4Bytes.sent, bytesReceived: window.__netG4Bytes.received, inputsSent: window.__netG4InputsSent, visibility: document.visibilityState, renders: window.__soldatClient?.renders ?? 0 }), 250);
      }, { player: i + 1, controlSource: arenaControl.toString(), combat });
    }
    for (const page of pages) {
      const visibility = await page.evaluate(() => { window.__netG4MeasurementStart = performance.now(); window.__netG4RenderStart = window.__soldatClient?.renders ?? 0; return document.visibilityState; });
      if (visibility !== "visible") throw new Error("Every real browser page must actually be visible; focus/visibility emulation is not used");
    }
    await writeFile(resolve(out, "browser-ready.json"), JSON.stringify({ admitted: pages.length, at: new Date().toISOString() }));
    const end = performance.now() + (seconds + 2) * 1000;
    while (performance.now() < end) {
      for (const page of pages) {
        const batch = await page.evaluate(() => ({ samples: window.__netG4Samples.splice(0), events: window.__netG4Events.splice(0), errors: window.__netG4Errors.splice(0) }));
        samples.push(...batch.samples); events.push(...batch.events); errors.push(...batch.errors);
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const result = await page.evaluate(player => {
        clearInterval(window.__netG4InputTimer); clearInterval(window.__netG4AgeTimer);
        const hook = window.__soldatOnline; if (hook) hook.input = new Uint8Array(12);
        return { final: { type: "final", player, metrics: hook ? { ...hook.metrics } : null, bytesSent: window.__netG4Bytes.sent, bytesReceived: window.__netG4Bytes.received, inputsSent: window.__netG4InputsSent, visibility: document.visibilityState, renders: window.__soldatClient?.renders ?? 0 }, samples: window.__netG4Samples.splice(0), events: window.__netG4Events.splice(0), errors: window.__netG4Errors.splice(0), visibility: document.visibilityState, userAgent: navigator.userAgent, renders: window.__soldatClient?.renders ?? 0, rendersAtStart: window.__netG4RenderStart, elapsedMs: performance.now() - window.__netG4MeasurementStart };
      }, i + 1);
      finals.push(result.final); samples.push(...result.samples); events.push(...result.events); errors.push(...result.errors);
      if (capturePixels) {
        try {
          const image = await page.cdp("Page.captureScreenshot", { format: "png", fromSurface: false, captureBeyondViewport: false }, { timeout: 2000 });
          await writeFile(resolve(out, `browser-${i + 1}.png`), Buffer.from(image.data, "base64"));
        } catch (error) { captureErrors.push({ player: i + 1, error: String(error), note: "Screenshot unavailable; raw real-client metrics/events preserved independently" }); }
      }
      await writeFile(resolve(out, `browser-${i + 1}-dom.txt`), String(await page.snapshot()));
      await writeFile(resolve(out, `browser-${i + 1}-environment.json`), JSON.stringify({ visibility: result.visibility, userAgent: result.userAgent, renders: result.renders, rendersAtStart: result.rendersAtStart, elapsedMs: result.elapsedMs, observedRendersPerSecond: (result.renders - result.rendersAtStart) * 1000 / result.elapsedMs, note: "Actual ordinary online scene render counter; includes warmup, not a physical display-refresh claim. Pixel capture optional because CDP screenshots time out in this Ego session." }));
    }
    await writeFile(resolve(out, "browser-results.json"), JSON.stringify({ samples, finals, events, errors, captureErrors, humanPlay: false }));
    await exited;
    completed = true;
    return { spaceId: task.spaceId, out, browserPlayers, samples: samples.length, events: events.length, errors, captureErrors };
  } catch (error) {
    await writeFile(resolve(out, "browser-failure.json"), JSON.stringify({ error: String(error), samples, finals, events, errors, captureErrors, humanPlay: false }));
    throw error;
  } finally {
    if (!completed) { child.kill("SIGTERM"); await exited.catch(() => {}); }
    for (const { page, identifier } of pageScripts) await page.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await writeFile(resolve(out, "runner-stdout.log"), stdout);
    await writeFile(resolve(out, "runner-stderr.log"), stderr);
    if (completed && finishTask) await task.finish({ keep: [] });
  }
}

export async function runBrowserSuite({ taskSpace, clientUrl, out = "build-out/net-g4/final/browser", seconds = 120, spaceId }) {
  out = resolve(root, out);
  const task = await taskSpace(spaceId ?? "Soldat Phase 4 real networking qualification");
  const results = [];
  for (const impaired of [false, true]) for (const players of [2, 8]) for (const browserPlayers of [2, 1]) {
    const name = `${impaired ? "100ms-15ms-1pct" : "lan"}-${players}-${browserPlayers === 2 ? "browser-browser" : "browser-headless"}`;
    results.push(await runBrowserRig({ taskSpace, task, clientUrl, out: resolve(out, name), players, browserPlayers, seconds, impaired, finishTask: false }));
    for (const page of await task.pages()) if (page.label !== "p1") await page.close();
  }
  await task.finish({ keep: [] });
  console.log(JSON.stringify({ type: "browser-suite-result", results }));
  return results;
}
