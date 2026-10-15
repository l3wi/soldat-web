import { deterministicWasi, requireDeterministicImports } from "./wasi.ts";

export * from "./sim.ts";
export * from "./render.ts";
export * from "./fixture.ts";
export * from "./trace.ts";

export type SpikeExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  spike_reset(): void;
  spike_step(): bigint;
  spike_run(ticks: number): bigint;
  spike_state_ptr(): number;
  spike_state_len(): number;
  _initialize?: () => void;
};

/** Only for the G0.2 pure-Pascal library: no filesystem, entropy or wall clock. */
export async function loadSpike(bytes: BufferSource) {
  const module = await WebAssembly.compile(bytes);
  let exports: SpikeExports;
  const { wasi, stdout } = deterministicWasi(() => exports.memory);
  const view = () => new DataView(exports.memory.buffer);
  const imports = requireDeterministicImports(module, wasi);
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  // The module is built from the pinned local spike.lpr export contract.
  exports = instance.exports as SpikeExports;
  exports._initialize?.();
  return {
    exports,
    imports,
    stdout,
    hash: (ticks = 10_000) => BigInt.asUintN(64, exports.spike_run(ticks)).toString(16).padStart(16, "0"),
    stateBits: () => {
      const start = exports.spike_state_ptr();
      return Array.from({ length: exports.spike_state_len() / 4 }, (_, i) =>
        view().getUint32(start + i * 4, true).toString(16).padStart(8, "0"));
    },
  };
}
