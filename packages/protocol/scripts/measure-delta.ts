import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeDelta, decodeDelta } from "../src/delta.ts";
import { loadSim, loadSimContent, requireStatus, type Control, type Fixture, type SimManifest } from "../../sim-host/src/index.ts";
import { containedPath } from "../../sim-host/src/fixture-files.ts";

const root = resolve(import.meta.dirname, "../../..");
const wasmPath = resolve(root, "build-out/sim/sim.wasm");
let available = true;
try { await access(wasmPath); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; available = false; }

let pairs = 0, rawBytes = 0, deltaBytes = 0;
function measure(state: Uint8Array, baseline: Uint8Array): void {
  const delta = encodeDelta(state, baseline), restored = decodeDelta(delta, baseline);
  if (restored.length !== state.length || !restored.every((value, i) => value === state[i])) throw new Error("Delta measurement failed exact round-trip");
  pairs++; rawBytes += state.length; deltaBytes += delta.length;
}
if (!available || process.argv.includes("--synthetic")) {
  let baseline = new Uint8Array(65536);
  for (let tick = 0; tick < 60; tick++) {
    const state = baseline.slice();
    for (let i = 0; i < 16; i++) state[(tick * 997 + i * 101) % state.length] = tick + i + 1;
    measure(state, baseline); baseline = state;
  }
  console.log(JSON.stringify({ source: "synthetic-sparse-64KiB", pairs, rawBytes, deltaBytes, ratio: deltaBytes / rawBytes, realSaveStateMeasurement: "pending", reason: available ? "Explicit --synthetic" : "build-out/sim/sim.wasm is absent" }, null, 2));
} else {
  const fixture = JSON.parse(await readFile(resolve(root, "tests/fixtures/arena-run-jump-jet.fixture.json"), "utf8")) as Fixture;
  const content = resolve(root, "dist/content");
  const manifest = JSON.parse(await readFile(resolve(content, "sim/manifest.json"), "utf8")) as SimManifest;
  if (manifest.sha256 !== fixture.contentSetHash) throw new Error("Arena fixture/content identity mismatch");
  const host = await loadSim(new Uint8Array(await readFile(wasmPath)));
  try {
    await loadSimContent(host, manifest, async path => new Uint8Array(await readFile(containedPath(content, path))));
    requireStatus(host.init(fixture.rules ?? {}, fixture.seed, 0, 0), "sim_init");
    requireStatus(host.loadMap(fixture.map), "sim_load_map");
    for (const [i, player] of fixture.players.entries()) {
      const { spawnpoint, ...setup } = player;
      requireStatus(host.command(0, { kind: "join", slot: i + 1, ...setup, spawn: spawnpoint }), "sim_command(join)");
    }
    let baseline = host.saveState();
    if (typeof baseline === "number") throw new Error(`sim_save_state returned ${baseline}`);
    for (let tick = 0; tick < Math.min(fixture.ticks, 60); tick++) {
      for (const command of fixture.commands ?? []) if (command.tick === tick) {
        const { tick: commandTick, ...payload } = command;
        requireStatus(host.command(commandTick, payload), "sim_command");
      }
      for (let slot = 1; slot <= fixture.players.length; slot++) {
        let control: Control = {};
        for (const input of fixture.inputs) if (input.player === slot && tick + 1 >= input.start && tick + 1 < input.start + input.ticks) control = { ...input.control, pressOrder: input.pressOrder ?? input.control.pressOrder ?? 0 };
        requireStatus(host.setInput(slot, tick, control), "sim_set_input");
      }
      const advanced = requireStatus(host.step(), "sim_step");
      if (advanced !== tick + 1) throw new Error(`Unexpected simulation tick ${advanced}; expected ${tick + 1}`);
      const state = host.saveState();
      if (typeof state === "number") throw new Error(`sim_save_state returned ${state}`);
      measure(state, baseline); baseline = state;
      const events = host.events();
      if (typeof events === "number") throw new Error(`sim_events returned ${events}`);
    }
    console.log(JSON.stringify({ source: "sim.wasm-arena-consecutive-save-states", pairs, rawBytes, deltaBytes, ratio: deltaBytes / rawBytes, contentSetHash: manifest.sha256, simAbiVersion: host.exports.sim_version() >>> 0 }, null, 2));
  } finally { host.dispose(); }
}
