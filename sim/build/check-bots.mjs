#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSim, loadSimContent, requireStatus } from '../../packages/sim-host/src/sim.ts';
import { RENDER_LAYOUT, SPRITE_FLAGS } from '../../packages/sim-host/src/render.ts';

const options = { wasm: 'build-out/sim/sim.wasm', content: 'dist/content', out: 'build-out/sim/g5/robustness.json', minutes: '5', maps: '', rng: 'keyed' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (!Object.hasOwn(options, key) || !process.argv[i + 1]) throw new Error('Usage: node --expose-gc sim/build/check-bots.mjs [--minutes 5|30] [--maps Arena,ctf_Ash] [--rng original|keyed] [--wasm FILE] [--content DIR] [--out FILE]');
  options[key] = process.argv[i + 1];
}
const minutes = Number(options.minutes), ticks = minutes * 3600;
if (!Number.isInteger(minutes) || minutes < 1 || !['original', 'keyed'].includes(options.rng)) throw new Error('Invalid duration/policy');
const wasm = await readFile(options.wasm), digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(options.content, 'sim/manifest.json'), 'utf8'));
const catalog = JSON.parse(await readFile(join(options.content, 'manifest.json'), 'utf8'));
const requested = new Set(options.maps.split(',').filter(Boolean));
const maps = Object.keys(catalog.maps).filter(name => catalog.maps[name].botCapable && (!requested.size || requested.has(name))).sort();
if (!maps.length || [...requested].some(name => !maps.includes(name))) throw new Error('Requested map absent or bot-incapable');
const profiles = Object.keys(manifest.files).filter(id => id.startsWith('bots/')).sort().map(id => id.slice(5, -4));
if (profiles.length !== 16) throw new Error('Expected all 16 pinned profiles');
const identity = { wasmSha256: digest(wasm), contentSetHash: manifest.sha256, minutes, ticks, bots: 8, rng: options.rng, seed: 123456789 };
let results = [];
try {
  const previous = JSON.parse(await readFile(options.out, 'utf8'));
  if (JSON.stringify(previous.identity) !== JSON.stringify(identity)) throw new Error('Cannot resume mismatched robustness identity');
  results = previous.results;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(resolve(options.out, '..'), { recursive: true });
async function match(map, mode) {
  const started = performance.now(), entry = manifest.files[`maps/${map.toLowerCase()}.pms`];
  const source = JSON.parse(await readFile(join(options.content,catalog.maps[map].path),'utf8'));
  if(source.mapSha256!==entry.sha256) throw new Error('Map catalog identity mismatch');
  const tracks = Array.from({ length: 8 }, () => ({ waypoint: -1, unchangedTicks: 0, longestTicks: 0, stalledEpisodes: 0, waypointChanges: 0, aliveTicks: 0, combatTicks: 0 }));
  const result = { map, mode, mapSha256: entry.sha256, hasAlphaFlagSpawn: source.spawnpoints.some(point => point.active && point.team === 5), hasBravoFlagSpawn: source.spawnpoints.some(point => point.active && point.team === 6), ticks: 0, status: 'pass', crashes: 0, tracks };
  let host, eventBuffer = 0;
  try {
    host = await loadSim(wasm);
    await loadSimContent(host, manifest, path => readFile(join(options.content, path)));
    requireStatus(host.init({ mode, rng: options.rng, ai: true, botDifficulty: 100 }, identity.seed), 'init');
    requireStatus(host.loadMap(map), 'map');
    for (let index = 0; index < 8; index++) requireStatus(host.command(0, { kind: 'join', slot: index + 1, team: mode === 'ctf' ? index % 2 + 1 : 0, control: 'bot', bot: profiles[index] }), 'bot join');
    eventBuffer = host.exports.sim_alloc(1048576);
    if (!eventBuffer) throw new Error('Event scratch allocation failed');
    let memory, data;
    const s = RENDER_LAYOUT.sprite;
    for (let tick = 1; tick <= ticks; tick++) {
      requireStatus(host.step(), 'step');
      const ptr = host.exports.sim_render_view();
      if (memory !== host.exports.memory.buffer) { memory = host.exports.memory.buffer; data = new DataView(memory); }
      requireStatus(host.exports.sim_events(eventBuffer, 1048576), 'event drain');
      for (let index = 0; index < 8; index++) {
        const base = ptr + RENDER_LAYOUT.headerBytes + index * RENDER_LAYOUT.spriteBytes, track = tracks[index];
        const flags = data.getUint32(base + s.flags, true), waypoint = data.getInt32(base + s.currentWaypoint, true);
        if (!(flags & SPRITE_FLAGS.active) || flags & SPRITE_FLAGS.dead) { track.unchangedTicks = 0; track.waypoint = waypoint; continue; }
        track.aliveTicks++;
        if (data.getUint32(base + s.controlBits, true) & 16) track.combatTicks++;
        if (waypoint !== track.waypoint) { track.waypointChanges++; track.unchangedTicks = 0; track.waypoint = waypoint; }
        else track.unchangedTicks++;
        track.longestTicks = Math.max(track.longestTicks, track.unchangedTicks);
        if (track.unchangedTicks === 601) track.stalledEpisodes++;
      }
      result.ticks = tick;
    }
    const view = host.renderView();
    result.scores = Array.from({ length: 8 }, (_, index) => { const player = view.sprite(index); return { slot: index + 1, name: player.playerName, team: player.team, kills: player.kills, deaths: player.deaths, captures: player.playerFlags }; });
    result.teamScores = Array.from(view.globals.teamScores);
    result.finalHash = host.hash();
  } catch (error) {
    result.status = 'fail'; result.crashes = 1; result.error = error.stack ?? String(error);
  } finally {
    if (eventBuffer) host.exports.sim_free(eventBuffer);
    host?.dispose();
  }
  result.stalledBots = tracks.filter(track => track.stalledEpisodes > 0).length;
  result.stalledEpisodes = tracks.reduce((sum, track) => sum + track.stalledEpisodes, 0);
  result.wallSeconds = (performance.now() - started) / 1000;
  return result;
}
for (const map of maps) for (const mode of ['dm', 'ctf']) {
  if (results.some(result => result.map === map && result.mode === mode && result.ticks === ticks && result.status === 'pass')) continue;
  results = results.filter(result => result.map !== map || result.mode !== mode);
  const result = await match(map, mode); results.push(result);
  await writeFile(options.out, `${JSON.stringify({ version: 1, runtime: `Node ${process.version}`, identity, selectedMaps: maps, definition: 'An alive bot with unchanged CurrentWaypoint for >600 consecutive ticks is flagged. Combat and authored camping can cause legitimate flags; no AI behavior is changed to hide them.', results }, null, 2)}\n`);
  console.log(JSON.stringify({ map, mode, status: result.status, ticks: result.ticks, crashes: result.crashes, stalledBots: result.stalledBots, stalledEpisodes: result.stalledEpisodes, teamScores: result.teamScores, wallSeconds: result.wallSeconds }));
  global.gc?.();
}
if (results.some(result => result.status !== 'pass')) process.exitCode = 1;
