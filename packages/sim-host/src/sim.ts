import { deterministicWasi, requireDeterministicImports } from "./wasi.ts";
import { readRenderView } from "./render.ts";
import { readFxView } from "./fx.ts";
export { FX_LAYOUT, readFxView, type FxView, type FxSpark } from "./fx.ts";
export { SIM_GAMEPLAY_EVENTS, SIM_GAMEPLAY_PAYLOAD } from "./gameplay-events.ts";

export const SIM_ABI_VERSION = 0x00010004;
export const SimStatus = { OK: 0, INVALID: -1, NOT_INITIALIZED: -2, NOT_FOUND: -3, UNSUPPORTED: -4, CAPACITY: -5, MALFORMED: -6 } as const;
export const INPUT_BYTES = 12;
export const SIM_PRESENTATION_EVENTS = { BINK: 0x80001001 } as const;
export const CONTROL_NAMES = ["Left", "Right", "Up", "Down", "Fire", "Jetpack", "ThrowNade", "ChangeWeapon", "ThrowWeapon", "Reload", "Prone", "FlagThrow"] as const;
export type Control = Partial<Record<typeof CONTROL_NAMES[number], boolean>> & {
  MouseAimX?: number; MouseAimY?: number; MouseDist?: number; pressOrder?: number;
};
export type SimCommand =
  | { kind: "join" | "leave" | "team" | "spawn"; slot: number; team?: number; spawn?: number; x?: number; y?: number; health?: number; heldFlag?: number; weapon?: number; secondaryWeapon?: number; ammo?: number; grenades?: number; vest?: number; control?: "human" | "authoritative" | "bot"; bot?: string; name?: string }
  | { kind: "thing"; style: number; owner?: number; x: number; y: number; ammo?: number }
  | { kind: "weapon-choice" | "weapon-apply"; slot: number; weapon: number; secondaryWeapon?: number; selection?: "primary" | "secondary" }
  | { kind: "bullet"; weapon: number; owner: number; x: number; y: number; vx: number; vy: number; hitMultiply?: number; timeout?: number; target?: number; hitCircle?: number }
  | { kind: "fixture-sprite"; slot: number; bodyAnimation: "Throw"; bodyFrame: number; grenadeWeapon?: number };
export type SimExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  sim_version(): number;
  sim_alloc(bytes: number): number;
  sim_free(ptr: number): void;
  sim_vfs_put(path: number, pathLength: number, data: number, length: number): number;
  sim_init(rules: number, length: number, seedLow: number, seedHigh: number, flags: number): number;
  sim_load_map(name: number, length: number): number;
  sim_command(tick: number, data: number, length: number): number;
  sim_set_input(slot: number, tick: number, data: number): number;
  sim_step(flags: number): number;
  sim_events(out: number, capacity: number): number;
  sim_render_view(): number;
  sim_save_state(out: number, capacity: number): number;
  sim_load_state(data: number, length: number): number;
  sim_hash_state(): bigint;
  sim_trace_state?: (out: number, capacity: number) => number;
  fx_step(): number;
  fx_render_view(): number;
  fx_set_view(x: number, y: number, width: number, height: number, slot: number): number;
};
const encoder = new TextEncoder();

export function encodeInput(control: Control, target = new Uint8Array(INPUT_BYTES)): Uint8Array {
  if (target.byteLength !== INPUT_BYTES) throw new RangeError("Input record must be 12 bytes");
  target.fill(0);
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  let bits = 0;
  for (let i = 0; i < CONTROL_NAMES.length; i++) if (control[CONTROL_NAMES[i]!]) bits |= 1 << i;
  view.setUint16(0, bits, true);
  for (const [offset, value] of [[2, control.MouseAimX ?? 0], [4, control.MouseAimY ?? 0], [6, control.MouseDist ?? 0]]) {
    if (!Number.isInteger(value) || value! < -32768 || value! > 32767) throw new RangeError("Aim fields must be i16 integers");
    view.setInt16(offset!, value!, true);
  }
  const order = control.pressOrder ?? 0;
  if (!Number.isInteger(order) || order < 0 || order > 15) throw new RangeError("pressOrder must use only bits 0..3");
  view.setUint16(8, order, true);
  return target;
}

export function requireStatus(status: number, operation: string): number {
  if (status < 0) throw new SimError(operation, status);
  return status;
}
export class SimError extends Error {
  readonly operation: string;
  readonly status: number;
  constructor(operation: string, status: number) {
    super(`${operation} returned ${status}`); this.name = "SimError";
    this.operation = operation; this.status = status;
  }
}

/** All status-returning wrappers preserve the module's negative status verbatim. */
export class SimHost {
  private inputPtr = 0;
  private readonly input = new Uint8Array(INPUT_BYTES);
  readonly exports: SimExports;
  readonly stdout: () => string;
  constructor(exports: SimExports, stdout: () => string) {
    this.exports = exports; this.stdout = stdout;
  }
  private allocate(length: number): number {
    const ptr = this.exports.sim_alloc(Math.max(length, 1));
    if (ptr <= 0) throw new SimError("sim_alloc", ptr < 0 ? ptr : SimStatus.CAPACITY);
    return ptr;
  }
  private withBytes<T>(bytes: Uint8Array, fn: (ptr: number, length: number) => T): T {
    const ptr = this.allocate(bytes.length);
    try { new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes); return fn(ptr, bytes.length); }
    finally { this.exports.sim_free(ptr); }
  }
  putFile(path: string, bytes: Uint8Array): number {
    const canonical = path.replaceAll("\\", "/").toLowerCase();
    return this.withBytes(encoder.encode(canonical), (p, n) => this.withBytes(bytes, (d, length) => this.exports.sim_vfs_put(p, n, d, length)));
  }
  init(rules: Record<string, unknown> = {}, seedLow = 0, seedHigh = 0, flags = 0): number {
    return this.withBytes(encoder.encode(JSON.stringify(rules)), (p, n) => this.exports.sim_init(p, n, seedLow, seedHigh, flags));
  }
  loadMap(name: string): number {
    return this.withBytes(encoder.encode(name), (p, n) => this.exports.sim_load_map(p, n));
  }
  command(tick: number, command: SimCommand): number {
    return this.withBytes(encoder.encode(JSON.stringify(command)), (p, n) => this.exports.sim_command(tick, p, n));
  }
  setInput(slot: number, tick: number, control: Control): number {
    encodeInput(control, this.input);
    if (!this.inputPtr) this.inputPtr = this.allocate(INPUT_BYTES);
    new Uint8Array(this.exports.memory.buffer, this.inputPtr, INPUT_BYTES).set(this.input);
    return this.exports.sim_set_input(slot, tick, this.inputPtr);
  }
  step(flags = 0): number { return this.exports.sim_step(flags); }
  hash(): string { return BigInt.asUintN(64, this.exports.sim_hash_state()).toString(16).padStart(16, "0"); }
  saveState(): Uint8Array | number {
    const length = this.exports.sim_save_state(0, 0);
    if (length < 0) return length;
    const ptr = this.allocate(length);
    try {
      const written = this.exports.sim_save_state(ptr, length);
      if (written < 0) return written;
      if (written !== length) throw new Error(`sim_save_state size changed: ${length} -> ${written}`);
      return new Uint8Array(this.exports.memory.buffer, ptr, written).slice();
    } finally { this.exports.sim_free(ptr); }
  }
  loadState(bytes: Uint8Array): number {
    return this.withBytes(bytes, (p, n) => this.exports.sim_load_state(p, n));
  }
  events(capacity?: number): Uint8Array | number {
    if (capacity === undefined) capacity = this.exports.sim_events(0, 0);
    if (capacity < 0) return capacity;
    if (capacity === 0) return new Uint8Array(0);
    const ptr = this.allocate(capacity);
    try {
      const length = this.exports.sim_events(ptr, capacity);
      if (length < 0) return length;
      if (length > capacity) return length;
      return new Uint8Array(this.exports.memory.buffer, ptr, length).slice();
    } finally { this.exports.sim_free(ptr); }
  }
  renderView() { return readRenderView(this.exports.memory, this.exports.sim_render_view()); }
  fxStep(): number { return this.exports.fx_step(); }
  fxRenderView() { return readFxView(this.exports.memory, this.exports.fx_render_view()); }
  fxSetView(x: number, y: number, width: number, height: number, slot = 0): number {
    return this.exports.fx_set_view(x, y, width, height, slot);
  }
  dispose(): void { if (this.inputPtr) this.exports.sim_free(this.inputPtr); this.inputPtr = 0; }
}

export async function loadSim(bytes: BufferSource): Promise<SimHost> {
  const module = await WebAssembly.compile(bytes);
  let exports: SimExports;
  const { wasi, stdout } = deterministicWasi(() => exports.memory);
  requireDeterministicImports(module, wasi);
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const names = ["sim_version", "sim_alloc", "sim_free", "sim_vfs_put", "sim_init", "sim_load_map", "sim_command", "sim_set_input", "sim_step", "sim_events", "sim_render_view", "sim_save_state", "sim_load_state", "sim_hash_state", "fx_step", "fx_render_view", "fx_set_view"];
  if (!(instance.exports.memory instanceof WebAssembly.Memory)) throw new Error("sim.wasm must export memory");
  for (const name of names) if (typeof instance.exports[name] !== "function") throw new Error(`Missing sim export: ${name}`);
  exports = instance.exports as SimExports;
  exports._initialize?.();
  const version = exports.sim_version() >>> 0;
  if (version !== SIM_ABI_VERSION) throw new Error(`Unsupported sim ABI: 0x${version.toString(16)}`);
  return new SimHost(exports, stdout);
}

export interface SimManifest {
  schemaVersion: 1;
  sha256: string;
  files: Record<string, { path: string; object: string; sha256: string; bytes: number }>;
}
export type ReadContent = (relativePath: string) => Promise<Uint8Array>;
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
/** Verify raw bytes and the importer's combined identity before populating the VFS. */
export async function loadSimContent(host: SimHost, manifest: SimManifest, read: ReadContent): Promise<void> {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported sim content manifest");
  const ids = Object.keys(manifest.files).sort();
  const identity = ids.map(id => `${id}\t${manifest.files[id]!.sha256}\n`).join("");
  if (await sha256(encoder.encode(identity)) !== manifest.sha256) throw new Error("Simulation content-set hash mismatch");
  for (const id of ids) {
    if (id !== id.toLowerCase() || id.includes("\\") || id.split("/").some(p => !p || p === "." || p === "..")) throw new Error(`Noncanonical VFS path: ${id}`);
    const entry = manifest.files[id]!;
    const bytes = await read(entry.path);
    if (bytes.length !== entry.bytes || await sha256(bytes) !== entry.sha256) throw new Error(`Simulation content mismatch: ${id}`);
    requireStatus(host.putFile(id, bytes), `sim_vfs_put(${id})`);
  }
}
