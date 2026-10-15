#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadSim, loadSimContent, requireStatus } from '../../packages/sim-host/src/sim.ts';
const wasmPath = process.argv[2] ?? 'build-out/sim/sim.wasm';
const wasm = new Uint8Array(await readFile(wasmPath));
const manifest = JSON.parse(await readFile('dist/content/sim/manifest.json', 'utf8'));
const host = await loadSim(wasm);
try {
  await loadSimContent(host, manifest, async path => new Uint8Array(await readFile(resolve('dist/content', path))));
  requireStatus(host.init({}, 123456789, 0, 0), 'init');
  requireStatus(host.loadMap('Arena'), 'map');
  for (let slot = 1; slot <= 2; slot++) requireStatus(host.command(0, { kind: 'join', slot, team: 0, spawn: slot }), 'join');
  for (let tick = 0; tick < 60; tick++) {
    for (let slot = 1; slot <= 2; slot++) requireStatus(host.setInput(slot, tick, {}), 'input');
    if (requireStatus(host.step(), 'step') !== tick + 1) throw new Error('Incorrect tick');
    const events = host.events();
    if (typeof events === 'number') requireStatus(events, 'events');
  }
  const size = requireStatus(host.exports.sim_save_state(0, 0), 'size');
  const pointer = host.exports.sim_alloc(size);
  if (!pointer) throw new Error('State allocation failed');
  try {
    const save = () => {
      const count = requireStatus(host.exports.sim_save_state(pointer, size), 'save');
      if (count !== size) throw new Error('State length changed during timing');
    };
    const hash = () => host.exports.sim_hash_state();
    for (let i = 0; i < 100; i++) { save(); hash(); }
    const saveTimes = [], hashTimes = [], combined = [];
    for (let i = 0; i < 500; i++) {
      const start = performance.now(); save(); const middle = performance.now(); hash(); const end = performance.now();
      saveTimes.push(middle - start); hashTimes.push(end - middle); combined.push(end - start);
    }
    const stats = samples => {
      const sorted = [...samples].sort((a, b) => a - b);
      return { meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
        p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)],
        p99Ms: sorted[Math.floor(sorted.length * .99)], maxMs: sorted.at(-1) };
    };
    console.log(JSON.stringify({ runtime: process.version, platform: `${process.platform}/${process.arch}`,
      wasmSha256: createHash('sha256').update(wasm).digest('hex'), players: 2, tick: 60, stateBytes: size,
      iterations: 500, persistentOutputBuffer: true, save: stats(saveTimes), hash: stats(hashTimes),
      combined: stats(combined), belowOneMillisecondP95: stats(combined).p95Ms < 1 }));
  } finally { host.exports.sim_free(pointer); }
} finally { host.dispose(); }
