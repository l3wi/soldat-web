import { SIM_ABI_VERSION, loadSim, loadSimContent, requireStatus, sha256, type Control, type SimCommand, type SimHost, type SimManifest, type ReadContent } from "./sim.ts";

export interface Fixture {
  version: 1;
  map: string;
  mapHash?: string;
  mapSha256?: string;
  mapPath?: string;
  contentSetHash: string;
  seed: number;
  ticks: number;
  rules?: Record<string, unknown>;
  players: { team: number; spawnpoint: number; x?: number; y?: number; health?: number; heldFlag?: number; weapon?: number; secondaryWeapon?: number; ammo?: number; grenades?: number; vest?: number; control?: "human" | "authoritative" }[];
  inputs: { player: number; start: number; ticks: number; control: Control; pressOrder?: number }[];
  commands?: (SimCommand & { tick: number })[];
}
export interface HashRow { tick: number; hash: string; events: string }
export interface Checkpoint { tick: number; bytes: number; sha256: string; before: string; after: string }
export interface FixtureReceipt {
  type: "sim-fixture-receipt";
  version: 1;
  abiVersion: number;
  runtime: string;
  fixture: string;
  fixtureSha256: string;
  wasmSha256: string;
  map: string;
  mapSha256: string;
  contentSetHash: string;
  rngPolicy: "original" | "keyed";
  seed: number;
  ticks: number;
  checkpointInterval: 50;
  baseline: HashRow[];
  restored: HashRow[];
  checkpoints: Checkpoint[];
  identical: boolean;
}
export interface FixtureRunOptions {
  wasm: Uint8Array;
  fixture: Fixture;
  fixtureBytes: Uint8Array;
  fixtureName: string;
  manifest: SimManifest;
  readContent: ReadContent;
  readFixtureAsset?: ReadContent;
  rngPolicy?: "original" | "keyed";
  runtime: string;
  /** Called only for uninterrupted baseline, including tick zero. */
  trace?: (host: SimHost, tick: number) => void;
}
export interface ReceiptDifference {
  field: string; tick?: number; expected: unknown; actual: unknown;
}
export class ReceiptMismatch extends Error {
  readonly difference: ReceiptDifference;
  constructor(difference: ReceiptDifference) {
    super(`Receipt mismatch: ${JSON.stringify(difference)}`);
    this.name = "ReceiptMismatch"; this.difference = difference;
  }
}

export function assertMatchingReceipts(expected: FixtureReceipt, actual: FixtureReceipt): void {
  for (const key of ["version", "abiVersion", "fixtureSha256", "wasmSha256", "mapSha256", "contentSetHash", "rngPolicy", "seed", "ticks", "checkpointInterval"] as const) {
    if (expected[key] !== actual[key]) throw new ReceiptMismatch({ field: key, expected: expected[key], actual: actual[key] });
  }
  for (const lane of ["baseline", "restored"] as const) {
    if (expected[lane].length !== actual[lane].length) throw new ReceiptMismatch({ field: `${lane}.length`, expected: expected[lane].length, actual: actual[lane].length });
  }
  for (let i = 0; i < expected.baseline.length; i++) {
    for (const lane of ["baseline", "restored"] as const) {
      const a = expected[lane][i]!, b = actual[lane][i]!;
      if (a.tick !== b.tick || a.hash !== b.hash || a.events !== b.events) throw new ReceiptMismatch({ field: lane, tick: a.tick, expected: a, actual: b });
    }
  }
  if (!expected.identical || !actual.identical) throw new Error("Receipt contains save/load divergence");
  if (expected.checkpoints.length !== actual.checkpoints.length) throw new Error("Receipt checkpoint count mismatch");
  for (let i = 0; i < expected.checkpoints.length; i++) {
    const a = expected.checkpoints[i]!, b = actual.checkpoints[i]!;
    if (a.tick !== b.tick || a.bytes !== b.bytes || a.sha256 !== b.sha256 || a.before !== b.before || a.after !== b.after) throw new ReceiptMismatch({ field: "checkpoint", tick: a.tick, expected: a, actual: b });
  }
}

export async function runFixture(options: FixtureRunOptions): Promise<FixtureReceipt> {
  const { fixture } = options;
  let manifest = options.manifest;
  if (fixture.version !== 1 || !Number.isInteger(fixture.ticks) || fixture.ticks <= 0) throw new Error("Unsupported or malformed fixture");
  const mapId = `maps/${fixture.map.toLowerCase()}.pms`;
  let overlay: Uint8Array | undefined;
  if (fixture.mapPath) {
    if (!options.readFixtureAsset) throw new Error("Fixture mapPath requires readFixtureAsset");
    overlay = await options.readFixtureAsset(fixture.mapPath);
    const hash = await sha256(overlay);
    if (hash !== (fixture.mapSha256 ?? fixture.mapHash)) throw new Error("Fixture map identity mismatch");
    const files = { ...manifest.files, [mapId]: { path: fixture.mapPath, object: fixture.mapPath, sha256: hash, bytes: overlay.length } };
    const identity = Object.keys(files).sort().map(id => `${id}\t${files[id]!.sha256}\n`).join("");
    manifest = { schemaVersion: 1, files, sha256: await sha256(new TextEncoder().encode(identity)) };
  }
  if (fixture.contentSetHash !== manifest.sha256) throw new Error("Fixture content-set identity mismatch");
  const map = manifest.files[mapId];
  if (!map) throw new Error(`Fixture map absent from simulation manifest: ${mapId}`);
  const declaredMapHash = fixture.mapSha256 ?? fixture.mapHash;
  if (declaredMapHash && declaredMapHash !== map.sha256) throw new Error("Fixture map identity mismatch");
  const checkpoints: Checkpoint[] = [];
  async function lane(restore: boolean): Promise<HashRow[]> {
    const host = await loadSim(options.wasm as Uint8Array<ArrayBuffer>);
    try {
      await loadSimContent(host, manifest, name => overlay && name === fixture.mapPath ? Promise.resolve(overlay) : options.readContent(name));
      requireStatus(host.init({ ...fixture.rules, ...(options.rngPolicy ? { rng: options.rngPolicy } : {}) }, fixture.seed, 0, 0), "sim_init");
      requireStatus(host.loadMap(fixture.map), "sim_load_map");
      const activeSlots = Array.from({ length: 33 }, () => false);
      for (let i = 0; i < fixture.players.length; i++) {
        const player = fixture.players[i]!;
        const { spawnpoint, ...setup } = player;
        requireStatus(host.command(0, { kind: "join", slot: i + 1, ...setup, spawn: spawnpoint }), "sim_command(join)");
        activeSlots[i + 1] = true;
      }
      const hashes: HashRow[] = [];
      for (let tick = 0; tick <= fixture.ticks; tick++) {
        for (const command of fixture.commands ?? []) if (command.tick === tick) {
          const { tick: commandTick, ...payload } = command;
          requireStatus(host.command(commandTick, payload), `sim_command(${payload.kind})`);
          if (payload.kind === "join") activeSlots[payload.slot] = true;
          if (payload.kind === "leave") activeSlots[payload.slot] = false;
        }
        const hash = host.hash();
        const events = host.events();
        if (typeof events === "number") { requireStatus(events, "sim_events"); throw new Error(`Event capacity changed to ${events}`); }
        hashes.push({ tick, hash, events: Array.from(events, byte => byte.toString(16).padStart(2, "0")).join("") });
        if (!restore) options.trace?.(host, tick);
        if (restore && tick > 0 && tick % 50 === 0) {
          const state = host.saveState();
          if (typeof state === "number") { requireStatus(state, "sim_save_state"); throw new Error("Unexpected state length"); }
          requireStatus(host.loadState(state), "sim_load_state");
          const after = host.hash();
          if (after !== hash) throw new ReceiptMismatch({ field: "save/load", tick, expected: hash, actual: after });
          checkpoints.push({ tick, bytes: state.length, sha256: await sha256(state), before: hash, after });
        }
        if (tick === fixture.ticks) break;
        for (let slot = 1; slot <= 32; slot++) {
          if (!activeSlots[slot]) continue;
          let control: Control = {};
          for (const input of fixture.inputs) if (input.player === slot && tick + 1 >= input.start && tick + 1 < input.start + input.ticks) control = { ...input.control, pressOrder: input.pressOrder ?? input.control.pressOrder ?? 0 };
          requireStatus(host.setInput(slot, tick, control), "sim_set_input");
        }
        const advanced = requireStatus(host.step(), "sim_step");
        if (advanced !== tick + 1) throw new Error(`sim_step advanced to ${advanced}, expected ${tick + 1}`);
      }
      return hashes;
    } finally { host.dispose(); }
  }
  const baseline = await lane(false);
  const restored = await lane(true);
  const receipt: FixtureReceipt = {
    type: "sim-fixture-receipt", version: 1, abiVersion: SIM_ABI_VERSION, runtime: options.runtime,
    fixture: options.fixtureName, fixtureSha256: await sha256(options.fixtureBytes), wasmSha256: await sha256(options.wasm),
    map: fixture.map, mapSha256: map.sha256, contentSetHash: manifest.sha256, seed: fixture.seed, ticks: fixture.ticks,
    rngPolicy: options.rngPolicy ?? (fixture.rules?.rng === "keyed" ? "keyed" : "original"),
    checkpointInterval: 50, baseline, restored, checkpoints,
    identical: baseline.every((row, i) => row.tick === restored[i]?.tick && row.hash === restored[i]?.hash && row.events === restored[i]?.events),
  };
  if (!receipt.identical) {
    const index = baseline.findIndex((row, i) => row.hash !== restored[i]?.hash || row.events !== restored[i]?.events);
    throw new ReceiptMismatch({ field: "continuation", tick: index, expected: baseline[index], actual: restored[index] });
  }
  return receipt;
}
