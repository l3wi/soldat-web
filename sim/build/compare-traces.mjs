#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const target = args.includes('--target');
const ticksOnly = args.includes('--ticks-only');
const paths = args.filter(arg => !arg.startsWith('--'));
if (paths.length !== 2 || args.some(arg => arg.startsWith('--') && !['--target', '--ticks-only'].includes(arg))) {
  console.error('Usage: node sim/build/compare-traces.mjs [--target] [--ticks-only] EXPECTED[.gz] ACTUAL[.gz]');
  process.exit(2);
}
async function* rows(path) {
  const source = createReadStream(path);
  const input = path.endsWith('.gz') ? source.pipe(createGunzip()) : source;
  const lines = createInterface({ input, crlfDelay: Infinity });
  source.on('error', error => input.destroy(error));
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!ticksOnly || row.type === 'header' || row.stage === 'tick' || row.stage === 'initial') yield row;
    }
  } finally {
    lines.close();
    input.destroy();
    source.destroy();
  }
}
const scratch = new DataView(new ArrayBuffer(4));
function float(bits) {
  scratch.setUint32(0, Number.parseInt(bits, 16), true);
  return scratch.getFloat32(0, true);
}
let maxAbsError = 0, worst = null, floatDifferences = 0;
function difference(a, b, limit, context, path = '$') {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return { path, expected: a, actual: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, expected: a, actual: b };
  if (typeof a.bits === 'string' && typeof b.bits === 'string') {
    if (a.bits === b.bits) return null;
    const expected = float(a.bits), actual = float(b.bits);
    const error = Math.abs(expected - actual);
    floatDifferences++;
    if (!Number.isFinite(error) || error > maxAbsError) {
      maxAbsError = error;
      worst = { ...context, path, expectedBits: a.bits, actualBits: b.bits, expected, actual };
    }
    if (!target || !Number.isFinite(error) || error > limit) return { path, expectedBits: a.bits, actualBits: b.bits, expected, actual, absError: error, limit };
    return null;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const result = difference(a[key], b[key], limit, context, `${path}.${key}`);
    if (result) return result;
  }
  return null;
}
const left = rows(paths[0]), right = rows(paths[1]);
let records = 0, states = 0, ticks = 0, limit = 0, headers = 0, finalTick = -1;
try {
  for (;;) {
    const [a, b] = await Promise.all([left.next(), right.next()]);
    if (a.done && b.done) break;
    const context = { record: records + 1, tick: a.value?.tick ?? b.value?.tick, stage: a.value?.stage ?? b.value?.stage };
    if (a.done !== b.done) throw { ...context, path: '$', expected: a.value, actual: b.value, reason: 'record count mismatch' };
    if (a.value.type === 'header') {
      if (records !== 0 || headers !== 0 || !Number.isInteger(a.value.ticks) || a.value.ticks < 1) {
        throw { ...context, reason: 'invalid trace header' };
      }
      headers++;
      ticks = a.value.ticks;
      // Intermediate-length fixtures use the stricter short-run limit. Only
      // the specified 10,000-tick long runs receive the long-run allowance.
      limit = target ? (ticks >= 10000 ? 1e-3 : 1e-4) : 0;
    }
    const found = difference(a.value, b.value, limit, context);
    if (found) throw { ...context, ...found };
    records++;
    if (a.value.type === 'state') states++;
    if (a.value.stage === 'tick') finalTick = a.value.tick;
  }
  if (headers !== 1 || states === 0 || finalTick !== ticks) {
    throw { reason: 'incomplete trace', headers, states, expectedTicks: ticks, finalTick };
  }
  console.log(JSON.stringify({ status: 'pass', tier: target ? 'T2' : 'T1', records, states, ticks, bitExact: floatDifferences === 0, floatDifferences, maxAbsError, limit, worst }));
} catch (error) {
  console.error(JSON.stringify({ status: 'fail', tier: target ? 'T2' : 'T1', records, mismatch: error instanceof Error ? error.message : error, maxAbsError, worst }));
  process.exitCode = 1;
} finally {
  await Promise.all([left.return(), right.return()]);
}
