/** Deterministic WASI subset shared by the Phase 0 spike and production sim.
 * Gameplay files use sim_vfs_put, never WASI filesystem calls. */
export function deterministicWasi(memory: () => WebAssembly.Memory) {
  let stdout = "";
  const decoder = new TextDecoder();
  const view = () => new DataView(memory().buffer);
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
      new Uint8Array(memory().buffer, out, length).fill(0); return 0;
    },
    fd_write: (fd: number, iovs: number, count: number, written: number) => {
      if (fd !== 1 && fd !== 2) return 8;
      let total = 0;
      for (let i = 0; i < count; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        stdout += decoder.decode(new Uint8Array(memory().buffer, ptr, len));
        total += len;
      }
      view().setUint32(written, total, true); return 0;
    },
    fd_close: () => 8,
    fd_seek: () => 8,
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
    poll_oneoff: () => 52,
    fd_fdstat_get: (fd: number, out: number) => {
      if (fd > 2) return 8;
      new Uint8Array(memory().buffer, out, 24).fill(0);
      view().setUint8(out, 2); return 0;
    },
    proc_exit: (status: number) => { throw new Error(`WASI proc_exit(${status})`); },
  } satisfies Record<string, WebAssembly.ImportValue>;
  return { wasi, stdout: () => stdout };
}

export function requireDeterministicImports(module: WebAssembly.Module, wasi: Record<string, WebAssembly.ImportValue>) {
  const imports = WebAssembly.Module.imports(module);
  for (const entry of imports) {
    if (entry.module !== "wasi_snapshot_preview1" || entry.kind !== "function" || !Object.hasOwn(wasi, entry.name)) {
      throw new Error(`Unsupported WASM import: ${entry.module}.${entry.name} (${entry.kind})`);
    }
  }
  return imports;
}
