#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { loadSim, loadSimContent, requireStatus, SIM_ABI_VERSION } from '../../packages/sim-host/src/sim.ts';
import { SPRITE_FLAGS } from '../../packages/sim-host/src/render.ts';

const content = resolve(process.env.SOLDAT_CONTENT_ROOT ?? 'dist/content-next');
const wasm = await readFile(process.env.SOLDAT_WASM ?? 'build-out/sim/sim.wasm');
const module = await WebAssembly.compile(wasm);
const manifest = JSON.parse(await readFile(join(content, 'sim/manifest.json'), 'utf8'));
const flat = await readFile('tests/fixtures/combat/maps/combat-flat.pms');
const files = new Map();
for (const entry of Object.values(manifest.files)) files.set(entry.path, await readFile(join(content, entry.path)));
const receipt = { wasmSha256: createHash('sha256').update(wasm).digest('hex'), abi: SIM_ABI_VERSION, contentSetHash: manifest.sha256, runtime: process.version, rows: [], passed: false };
const output = resolve(process.env.GAMEPLAY_OUT ?? 'build-out/gameplay/features.json');
const appearance = { shirtColor: 0x123456, pantsColor: 0x654321, skinColor: 0xa98765, hairColor: 0x345678, jetColor: 0xabcdef, hairStyle: 3, headStyle: 2, chainStyle: 2 };

function view(host) { const result = host.renderView(); assert.notEqual(typeof result, 'number'); return result; }
function command(host, value) { return requireStatus(host.command(view(host).tick, value), `command ${value.kind}`); }
function events(host) {
  const bytes = host.events(); assert.ok(bytes instanceof Uint8Array);
  const result = [], data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length;) {
    const length = data.getUint32(offset + 16, true);
    result.push({ kind: data.getUint32(offset, true), source: data.getUint32(offset + 8, true), target: data.getUint32(offset + 12, true), payload: bytes.slice(offset + 20, offset + 20 + length) });
    offset += 20 + length;
  }
  return result;
}
function step(host, count, collect) {
  for (let i = 0; i < count; i++) { requireStatus(host.step(), 'step'); const drained = events(host); if (collect) collect.push(...drained); }
}
async function create(rules = {}, map = 'combat-flat') {
  const host = await loadSim(module);
  try {
    await loadSimContent(host, manifest, name => files.get(name));
    requireStatus(host.putFile('maps/combat-flat.pms', flat), 'fixture map');
    requireStatus(host.init({ rng: 'keyed', traceCombat: true, world: 'fixture', timeLimitTicks: 0, scoreLimit: 0, ...rules }, 123456789), 'init');
    requireStatus(host.loadMap(map), `map ${map}`);
    return host;
  } catch (error) { host.dispose(); throw error; }
}
function joinPlayer(host, slot, extra = {}) {
  command(host, { kind: 'join', slot, control: 'authoritative', name: `Feature ${slot}`, team: 0, spawn: 1, x: slot === 1 ? -300 : 100 + (slot - 2) * 180, y: -32, weapon: 2, secondaryWeapon: 0, ...extra });
}
function lethalShot(host, target, owner = 1, weapon = 8) {
  command(host, { kind: 'bullet', weapon, owner, x: -15, y: 0, vx: 30, vy: 0, target, hitCircle: 12, hitMultiply: 100 });
  for (let i = 0; i < 6; i++) {
    step(host, 1);
    if (view(host).sprite(target - 1).flags & SPRITE_FLAGS.dead) return;
  }
  assert.fail(`Actual projectile did not kill slot ${target}`);
}
function replay(host, count = 90) {
  const saved = host.saveState(); assert.ok(saved instanceof Uint8Array);
  assert.equal(new DataView(saved.buffer, saved.byteOffset).getUint32(4, true), SIM_ABI_VERSION, 'State schema must match the current simulation ABI');
  events(host); step(host, count); const hash = host.hash();
  requireStatus(host.loadState(saved), 'restore feature state'); events(host); step(host, count);
  assert.equal(host.hash(), hash, 'Restored native gameplay must replay identically');
  return hash;
}
async function check(name, run) {
  const started = performance.now();
  const evidence = await run();
  const row = { name, ...evidence, milliseconds: performance.now() - started };
  receipt.rows.push(row); console.log(JSON.stringify(row));
}
function until(host, predicate, label, limit = 600, collect) {
  for (let tick = 0; tick < limit; tick++) {
    if (predicate(view(host))) return;
    step(host, 1, collect);
  }
  assert.ok(predicate(view(host)), label);
}
function standing(host, slot = 1) {
  requireStatus(host.setInput(slot, view(host).tick, {}), 'release gesture controls');
  until(host, render => {
    const player = render.sprite(slot - 1);
    return player.bodyId === 0 && player.legsId === 0 && !!(player.flags & SPRITE_FLAGS.ground);
  }, `Slot ${slot} must settle in original standing animations`);
}
function unchangedCommand(host, value, expected) {
  const before = host.saveState(); assert.ok(before instanceof Uint8Array);
  const hash = host.hash(), status = host.command(view(host).tick, value);
  if (expected === undefined) assert.ok(status < 0, `${JSON.stringify(value)} must be rejected`);
  else assert.equal(status, expected);
  assert.equal(host.hash(), hash, 'Rejected native command must not mutate hash');
  assert.deepEqual(host.saveState(), before, 'Rejected native command must preserve exact state bytes');
}
function soundSamples(rows) {
  return rows.filter(row => row.kind === 0x80000004 && row.payload.length >= 4)
    .map(row => new DataView(row.payload.buffer, row.payload.byteOffset, row.payload.byteLength).getInt32(0, true));
}
try {
  for (const [gesture, animation, sound] of [['tabac', 27, 66], ['smoke', 25, 68], ['takeoff', 33, null], ['victory', 35, 69]]) {
    await check(`${gesture}: original idle transition, sound and byte-exact replay`, async () => {
      const host = await create();
      try {
        joinPlayer(host, 1, { appearance: { ...appearance, headStyle: 1 } }); standing(host);
        events(host);
        command(host, { kind: 'gesture', slot: 1, gesture });
        const armed = host.saveState(); assert.ok(armed instanceof Uint8Array);
        const observations = [], rows = [];
        for (let tick = 0; tick < 320; tick++) {
          step(host, 1, rows);
          const player = view(host).sprite(0);
          observations.push([player.bodyId, player.bodyFrame, player.wearHelmet, player.hasCigar]);
        }
        assert.ok(observations.some(row => row[0] === animation), `${gesture} must enter the original animation`);
        if (sound !== null) assert.ok(soundSamples(rows).includes(sound), `${gesture} must emit original sound ${sound}`);
        if (gesture === 'smoke') {
          assert.ok(observations.some(row => row[3] === 5), 'Cigar is first unlit');
          assert.ok(observations.some(row => row[3] === 10), 'Original match animation lights the cigar');
        }
        if (gesture === 'takeoff') assert.ok(observations.some(row => row[2] === 2), 'Original frame 15 removes the helmet');
        const final = host.saveState(), hash = host.hash();
        requireStatus(host.loadState(armed), 'restore armed gesture'); events(host);
        const replayed = [];
        for (let tick = 0; tick < 320; tick++) {
          step(host, 1);
          const player = view(host).sprite(0);
          replayed.push([player.bodyId, player.bodyFrame, player.wearHelmet, player.hasCigar]);
        }
        assert.deepEqual(replayed, observations, 'Every animation/helmet/cigar frame must replay');
        assert.equal(host.hash(), hash); assert.deepEqual(host.saveState(), final);
        return { animation, nativeSound: sound, replayHash: hash };
      } finally { host.dispose(); }
    });
  }
  await check('takeoff toggles helmet both ways; smoke completes its native cigar lifecycle', async () => {
    const host = await create();
    try {
      joinPlayer(host, 1, { appearance: { ...appearance, headStyle: 1 } }); standing(host);
      assert.equal(view(host).sprite(0).wearHelmet, 1);
      command(host, { kind: 'gesture', slot: 1, gesture: 'takeoff' });
      until(host, render => render.sprite(0).wearHelmet === 2, 'Helmet removal frame'); standing(host);
      command(host, { kind: 'gesture', slot: 1, gesture: 'takeoff' });
      until(host, render => render.sprite(0).wearHelmet === 1, 'Helmet replacement frame'); standing(host);
      command(host, { kind: 'gesture', slot: 1, gesture: 'smoke' });
      until(host, render => render.sprite(0).hasCigar === 10, 'Cigar must become lit');
      standing(host);
      command(host, { kind: 'gesture', slot: 1, gesture: 'smoke' });
      until(host, render => render.sprite(0).bodyId === 27, 'Lit cigar uses original smoke animation');
      until(host, render => render.sprite(0).hasCigar === 0, 'Original final smoke frame discards cigar');
      return { helmet: view(host).sprite(0).wearHelmet, cigar: 0, replayHash: replay(host, 40) };
    } finally { host.dispose(); }
  });
  await check('gestures reject dead, spectator, moving and bow takeoff without mutations; controls interrupt idle', async () => {
    const host = await create();
    try {
      joinPlayer(host, 1); standing(host);
      for (const value of [
        { kind: 'gesture', slot: 1, gesture: 'invalid' },
        { kind: 'gesture', slot: 0, gesture: 'victory' },
        { kind: 'gesture', slot: 2, gesture: 'victory' },
        { kind: 'gesture', slot: 1, gesture: 'victory', x: 1 },
        { kind: 'gesture', slot: 1, gesture: 1 },
        { kind: 'kill', slot: 1, team: 1 },
        { kind: 'kill', slot: 0 },
        { kind: 'kill', slot: 2 },
        { kind: 'team', slot: 1, team: 0, force: 'true' },
        { kind: 'spawn', slot: 1, force: true },
      ]) unchangedCommand(host, value);
      for (const gesture of ['smoke', 'tabac']) {
        standing(host); command(host, { kind: 'gesture', slot: 1, gesture }); step(host, 4);
        assert.ok([25, 27].includes(view(host).sprite(0).bodyId));
        requireStatus(host.setInput(1, view(host).tick, { Right: true }), 'interrupt idle'); step(host, 3);
        assert.ok(![25, 27].includes(view(host).sprite(0).bodyId), 'Movement must interrupt original idle animation');
        for (const denied of ['smoke', 'tabac', 'takeoff', 'victory']) unchangedCommand(host, { kind: 'gesture', slot: 1, gesture: denied }, -4);
      }
      standing(host);
      for (const weapon of [15, 16]) {
        command(host, { kind: 'spawn', slot: 1, x: -300, y: -32, weapon }); standing(host);
        assert.equal(view(host).sprite(0).weapon, weapon);
        unchangedCommand(host, { kind: 'gesture', slot: 1, gesture: 'takeoff' }, -4);
      }
      command(host, { kind: 'spawn', slot: 1, x: -300, y: -32, weapon: 2 }); step(host, 241); standing(host);
      command(host, { kind: 'kill', slot: 1 });
      assert.ok(view(host).sprite(0).flags & SPRITE_FLAGS.dead);
      for (const gesture of ['smoke', 'tabac', 'takeoff', 'victory']) unchangedCommand(host, { kind: 'gesture', slot: 1, gesture }, -4);
      unchangedCommand(host, { kind: 'kill', slot: 1 }, -4);
      command(host, { kind: 'team', slot: 1, team: 5 });
      unchangedCommand(host, { kind: 'gesture', slot: 1, gesture: 'victory' }, -4);
      unchangedCommand(host, { kind: 'kill', slot: 1 }, -4);
      return { interrupted: ['smoke', 'tabac'], bowWeapons: [15, 16], rejectedStateUnchanged: true };
    } finally { host.dispose(); }
  });
  await check('kill uses original self-damage, vest removal, death event, flag drop and score penalty', async () => {
    const host = await create({ mode: 'pm' });
    try {
      joinPlayer(host, 1, { vest: 100, heldFlag: 3 }); joinPlayer(host, 2, { health: 10 }); step(host, 241);
      lethalShot(host, 2); const kills = view(host).sprite(0).kills, deaths = view(host).sprite(0).deaths;
      assert.ok(kills > 0); events(host);
      const saved = host.saveState(); assert.ok(saved instanceof Uint8Array);
      command(host, { kind: 'kill', slot: 1 });
      const player = view(host).sprite(0), rows = events(host);
      assert.ok(player.flags & SPRITE_FLAGS.dead); assert.equal(player.vest, 0);
      assert.equal(player.deaths, deaths + 1); assert.equal(player.kills, kills - 1);
      assert.ok(rows.some(row => row.kind === 0x1001 && row.source === 1 && row.target === 1), 'Real native death event');
      for (let index = 0; index < view(host).thingCount; index++) assert.notEqual(view(host).thing(index).holdingSprite, 1, 'Death releases carried objectives');
      const killed = host.saveState(), hash = host.hash();
      requireStatus(host.loadState(saved), 'restore before self-kill'); events(host); command(host, { kind: 'kill', slot: 1 }); events(host);
      assert.equal(host.hash(), hash); assert.deepEqual(host.saveState(), killed);
      return { killsBefore: kills, killsAfter: player.kills, deaths: player.deaths, replayHash: replay(host, 20) };
    } finally { host.dispose(); }
  });
  await check('trusted forced team bypasses balance but preserves original objective and Survival handling', async () => {
    const host = await create({ mode: 'ctf', balanceTeams: true, survival: true });
    try {
      for (let slot = 1; slot <= 4; slot++) joinPlayer(host, slot, { team: 1 });
      assert.deepEqual([1, 2, 3, 4].map(slot => view(host).sprite(slot - 1).team), [1, 2, 1, 2]);
      command(host, { kind: 'spawn', slot: 2, x: 100, y: -32, heldFlag: 1 });
      const name = view(host).sprite(1).playerName;
      unchangedCommand(host, { kind: 'team', slot: 2, team: 1 }, -4);
      const saved = host.saveState(); assert.ok(saved instanceof Uint8Array);
      command(host, { kind: 'team', slot: 2, team: 1, force: true });
      assert.deepEqual([1, 2, 3, 4].map(slot => view(host).sprite(slot - 1).team), [1, 1, 1, 2], 'Forced switch must not immediately rebalance itself away');
      assert.equal(view(host).sprite(1).playerName, name);
      assert.ok(view(host).sprite(1).flags & SPRITE_FLAGS.dead, 'Original Survival team change waits for the round');
      for (let index = 0; index < view(host).thingCount; index++) assert.notEqual(view(host).thing(index).holdingSprite, 2, 'Team change releases the held flag');
      const changed = host.saveState(), hash = host.hash();
      requireStatus(host.loadState(saved), 'restore before forced switch'); events(host);
      command(host, { kind: 'team', slot: 2, team: 1, force: true });
      assert.equal(host.hash(), hash); assert.deepEqual(host.saveState(), changed);
      return { forcedTeam: 1, survivalWaiting: true, objectiveReleased: true, replayHash: replay(host, 20) };
    } finally { host.dispose(); }
  });
  const modes = [['dm', 'Arena', []], ['pm', 'Arena', [3]], ['tm', 'Arena', []], ['ctf', 'ctf_Ash', [1, 2]], ['rambo', 'Arena', [15]], ['inf', 'inf_Abel', [1, 2]], ['htf', 'htf_Arch', [3]]];
  for (const [mode, map, objectives] of modes) await check(`${mode}: native objectives, bots, state replay`, async () => {
    const host = await create({ mode, world: 'original', ai: true }, map);
    try {
      const initial = view(host); assert.equal(initial.globals.gameMode, modes.findIndex(item => item[0] === mode));
      const styles = Array.from({ length: initial.thingCount }, (_, i) => initial.thing(i).style);
      for (const style of objectives) assert.ok(styles.includes(style), `${mode} must create objective ${style}`);
      for (let slot = 1; slot <= 8; slot++) command(host, { kind: 'join', slot, control: 'bot', bot: ['Admiral', 'Billy', 'Blain', 'Boogie Man'][slot % 4], team: mode === 'tm' ? (slot - 1) % 4 + 1 : ['ctf', 'inf', 'htf'].includes(mode) ? slot % 2 + 1 : 0 });
      step(host, 1200); const hash = replay(host);
      return { map, objectiveStyles: objectives, tick: view(host).tick, replayHash: hash };
    } finally { host.dispose(); }
  });
  for (const [mode, map] of modes) await check(`${mode}: balanced joins, spectators, departures and replay`, async () => {
    const host = await create({ mode, balanceTeams: true, world: 'original', ai: true }, map);
    const count = mode === 'tm' ? 4 : ['ctf', 'inf', 'htf'].includes(mode) ? 2 : 0;
    const populations = () => {
      const sizes = Array.from({ length: count }, () => 0), render = view(host);
      for (let index = 0; index < 32; index++) {
        const player = render.sprite(index);
        if ((player.flags & SPRITE_FLAGS.active) && player.team >= 1 && player.team <= count) sizes[player.team - 1]++;
        if (!count && (player.flags & SPRITE_FLAGS.active)) assert.ok(player.team === 0 || player.team === 5);
      }
      if (count) assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `Unbalanced ${mode}: ${sizes}`);
      return sizes;
    };
    try {
      for (let slot = 1; slot <= 9; slot++) {
        command(host, { kind: 'join', slot, control: 'authoritative', team: count ? 1 : 0, name: `Balance ${slot}` });
        populations();
      }
      command(host, { kind: 'join', slot: 10, control: 'authoritative', team: 5 });
      assert.equal(view(host).sprite(9).team, 5); populations();
      if (count) {
        const hash = host.hash();
        assert.equal(host.command(view(host).tick, { kind: 'team', slot: 2, team: 1 }), -4);
        assert.equal(host.hash(), hash, 'Denied unbalanced switch must not change state');
        command(host, { kind: 'team', slot: 1, team: 5 }); populations();
        command(host, { kind: 'leave', slot: 2 }); populations();
      }
      const sizes = populations(), hash = replay(host, 30);
      requireStatus(host.loadMap(map), 'balanced map epoch'); populations();
      assert.equal(view(host).sprite(9).team, 5);
      return { playableTeams: count, populations: sizes, spectatorExcluded: true, replayHash: hash };
    } finally { host.dispose(); }
  });
  await check('balancing prefers true bots and preserves Survival death/identity during replacement', async () => {
    const host = await create({ mode: 'ctf', balanceTeams: true, survival: true, world: 'original', ai: true }, 'ctf_Ash');
    try {
      for (let slot = 1; slot <= 5; slot++) command(host, slot === 3
        ? { kind: 'join', slot, team: 1, control: 'bot', bot: 'Admiral' }
        : { kind: 'join', slot, team: 1, control: 'authoritative', name: `Balance ${slot}` });
      step(host, 1);
      const deaths = view(host).sprite(2).deaths;
      command(host, { kind: 'leave', slot: 2 });
      assert.equal(view(host).sprite(2).team, 2);
      assert.ok(view(host).sprite(2).flags & SPRITE_FLAGS.dead);
      assert.equal(view(host).sprite(2).deaths, deaths);
      for (const slot of [1, 4, 5]) assert.equal(view(host).sprite(slot - 1).playerName, `Balance ${slot}`);
      command(host, { kind: 'leave', slot: 3, replacement: true });
      command(host, { kind: 'join', slot: 6, team: 1, control: 'authoritative', name: 'Replacement' });
      assert.equal(view(host).sprite(5).team, 2);
      assert.ok(view(host).sprite(5).flags & SPRITE_FLAGS.dead);
      assert.equal(view(host).sprite(5).deaths, 0);
      const hash = replay(host, 30);
      return { movedBot: 3, humanSlots: [1, 4, 5, 6], replacementTeam: 2, survivalWaiting: true, replayHash: hash };
    } finally { host.dispose(); }
  });
  await check('balancing defaults off and is an immutable state rule', async () => {
    const disabled = await create({ mode: 'ctf' }), enabled = await create({ mode: 'ctf', balanceTeams: true });
    try {
      for (const host of [disabled, enabled]) for (const slot of [1, 2]) joinPlayer(host, slot, { team: 1 });
      assert.deepEqual([view(disabled).sprite(0).team, view(disabled).sprite(1).team], [1, 1]);
      assert.deepEqual([view(enabled).sprite(0).team, view(enabled).sprite(1).team], [1, 2]);
      const state = enabled.saveState(); assert.ok(state instanceof Uint8Array);
      const hash = disabled.hash(); assert.ok(disabled.loadState(state) < 0); assert.equal(disabled.hash(), hash);
      return { defaultEnabled: false, immutableMismatchRejected: true };
    } finally { disabled.dispose(); enabled.dispose(); }
  });
  await check('realistic dead players can render teammates while following a native bot', async () => {
    const host = await create({ mode: 'tm', realistic: true, ai: false });
    try {
      joinPlayer(host, 1, { team: 1, health: 10 });
      command(host, { kind: 'join', slot: 2, control: 'bot', bot: 'Admiral', team: 1, spawn: 1 });
      joinPlayer(host, 3, { team: 2 }); joinPlayer(host, 4, { team: 1 });
      step(host, 300);
      const observerBit = 1 << (2 - 1);
      assert.equal(view(host).sprite(3).visibleMask & observerBit, 0, 'Unused bot observers do not run presentation LOS');
      lethalShot(host, 1, 3);
      assert.ok(view(host).sprite(0).flags & SPRITE_FLAGS.dead);
      assert.ok(view(host).sprite(3).visibleMask & observerBit, 'A followable bot observer must reveal its teammates');
      return { observerSlot: 2, visibleTeammate: 4, replayHash: replay(host) };
    } finally { host.dispose(); }
  });
  await check('pointmatch doubles a flag-carrier kill', async () => {
    const host = await create({ mode: 'pm' });
    try {
      joinPlayer(host, 1, { heldFlag: 3 }); joinPlayer(host, 2, { health: 10 });
      step(host, 241); lethalShot(host, 2);
      assert.equal(view(host).sprite(0).kills, 2); replay(host);
      return { flagStyle: 3, killPoints: 2 };
    } finally { host.dispose(); }
  });
  await check('teammatch awards the killer team rather than every team', async () => {
    const host = await create({ mode: 'tm' });
    try {
      joinPlayer(host, 1, { team: 3 }); joinPlayer(host, 2, { team: 4, health: 10 });
      step(host, 241); lethalShot(host, 2);
      assert.equal(view(host).sprite(0).kills, 1);
      assert.deepEqual(Array.from(view(host).globals.teamScores).slice(1, 5), [0, 0, 1, 0]);
      replay(host); return { killerTeam: 3, teamScores: [0, 0, 1, 0] };
    } finally { host.dispose(); }
  });
  await check('rambo awards a point for killing the bow carrier', async () => {
    const host = await create({ mode: 'rambo' });
    try {
      joinPlayer(host, 1); joinPlayer(host, 2, { health: 10, weapon: 15 });
      step(host, 241); assert.equal(view(host).sprite(1).weapon, 15); lethalShot(host, 2);
      assert.equal(view(host).sprite(0).kills, 1); replay(host); return { victimWeapon: 15, killPoints: 1 };
    } finally { host.dispose(); }
  });
  await check('infiltration awards native defensive points at five seconds', async () => {
    const host = await create({ mode: 'inf', world: 'original' }, 'inf_Abel');
    try {
      command(host, { kind: 'join', slot: 1, team: 1, control: 'authoritative', weapon: 2 });
      command(host, { kind: 'join', slot: 2, team: 2, control: 'authoritative', weapon: 2 });
      step(host, 299); assert.equal(view(host).globals.teamScores[2], 0);
      step(host, 1); assert.equal(view(host).globals.teamScores[2], 1);
      assert.equal(view(host).globals.teamScores[1], 0); replay(host);
      return { defenderPoints: 1, intervalTicks: 300 };
    } finally { host.dispose(); }
  });
  await check('hold-the-flag awards the carrier team at the native interval', async () => {
    const host = await create({ mode: 'htf' });
    try {
      joinPlayer(host, 1, { team: 1, heldFlag: 3 }); joinPlayer(host, 2, { team: 2 });
      step(host, 299); assert.equal(view(host).globals.teamScores[1], 0);
      step(host, 1); assert.equal(view(host).globals.teamScores[1], 1);
      assert.equal(view(host).globals.teamScores[2], 0); replay(host);
      return { carrierTeam: 1, teamPoints: 1, intervalTicks: 300 };
    } finally { host.dispose(); }
  });
  await check('appearance and native team changes preserve identity and loadout', async () => {
    const host = await create({ mode: 'tm' });
    try {
      joinPlayer(host, 1, { team: 1, appearance });
      const before = view(host).sprite(0); assert.equal(before.pantsColor & 0xffffff, appearance.pantsColor); assert.equal(before.hairStyle, 3); assert.equal(before.chain, 2);
      const teamShirt = before.shirtColor;
      command(host, { kind: 'team', slot: 1, team: 2 });
      const after = view(host).sprite(0); assert.equal(after.team, 2); assert.equal(after.playerName, 'Feature 1'); assert.notEqual(after.shirtColor, teamShirt);
      command(host, { kind: 'appearance', slot: 1, appearance: { ...appearance, pantsColor: 0x112233 } });
      assert.equal(view(host).sprite(0).pantsColor & 0xffffff, 0x112233);
      const hash = host.hash();
      assert.ok(host.command(view(host).tick, { kind: 'appearance', slot: 1, appearance: { ...appearance, hairStyle: 99 } }) < 0);
      assert.equal(host.hash(), hash, 'Invalid appearance must not partially mutate gameplay');
      assert.ok(host.command(view(host).tick, { kind: 'team', slot: 1, team: 9 }) < 0);
      assert.equal(host.hash(), hash, 'Invalid team must not mutate gameplay');
      replay(host); return { from: 1, to: 2, player: after.playerName, pants: '112233' };
    } finally { host.dispose(); }
  });
  await check('realistic uses original health and weapon configuration', async () => {
    const host = await create({ realistic: true });
    try { joinPlayer(host, 1); const player = view(host).sprite(0); assert.equal(player.health, 65); assert.equal(view(host).globals.startHealth, 65); replay(host); return { health: player.health, startHealth: 65 }; }
    finally { host.dispose(); }
  });
  await check('restricted guns reject immediate equip and survive roundtrip', async () => {
    const host = await create({ weapons: [4, 0] });
    try {
      joinPlayer(host, 1, { weapon: 4 });
      assert.equal(view(host).globals.enabledWeaponsMask, (1 << 3) | (1 << 10));
      assert.ok(host.command(view(host).tick, { kind: 'weapon-apply', slot: 1, weapon: 1 }) < 0);
      command(host, { kind: 'weapon-apply', slot: 1, weapon: 4, secondaryWeapon: 0 });
      assert.equal(view(host).sprite(0).weapon, 4);
      assert.equal(view(host).sprite(0).secondaryWeapon, 0);
      replay(host); return { allowed: 4, refused: 1, secondary: 0 };
    } finally { host.dispose(); }
  });
  await check('explicit stock weapon list enables all selectable primary and secondary guns', async () => {
    const host = await create({ weapons: Array.from({ length: 14 }, (_, number) => number) });
    try {
      joinPlayer(host, 1, { weapon: 8, secondaryWeapon: 13 });
      assert.equal(view(host).globals.enabledWeaponsMask, 0x3fff);
      assert.equal(view(host).sprite(0).weapon, 8);
      assert.equal(view(host).sprite(0).secondaryWeapon, 13);
      command(host, { kind: 'weapon-apply', slot: 1, weapon: 4, secondaryWeapon: 11 });
      assert.equal(view(host).sprite(0).weapon, 4);
      assert.equal(view(host).sprite(0).secondaryWeapon, 11);
      replay(host); return { enabledMask: 0x3fff, appliedPrimary: 4, appliedSecondary: 11 };
    } finally { host.dispose(); }
  });
  await check('time limit ends once, counts down and resets a real map preserving player', async () => {
    const host = await create({ timeLimitTicks: 120 });
    try {
      joinPlayer(host, 1, { appearance }); const collected = []; let sawResults = false;
      for (let i = 0; i < 1000 && view(host).globals.roundPhase !== 2; i++) { step(host, 1, collected); sawResults ||= view(host).globals.roundPhase === 1; }
      assert.ok(sawResults); assert.equal(view(host).globals.roundPhase, 2);
      assert.equal(collected.filter(item => item.kind === 0x1007).length, 1, 'Exactly one native match-end per round');
      const tick = view(host).tick, epoch = view(host).globals.roundEpoch;
      requireStatus(host.loadMap('Arena'), 'next map');
      const next = view(host); assert.equal(next.tick, tick); assert.equal(next.globals.roundEpoch, epoch + 1); assert.equal(next.globals.roundPhase, 0); assert.equal(next.globals.timeLeftTicks, 120);
      assert.equal(next.sprite(0).playerName, 'Feature 1'); assert.equal(next.sprite(0).pantsColor & 0xffffff, appearance.pantsColor); assert.equal(next.sprite(0).kills, 0);
      replay(host, 30); return { endEvents: 1, preservedTick: tick, epoch: epoch + 1 };
    } finally { host.dispose(); }
  });
  await check('score limit ends a round from a real projectile kill', async () => {
    const host = await create({ scoreLimit: 1 });
    try {
      joinPlayer(host, 1); joinPlayer(host, 2, { health: 10 }); step(host, 241); lethalShot(host, 2);
      assert.equal(view(host).sprite(0).kills, 1);
      assert.equal(view(host).globals.roundPhase, 1, 'Native score limit must start results/countdown');
      replay(host, 10); return { kills: 1, scoreLimit: 1, roundPhase: 1 };
    } finally { host.dispose(); }
  });
  await check('real death activates original bullet-time slowdown', async () => {
    const host = await create({ bulletTime: true });
    try {
      joinPlayer(host, 1, { x: -100 }); joinPlayer(host, 2, { health: 10, x: 100 }); step(host, 241); lethalShot(host, 2);
      const scale = view(host).globals.tickScale; assert.ok(Math.abs(scale - 1 / 3) < 0.00001, `Expected original 1/3 slowdown, got ${scale}`);
      replay(host, 5); step(host, 60); assert.equal(view(host).globals.tickScale, 1); return { slowScale: scale, recoveredScale: 1 };
    } finally { host.dispose(); }
  });
  await check('survival holds eliminated players until original round reset', async () => {
    const host = await create({ survival: true });
    try {
      joinPlayer(host, 1); joinPlayer(host, 2, { health: 10 }); joinPlayer(host, 3, { health: 10 });
      for (let i = 0; i < 1000 && view(host).sprite(1).ceaseFireCounter > 0; i++) step(host, 1);
      assert.equal(view(host).sprite(1).ceaseFireCounter, 0, 'Wait for native Survival spawn protection before combat');
      lethalShot(host, 2); step(host, 400);
      assert.ok(view(host).sprite(1).flags & SPRITE_FLAGS.dead, 'Eliminated player cannot respawn while two opponents survive');
      command(host, { kind: 'join', slot: 4, control: 'bot', bot: 'Admiral', team: 0 });
      assert.ok(view(host).sprite(3).flags & SPRITE_FLAGS.dead, 'A replacement bot must wait out the same elimination round');
      assert.equal(view(host).sprite(3).deaths, 0, 'Admission waiting is not a scored death');
      lethalShot(host, 3); let reset = false;
      for (let i = 0; i < 1200; i++) { step(host, 1); if (!(view(host).sprite(1).flags & SPRITE_FLAGS.dead)) { reset = true; break; } }
      assert.ok(reset, 'Final elimination must allow native survival respawn'); replay(host); return { heldTicks: 400, nativeReset: true };
    } finally { host.dispose(); }
  });
  await check('advance unlocks a gun from a real kill', async () => {
    const host = await create({ advance: true, advanceAmount: 1 });
    try {
      joinPlayer(host, 1); joinPlayer(host, 2, { health: 10 });
      requireStatus(host.loadMap('combat-flat'), 'advance next round');
      const initial = view(host).sprite(0).availableWeaponsMask;
      step(host, 400); lethalShot(host, 2, 1, 0);
      const unlocked = view(host).sprite(0).availableWeaponsMask;
      assert.notEqual(unlocked, initial, 'Advance progression must actually change selectable weapons');
      assert.equal(view(host).sprite(0).kills, 1); replay(host); return { beforeMask: initial, afterMask: unlocked, kills: 1 };
    } finally { host.dispose(); }
  });
  await check('all five enabled bonuses spawn through native timed scheduler', async () => {
    const host = await create({ mode: 'dm', world: 'original', bonusFrequency: 5, bonusFlamer: true, bonusPredator: true, bonusBerserker: true, bonusVest: true, bonusCluster: true }, 'Arena');
    try {
      const found = new Set(); let ticks = 0;
      for (; ticks < 60000 && found.size < 5; ticks++) {
        step(host, 1); const current = view(host);
        for (let index = 0; index < current.thingCount; index++) { const style = current.thing(index).style; if (style >= 18 && style <= 22) found.add(style); }
      }
      assert.deepEqual([...found].sort((a, b) => a - b), [18, 19, 20, 21, 22]);
      replay(host); return { styles: [...found].sort((a, b) => a - b), ticks };
    } finally { host.dispose(); }
  });
  receipt.passed = true;
} finally {
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
}
