import { encodeInput, loadSim, loadSimContent, requireStatus, sha256, type Control, type SimHost } from "@soldat-web/sim-host";
import type { Fixture, HashRow } from "../../sim-host/src/fixture";
import { loadSimulationCode } from "./sim-runtime";
import { loadSimulationManifest, loadSimulationPack } from "./sim-content";
import { sessionBytes } from "./session-cache";

export interface GateDriver {
  run(name: string, hz: number): Promise<unknown>;
  respawn(): void;
}
declare global { interface Window { __soldatGate?: GateDriver; __soldatGateRun?: { state: string; error?: string; completed: number } } }
const bytes = sessionBytes;
export class FixturePlayback {
  readonly active = new Set<number>();
  readonly rows: HashRow[] = [];
  readonly record = new Uint8Array(12);
  constructor(readonly fixture: Fixture, readonly host: SimHost) {}
  commands(tick: number): void {
    for (const command of this.fixture.commands ?? []) if (command.tick === tick) {
      const { tick: _, ...payload } = command;
      requireStatus(this.host.command(tick, payload), `sim_command(${payload.kind})`);
      if (payload.kind === "join") this.active.add(payload.slot);
      if (payload.kind === "leave") this.active.delete(payload.slot);
    }
  }
  input(slot: number, tick: number): Uint8Array {
    let control: Control = {};
    for (const segment of this.fixture.inputs) if (segment.player === slot && tick >= segment.start && tick < segment.start + segment.ticks) control = { ...segment.control, pressOrder: segment.pressOrder ?? segment.control.pressOrder ?? 0 };
    return encodeInput(control, this.record);
  }
  recordTick(tick: number): void { this.rows.push({ tick, hash: this.host.hash(), events: "" }); }
}
export async function preparePlayback(name: string): Promise<{ playback: FixturePlayback; identity: { wasmSha256: string; fixtureSha256: string; contentSetHash: string } }> {
  const fixtureBytes = await bytes(`/g2/fixture?fixture=${encodeURIComponent(name)}`);
  const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes)) as Fixture;
  const code = await loadSimulationCode(undefined, "/sim.wasm");
  const manifest = await loadSimulationManifest();
  const files = await loadSimulationPack(null);
  const byPath = new Map(Object.entries(manifest.files).map(([id, entry]) => [entry.path, files.get(id)!] as const));
  let effective = manifest;
  let overlay: Uint8Array | undefined;
  if (fixture.mapPath) {
    overlay = await bytes(`/g2/map?fixture=${encodeURIComponent(name)}`);
    const hash = await sha256(overlay);
    if (hash !== (fixture.mapSha256 ?? fixture.mapHash)) throw new Error("Fixture map identity mismatch");
    const entries = { ...manifest.files, [`maps/${fixture.map.toLowerCase()}.pms`]: { path: fixture.mapPath, object: fixture.mapPath, sha256: hash, bytes: overlay.length } };
    effective = { schemaVersion: 1, files: entries, sha256: await sha256(new TextEncoder().encode(Object.keys(entries).sort().map(id => `${id}\t${entries[id]!.sha256}\n`).join(""))) };
  }
  if (effective.sha256 !== fixture.contentSetHash) throw new Error("Fixture content-set identity mismatch");
  const host = await loadSim(code.module);
  try {
    await loadSimContent(host, effective, path => {
      const data = overlay && path === fixture.mapPath ? overlay : byPath.get(path);
      if (!data) throw new Error(`Simulation fixture content absent from pack: ${path}`);
      return Promise.resolve(data);
    });
    requireStatus(host.init(fixture.rules ?? {}, fixture.seed), "sim_init");
    requireStatus(host.loadMap(fixture.map), "sim_load_map");
    const playback = new FixturePlayback(fixture, host);
    for (let i = 0; i < fixture.players.length; i++) {
      const { spawnpoint, ...player } = fixture.players[i]!;
      requireStatus(host.command(0, { kind: "join", slot: i + 1, ...player, spawn: spawnpoint }), "sim_command(join)"); playback.active.add(i + 1);
    }
    playback.commands(0); playback.recordTick(0);
    return { playback, identity: { wasmSha256: code.sha256, fixtureSha256: await sha256(fixtureBytes), contentSetHash: effective.sha256 } };
  } catch (error) { host.dispose(); throw error; }
}

/** Runs real Phaser frames with deterministic display timestamps, not real-time sleeps. */
export async function runGateSuite(): Promise<void> {
  const state = window.__soldatGateRun = { state: "running", completed: 0 } as { state: string; error?: string; completed: number };
  try {
    const config = await (await fetch("/g2/config")).json() as { fixtures: string[] };
    for (const name of config.fixtures) for (const hz of [60, 120, 144]) {
      await window.__soldatGate!.run(name, hz); state.completed++;
    }
    state.state = "complete";
  } catch (error) {
    state.state = "failed"; state.error = String(error); console.error(error);
    await fetch("/g2/error", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime: navigator.userAgent, runId: new URLSearchParams(location.search).get("run") ?? "interactive", error: String(error) }) });
  }
}
