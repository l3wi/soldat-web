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
  let stdout = "";
  const view = () => new DataView(exports.memory.buffer);
  const wasi = {
    args_sizes_get: (count: number, size: number) => {
      view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0;
    },
    args_get: () => 0,
    environ_sizes_get: (count: number, size: number) => {
      view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0;
    },
    environ_get: () => 0,
    clock_time_get: (_clock: number, _precision: bigint, out: number) => {
      view().setBigUint64(out, 0n, true); return 0;
    },
    random_get: (out: number, length: number) => {
      new Uint8Array(exports.memory.buffer, out, length).fill(0); return 0;
    },
    fd_write: (fd: number, iovs: number, count: number, written: number) => {
      if (fd !== 1 && fd !== 2) return 8; // BADF
      let total = 0;
      for (let i = 0; i < count; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        stdout += new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
        total += len;
      }
      view().setUint32(written, total, true); return 0;
    },
    fd_close: () => 8,
    fd_seek: () => 8,
    // The linked SysUtils RTL imports these even though the spike has no files.
    // BADF/NOTCAPABLE, never fake a successful read/write of simulation data.
    fd_filestat_get: () => 8,
    fd_filestat_set_size: () => 8,
    fd_filestat_set_times: () => 8,
    fd_prestat_get: () => 8,
    fd_prestat_dir_name: () => 8,
    fd_read: () => 8,
    fd_readdir: () => 8,
    fd_tell: () => 8,
    path_create_directory: () => 76,
    path_filestat_get: () => 76,
    path_filestat_set_times: () => 76,
    path_open: () => 76,
    path_readlink: () => 76,
    path_remove_directory: () => 76,
    path_rename: () => 76,
    path_unlink_file: () => 76,
    poll_oneoff: () => 52, // NOSYS: the fixed-tick spike never waits on a clock.
    fd_fdstat_get: (fd: number, out: number) => {
      if (fd > 2) return 8;
      new Uint8Array(exports.memory.buffer, out, 24).fill(0);
      view().setUint8(out, 2); // character device
      return 0;
    },
    proc_exit: (status: number) => { throw new Error(`WASI proc_exit(${status})`); },
  } satisfies Record<string, WebAssembly.ImportValue>;
  const imports = WebAssembly.Module.imports(module);
  for (const entry of imports) {
    if (entry.module !== "wasi_snapshot_preview1" || entry.kind !== "function" || !(entry.name in wasi)) {
      throw new Error(`Unsupported spike import: ${entry.module}.${entry.name} (${entry.kind})`);
    }
  }
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  // The module is built from the pinned local spike.lpr export contract.
  exports = instance.exports as SpikeExports;
  exports._initialize?.();
  return {
    exports,
    imports,
    stdout: () => stdout,
    hash: (ticks = 10_000) => BigInt.asUintN(64, exports.spike_run(ticks)).toString(16).padStart(16, "0"),
    stateBits: () => {
      const start = exports.spike_state_ptr();
      return Array.from({ length: exports.spike_state_len() / 4 }, (_, i) =>
        view().getUint32(start + i * 4, true).toString(16).padStart(8, "0"));
    },
  };
}
