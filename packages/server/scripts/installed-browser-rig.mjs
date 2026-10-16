import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch, totalmem, freemem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { runBrowserRig } from "./browser-rig.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const executables = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  firefox: "/Applications/Firefox.app/Contents/MacOS/firefox",
};

// Only sockets discovered on this invocation's private endpoint are connected.
class Connection {
  constructor(url, record, signal) {
    this.pending = new Map();
    this.nextId = 0;
    this.record = record;
    this.url = url;
    this.socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ready = new Promise((resolveReady, reject) => {
      this.socket.once("open", resolveReady);
      this.socket.once("error", reject);
      this.socket.once("close", () => reject(new Error(`CDP closed before opening: ${url}`)));
    });
    this.ready.catch(() => {});
    this.socket.on("error", error => this.rejectPending(error));
    this.socket.on("close", (code, reason) => this.rejectPending(new Error(`CDP closed ${code}: ${reason}`)));
    this.socket.on("message", data => {
      try {
        const message = JSON.parse(data.toString());
        record({ direction: "received", endpoint: url, message });
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
      } catch (error) { this.rejectPending(error); }
    });
    this.signal = signal;
    this.onAbort = () => this.close();
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.close();
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  async send(method, params = {}, { timeout = 15_000 } = {}) {
    this.signal.throwIfAborted();
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error(`CDP is not open: ${method}`);
    const id = ++this.nextId;
    const message = { id, method, params };
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
      this.pending.set(id, { method, resolve: resolveReply, reject, timer });
      this.record({ direction: "sent", endpoint: this.url, message });
      this.socket.send(JSON.stringify(message), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  close() {
    this.signal.removeEventListener("abort", this.onAbort);
    this.rejectPending(new Error("Private CDP connection closed"));
    this.socket.terminate();
  }
}

class InstalledPage {
  constructor(task, target, label) {
    this.task = task; this.targetId = target.id; this.label = label;
    this.connection = task.connect(target.webSocketDebuggerUrl);
    this.ready = this.connection.send("Runtime.enable");
    this.ready.catch(() => {});
    this.preloads = new Map();
  }

  async cdp(method, params, options) {
    await this.ready;
    if (this.task.bidi && method === "Page.addScriptToEvaluateOnNewDocument") {
      // Firefox 115's CDP method stores source but never evaluates it.
      // Register the real BiDi preload at goto, once its exact URL is known.
      const identifier = randomUUID();
      this.preloads.set(identifier, { source: params.source });
      return { identifier };
    }
    if (this.task.bidi && method === "Page.removeScriptToEvaluateOnNewDocument") {
      const preload = this.preloads.get(params.identifier);
      if (!preload) throw new Error(`Unknown private preload ${params.identifier}`);
      if (preload.script) await this.task.bidi.send("script.removePreloadScript", { script: preload.script });
      this.preloads.delete(params.identifier);
      return {};
    }
    return this.connection.send(method, params, options);
  }

  async evaluate(fnOrString, argument) {
    const expression = typeof fnOrString === "function"
      ? `(${fnOrString.toString()})(${argument === undefined ? "undefined" : JSON.stringify(argument)})`
      : fnOrString;
    const reply = await this.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(`Page evaluation failed: ${JSON.stringify(reply.exceptionDetails)}`);
    if (reply.result?.unserializableValue !== undefined) throw new Error(`Non-JSON page result: ${reply.result.unserializableValue}`);
    return reply.result?.value;
  }

  async goto(url) {
    // Firefox 115 has global-only BiDi preloads. Guard by the exact destination
    // so each player's unchanged instrumentation executes only in its own page.
    for (const preload of this.preloads.values()) {
      if (preload.script) await this.task.bidi.send("script.removePreloadScript", { script: preload.script });
      const result = await this.task.bidi.send("script.addPreloadScript", {
        functionDeclaration: `() => { if (location.href === ${JSON.stringify(url)}) { ${preload.source}\n } }`,
      });
      preload.script = result.script;
    }
    await this.cdp("Page.enable");
    const result = await this.cdp("Page.navigate", { url });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await this.waitForFunction(expected => location.href === expected && ["interactive", "complete"].includes(document.readyState), url, { timeout: 60_000 });
  }

  async waitForFunction(fn, argument, { timeout = 30_000 } = {}) {
    const deadline = performance.now() + timeout;
    do {
      this.task.signal.throwIfAborted();
      if (await this.evaluate(fn, argument)) return;
      await delay(100, undefined, { signal: this.task.signal });
    } while (performance.now() < deadline);
    throw new Error(`${this.label}: page condition timed out after ${timeout}ms`);
  }

  snapshot() {
    return this.evaluate(() => document.documentElement.outerHTML);
  }

  async close() {
    await this.task.browser.send("Target.closeTarget", { targetId: this.targetId });
    this.connection.close(); this.task.managed.delete(this.label);
  }
}

/** Minimal task/page adapter for runBrowserRig, not a general browser API.
 * Creates only private installed headless browser processes and real windows.
 * Firefox 115's Target.createTarget ignores newWindow, so use a genuine popup.
 * Firefox pre-document instrumentation uses real BiDi preloads because 115's
 * CDP addScriptToEvaluateOnNewDocument does not execute its supplied source.
 * Visibility is never overridden; runBrowserRig rejects hidden clients.
 */
export async function createInstalledBrowserTask({ engine, out, signal = new AbortController().signal }) {
  const executable = executables[engine];
  if (!executable) throw new Error("--engine must be chrome or firefox (installed Firefox 115)");
  await access(executable);
  out = resolve(root, out);
  await mkdir(out, { recursive: true });
  const lockPath = resolve(tmpdir(), "soldat-net-g4-installed-browser.lock");
  const lock = await open(lockPath, "wx").catch(error => {
    if (error.code === "EEXIST") throw new Error(`Another private qualification owns ${lockPath}; do not run browser lanes concurrently`);
    throw error;
  });
  const connections = new Set(), managed = new Map(), logs = [];
  let profile, child, childClosed, launchError, browser, endpoint, closing;
  const environment = { engine, executable, headless: true, privateProfile: true, visibilityEmulation: false, platform: platform(), architecture: arch(), node: process.version, totalMemory: totalmem(), freeMemoryBeforeLaunch: freemem(), ownerPid: process.pid, startedAt: new Date().toISOString() };
  const makeLog = name => {
    const stream = createWriteStream(resolve(out, name), { flags: "wx" });
    const log = { stream, error: undefined };
    stream.on("error", error => { log.error = error; });
    logs.push(log); return stream;
  };
  const shutdown = () => closing ??= (async () => {
    for (const connection of connections) connection.close();
    const killOwnedGroup = signalName => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, signalName); } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    // A detached process group contains only this owned browser and its helpers.
    // Never search for or signal a browser by executable name.
    try {
      if (child?.pid) {
        killOwnedGroup("SIGTERM");
        let timer;
        const stopped = await Promise.race([childClosed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 5000); })]).finally(() => clearTimeout(timer));
        killOwnedGroup("SIGKILL");
        if (!stopped) await childClosed;
      }
    } finally {
      try {
        await Promise.all(logs.map(({ stream }) => new Promise(resolveEnd => {
          if (stream.closed || stream.destroyed) return resolveEnd();
          stream.once("close", resolveEnd); stream.end();
        })));
        environment.finishedAt = new Date().toISOString();
        environment.exit = child ? { code: child.exitCode, signal: child.signalCode, launchError: launchError && String(launchError) } : null;
        environment.logErrors = logs.flatMap(log => log.error ? [String(log.error)] : []);
        await writeFile(resolve(out, "installed-browser-environment.json"), JSON.stringify(environment, null, 2) + "\n");
      } finally {
        try { if (profile) await rm(profile, { recursive: true, force: true }); }
        finally { await lock.close(); await rm(lockPath); }
      }
    }
    if (environment.logErrors?.length) throw new Error(`Private browser evidence log failure: ${environment.logErrors.join("; ")}`);
  })();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, engine, out }));
    signal.throwIfAborted();
    const memory = await promisify(execFile)("memory_pressure", [], { encoding: "utf8", signal });
    await writeFile(resolve(out, "memory-pressure-before-browser.log"), memory.stdout + memory.stderr);
    environment.memoryPressure = memory;
    console.log(memory.stdout);
    profile = await mkdtemp(resolve(tmpdir(), `soldat-net-g4-${engine}-`));
    environment.profile = profile;
    if (engine === "firefox") {
      const prefs = {
        "remote.active-protocols": 3,
        "browser.shell.checkDefaultBrowser": false,
        "browser.startup.homepage_override.mstone": "ignore",
        "browser.startup.page": 0,
        "browser.startup.homepage": "about:blank",
        "browser.aboutwelcome.enabled": false,
        "browser.sessionstore.resume_from_crash": false,
        "dom.disable_open_during_load": false,
        "browser.link.open_newwindow": 2,
        "browser.link.open_newwindow.restriction": 0,
      };
      await writeFile(resolve(profile, "user.js"), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n") + "\n");
      environment.profilePreferences = prefs;
    }
    const args = engine === "chrome"
      ? ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--window-size=1280,720", "about:blank"]
      : ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port=0", "--width=1280", "--height=720", "about:blank"];
    environment.args = args;
    const protocol = makeLog("installed-browser-cdp.jsonl");
    const record = entry => protocol.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
    const stdout = makeLog("installed-browser-stdout.log"), stderr = makeLog("installed-browser-stderr.log");
    signal.throwIfAborted();
    child = spawn(executable, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    environment.browserPid = child.pid;
    childClosed = new Promise(resolveClose => child.once("close", resolveClose));
    child.on("error", error => { launchError = error; });
    child.stdout.pipe(stdout, { end: false }); child.stderr.pipe(stderr, { end: false });
    let bootOutput = "";
    const discover = data => {
      bootOutput = (bootOutput + data.toString()).slice(-32_768);
      const match = bootOutput.match(/(?:DevTools|WebDriver BiDi) listening on (ws:\/\/[^\s]+)/);
      if (match) {
        const url = new URL(match[1]);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) { launchError = new Error(`Non-loopback debugging endpoint: ${url}`); return; }
        endpoint = `http://${url.host}`;
      }
    };
    child.stdout.on("data", discover); child.stderr.on("data", discover);
    const checkAlive = () => {
      signal.throwIfAborted();
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${engine} exited before qualification: ${child.exitCode}/${child.signalCode}`);
      for (const log of logs) if (log.error) throw log.error;
    };
    let version;
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      checkAlive();
      if (endpoint) {
        try {
          const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
          if (response.ok) { version = await response.json(); if (version.webSocketDebuggerUrl) break; }
        } catch (error) { signal.throwIfAborted(); environment.lastDiscoveryError = String(error); }
      }
      await delay(100, undefined, { signal });
    }
    if (!version?.webSocketDebuggerUrl) throw new Error(`Private ${engine} CDP endpoint did not become ready`);
    environment.endpoint = endpoint; environment.version = version;
    const connect = url => {
      const parsed = new URL(url);
      if (parsed.protocol !== "ws:" || parsed.host !== new URL(endpoint).host) throw new Error(`CDP endpoint escaped owned browser: ${url}`);
      const connection = new Connection(url, record, signal); connections.add(connection); return connection;
    };
    browser = connect(version.webSocketDebuggerUrl);
    environment.protocolVersion = await browser.send("Browser.getVersion");
    if (engine === "firefox" && !/^(?:Headless)?Firefox\/115(?:\.|$)/.test(environment.protocolVersion.product)) throw new Error(`Require installed Firefox 115, got ${environment.protocolVersion.product}`);
    let bidi;
    if (engine === "firefox") {
      bidi = connect(`ws://${new URL(endpoint).host}/session`);
      // Firefox 115's session.new uses the pre-matching capabilities format.
      // Certificate handling stays on the genuine CDP Security command used by
      // runBrowserRig, not an unsupported profile preference or fake response.
      environment.bidiSession = await bidi.send("session.new", {});
    }
    const targets = async () => {
      checkAlive();
      const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (!response.ok) throw new Error(`Private target discovery returned ${response.status}`);
      return (await response.json()).filter(target => target.type === "page");
    };
    const task = {
      spaceId: `private-${engine}-${child.pid}`, signal, managed, browser, bidi, connect,
      page(label) {
        const page = managed.get(label);
        if (!page) throw new Error(`Unknown private page ${label}`);
        return page;
      },
      async newPage() {
        let id;
        if (engine === "chrome") {
          ({ targetId: id } = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true, background: false, width: 1280, height: 720 }));
        } else {
          const before = new Set((await targets()).map(target => target.id));
          const opened = await task.page("p1").evaluate(() => Boolean(window.open("about:blank", "_blank", "popup=yes,width=1280,height=720")));
          if (!opened) throw new Error("Firefox blocked the private second window");
          const until = performance.now() + 10_000;
          while (performance.now() < until) {
            const created = (await targets()).filter(target => !before.has(target.id));
            if (created.length > 1) throw new Error("Unexpected extra private Firefox targets");
            if (created.length === 1) { id = created[0].id; break; }
            await delay(50, undefined, { signal });
          }
          if (!id) throw new Error("Firefox second-window target did not appear");
        }
        const target = (await targets()).find(target => target.id === id);
        if (!target?.webSocketDebuggerUrl) throw new Error("New private page has no debugger endpoint");
        const page = new InstalledPage(task, target, `p${managed.size + 1}`);
        managed.set(page.label, page); return page;
      },
      async pages() { return [...managed.values()]; },
      finish: shutdown,
    };
    const initial = (await targets()).find(target => target.url === "about:blank");
    if (!initial?.webSocketDebuggerUrl) throw new Error("Private browser did not create its initial blank page");
    managed.set("p1", new InstalledPage(task, initial, "p1"));
    await writeFile(resolve(out, "installed-browser-environment.json"), JSON.stringify(environment, null, 2) + "\n");
    return task;
  } catch (error) {
    environment.error = String(error);
    await shutdown();
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    engine: { type: "string" }, "client-url": { type: "string" }, out: { type: "string" },
    players: { type: "string", default: "2" }, "browser-players": { type: "string", default: "1" },
    seconds: { type: "string", default: "120" }, impaired: { type: "boolean", default: false },
    combat: { type: "boolean", default: false }, "capture-pixels": { type: "boolean", default: false },
  } });
  if (!executables[values.engine] || !values["client-url"] || !values.out) throw new Error("Require --engine chrome|firefox --client-url URL --out DIRECTORY [--players 2|8 --browser-players 1|2 --seconds 120 --impaired --combat --capture-pixels]");
  const clientUrl = new URL(values["client-url"]).href;
  const players = Number(values.players), browserPlayers = Number(values["browser-players"]), seconds = Number(values.seconds);
  if (![2, 8].includes(players) || ![1, 2].includes(browserPlayers) || browserPlayers > players || !Number.isFinite(seconds) || seconds <= 0) throw new Error("Require 2/8 players, 1/2 browser players, and positive seconds");
  const out = resolve(root, values.out);
  await mkdir(out, { recursive: true });
  for (const name of ["browser-ready.json", "browser-results.json", "browser-failure.json", "installed-browser-environment.json"]) {
    const exists = await stat(resolve(out, name)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    if (exists) throw new Error(`Use a fresh output directory; existing receipt ${resolve(out, name)}`);
  }
  const controller = new AbortController();
  const interrupt = signalName => () => controller.abort(new Error(`Private browser qualification interrupted by ${signalName}`));
  const onInt = interrupt("SIGINT"), onTerm = interrupt("SIGTERM");
  process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
  let task;
  try {
    task = await createInstalledBrowserTask({ engine: values.engine, out, signal: controller.signal });
    const result = await runBrowserRig({ task, clientUrl, out, players, browserPlayers, seconds, impaired: values.impaired, combat: values.combat, capturePixels: values["capture-pixels"], finishTask: false, signal: controller.signal });
    console.log(JSON.stringify({ type: "installed-browser-rig-result", engine: values.engine, ...result }));
  } finally {
    try { if (task) await task.finish(); }
    finally { process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
