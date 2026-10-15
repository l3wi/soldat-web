#!/usr/bin/env node
// Node >=22.18: native TypeScript stripping loads the production WASI host.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { deterministicWasi, requireDeterministicImports } from '../../packages/sim-host/src/wasi.ts';

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
  console.error('Usage: node sim/build/check-rng.mjs WASM [NATIVE_EXECUTABLE]');
  process.exit(2);
}

function report(text, target) {
  let value;
  try { value = JSON.parse(text.trim()); }
  catch (error) { throw new Error(`${target}: invalid conformance JSON: ${text}`, { cause: error }); }
  console.log(JSON.stringify({ target, ...value }));
  if (value.status !== 'pass' || value.mismatches !== 0) {
    throw new Error(`${target}: RNG conformance failed`);
  }
  const categories = ['longint', 'int64', 'float64'];
  if (value.seedCases < 64 || value.mixedDrawsPerSeed < 10000 ||
      categories.some(key => !Number.isSafeInteger(value[key]) || value[key] <= 0) ||
      !/^[0-9A-F]{16}$/.test(value.hash)) {
    throw new Error(`${target}: incomplete conformance coverage`);
  }
  return value;
}

try {
  let nativeReport;
  if (args[1]) {
    const native = spawnSync(resolve(args[1]), [], { encoding: 'utf8' });
    if (native.error) throw native.error;
    // Print the first failing case verbatim, even when the executable failed.
    nativeReport = report(native.stdout, 'native');
    if (native.status !== 0) throw new Error(`native exit ${native.status}: ${native.stderr}`);
  }
  const module = await WebAssembly.compile(await readFile(resolve(args[0])));
  let exports;
  const { wasi, stdout } = deterministicWasi(() => exports.memory);
  requireDeterministicImports(module, wasi);
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  exports = instance.exports;
  if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error('Missing WASM memory export');
  for (const name of ['rng_run', 'rng_report_ptr', 'rng_report_len']) {
    if (typeof exports[name] !== 'function') throw new Error(`Missing WASM export ${name}`);
  }
  exports._initialize?.();
  const status = exports.rng_run();
  const ptr = exports.rng_report_ptr() >>> 0;
  const len = exports.rng_report_len() >>> 0;
  if (len === 0 || ptr + len > exports.memory.buffer.byteLength) throw new Error('Invalid WASM report span');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(exports.memory.buffer, ptr, len));
  const wasmReport = report(text, 'wasm');
  if (status !== 0) throw new Error(`WASM status ${status}: ${stdout()}`);
  if (nativeReport && JSON.stringify(nativeReport) !== JSON.stringify(wasmReport)) {
    throw new Error(`Native/WASM transcript mismatch: native=${JSON.stringify(nativeReport)} wasm=${JSON.stringify(wasmReport)}`);
  }
  console.log(JSON.stringify({ status: 'pass', comparison: nativeReport ? 'native-wasm-bit-exact' : 'wasm-system-versus-portable', hash: wasmReport.hash }));
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
