import type { Fixture } from "./fixture.ts";
import { requireStatus, type SimHost } from "./sim.ts";

export interface TraceState {
  type: "state"; tick: number; stage: string; entity: number;
  [field: string]: unknown;
}

export interface TraceHeader {
  type: "header"; version: 1; upstream: string; compiler: string;
  map: string; contentSetHash: string; seed: number; ticks: number; jetCapacity: number;
}
/** Build identity follows the repository's pinned FPC toolchain contract. */
export function createTraceHeader(fixture: Fixture, initial: TraceState): TraceHeader {
  if (initial.tick !== 0 || initial.stage !== "initial" || typeof initial.jetCapacity !== "number") throw new Error("Trace header requires an actual initial diagnostic state");
  return {
    type: "header", version: 1,
    upstream: "bf43a43bdd7a069e02c906768807f66e621b2888", compiler: "3.3.1",
    map: fixture.map, contentSetHash: fixture.contentSetHash, seed: fixture.seed,
    ticks: fixture.ticks, jetCapacity: initial.jetCapacity,
  };
}
/** Optional diagnostic export, not part of the required production ABI. */
export function readTraceState(host: SimHost): TraceState {
  const trace = host.exports.sim_trace_state;
  if (typeof trace !== "function") throw new Error("This sim build does not export sim_trace_state; diagnostic traces require a trace-enabled build");
  const length = requireStatus(trace(0, 0) as number, "sim_trace_state(size)");
  const ptr = host.exports.sim_alloc(length);
  if (ptr <= 0) throw new Error("sim_trace_state allocation failed");
  try {
    const written = requireStatus(trace(ptr, length) as number, "sim_trace_state");
    if (written !== length) throw new Error("sim_trace_state size changed during capture");
    const state = JSON.parse(new TextDecoder().decode(new Uint8Array(host.exports.memory.buffer, ptr, length))) as TraceState;
    if (state.type !== "state") throw new Error("sim_trace_state did not return an oracle state record");
    return state;
  } finally { host.exports.sim_free(ptr); }
}

/** Tick-boundary projection shared by native/oracle and WASM diagnostics.
 * Intermediate upstream stage rows and compiler-specific header metadata are
 * excluded explicitly, never fabricated from a render view. */
export function tickTraceRow(row: Record<string, unknown>): TraceState | null {
  if (row.type !== "state" || (row.stage !== "initial" && row.stage !== "tick")) return null;
  return row as TraceState;
}
