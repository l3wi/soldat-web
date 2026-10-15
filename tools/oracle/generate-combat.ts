import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { platform, writeMovementPms, type Triangle } from '../../tests/tools/write-movement-pms.ts';
import { parsePms } from '../../packages/content/src/readers.ts';
import type { Fixture } from '../../packages/sim-host/src/fixture.ts';

// Authoring only. No simulation, oracle capture, or acceptance result is produced here.
const directory = 'tests/fixtures/combat';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile('dist/content/sim/manifest.json', 'utf8'));
await mkdir(`${directory}/maps`, { recursive: true });
type MapSpec = { name: string; path: string; sha256: string; contentSetHash: string };
async function map(name: string, triangles: Triangle[], colliders: [number, number, number][] = []): Promise<MapSpec> {
  // Reuse the movement writer's polygon normals and sector ordering unchanged.
  // Replace only its zero prop/scenery/collider tail and single spawn with combat records.
  const base = writeMovementPms(triangles, 190);
  const spawns = [[0, -32, 0], [-600, -32, 5], [600, -32, 6], ...Array.from({ length: 9 }, (_, i) => [1200, -100, i + 7])];
  const tail = Buffer.alloc(12 + colliders.length * 16 + 4 + spawns.length * 16 + 4);
  let offset = 8;
  tail.writeInt32LE(colliders.length, offset); offset += 4;
  for (const [x, y, radius] of colliders) {
    tail[offset] = 1; tail.writeFloatLE(x, offset + 4); tail.writeFloatLE(y, offset + 8); tail.writeFloatLE(radius, offset + 12); offset += 16;
  }
  tail.writeInt32LE(spawns.length, offset); offset += 4;
  for (const [x, y, team] of spawns) {
    tail[offset] = 1; tail.writeInt32LE(x!, offset + 4); tail.writeInt32LE(y!, offset + 8); tail.writeInt32LE(team!, offset + 12); offset += 16;
  }
  const bytes = Buffer.concat([base.subarray(0, base.length - 36), tail]);
  parsePms(bytes);
  const path = `${directory}/maps/${name}.pms`, sha256 = hash(bytes);
  await writeFile(path, bytes);
  const files = { ...manifest.files, [`maps/${name}.pms`]: { sha256 } };
  return { name, path, sha256, contentSetHash: hash(Object.keys(files).sort().map(id => `${id}\t${files[id].sha256}\n`).join('')) };
}
const flat = await map('combat-flat', platform(0));
const wall = await map('combat-thin-wall', [...platform(0), { type: 0, vertices: [[0, -150], [1, -150], [1, 0]] }, { type: 0, vertices: [[0, -150], [1, 0], [0, 0]] }]);
const ricochet = await map('combat-ricochet', platform(0));
const collider = await map('combat-collider', platform(0), [[0, -22, 12]]);
const names: string[] = [];
const player = (x = -300, extra: Record<string, unknown> = {}) => ({ team: 0, spawnpoint: 1, x, y: -32, weapon: 2, secondaryWeapon: 0, health: 150, grenades: 3, control: 'authoritative' as const, ...extra });
const input = (player: number, start: number, ticks: number, control: Record<string, unknown>) => ({ player, start, ticks, control });
const bullet = (tick: number, extra: Record<string, unknown> = {}) => ({ tick, kind: 'bullet', weapon: 2, owner: 1, x: -100, y: -22, vx: 100, vy: 0, ...extra });
const thing = (tick: number, style: number, x: number, y = -25) => ({ tick, kind: 'thing', style, owner: 0, x, y, ammo: 255 });
async function fixture(name: string, players: Fixture['players'], inputs: Fixture['inputs'], commands: Record<string, unknown>[] = [], options: { map?: MapSpec; ticks?: number; mode?: string; purpose?: string; limitations?: string[]; required?: Record<string, unknown>[] } = {}) {
  const m = options.map ?? flat;
  const record = { version: 1, map: m.name, mapPath: m.path, mapDirectory: '/fixture-maps', mapSha256: m.sha256, contentSetHash: m.contentSetHash, seed: 123456789, ticks: options.ticks ?? 360, traceStages: 'all', rules: { mode: options.mode ?? 'dm', rng: 'original', traceCombat: true }, players, inputs, commands,
    metadata: { purpose: options.purpose ?? name, source: 'Test-only PMS v11; pinned weapons/animations/objects from simulation manifest.', controlRole: 'authoritative: original BOT authority with Dummy=true disables AI; adapter restores original HUMAN held-trigger gating before the server cooldown step. Legacy fixtures default to unmodified HUMAN.', humanControlExpectation: 'Pinned Control.pas:555-569 resets BurstCount when Fire is released; FireMode=2 holds the cooldown above zero after the first shot while Fire remains held. One trigger hold emits one firing action, not one projectile (Eagles/Spas emit multiple).', commandTiming: 'Commands at tick N are applied after completing step N and before its recorded state, affecting step N+1.', evidenceStatus: 'authored-not-captured', requiredObservations: options.required ?? [], limitations: options.limitations ?? [] } };
  const filename = `${name}.fixture.json`;
  await writeFile(`${directory}/${filename}`, `${JSON.stringify(record, null, 2)}\n`); names.push(filename);
}
for (const posture of ['standing', 'crouch', 'prone', 'moving']) {
  const target = posture === 'crouch' ? [input(2, 1, 360, { Down: true })] : posture === 'prone' ? [input(2, 1, 1, { Prone: true })] : posture === 'moving' ? [input(2, 31, 90, { Left: true }), input(2, 121, 90, { Right: true })] : [];
  await fixture(`target-${posture}`, [player(-300), player(100)], [input(1, 61, 150, { Fire: true, MouseAimX: 100, MouseAimY: -22 }), ...target], [], { required: [{ kind: 'health-loss', slot: 2 }, { kind: 'posture', slot: 2, posture }] });
}
for (const circle of [12, 11, 10, 6, 5, 4, 3]) {
  const probes: Record<string, unknown>[] = [];
  for (let direction = 0; direction < 16; direction++) for (const tangent of [-6, 0, 6]) {
    const dx = Math.cos(direction * Math.PI / 8), dy = Math.sin(direction * Math.PI / 8);
    probes.push(bullet(60 + probes.length * 5, { target: 2, hitCircle: circle, x: -dx * 15 - dy * tangent, y: -dy * 15 + dx * tangent, vx: dx * 30, vy: dy * 30, hitMultiply: 0.001 }));
  }
  await fixture(`hit-circle-${circle}`, [player(-300), player(100, { health: 10000 })], [], probes, { required: [{ kind: 'hit-circle', slot: 2, circle }] });
}
await fixture('thin-wall-high-speed', [player(-300), player(100)], [], [bullet(60, { x: -99.5, vx: 300 })], { map: wall, required: [{ kind: 'collision-winner', collisionKind: 'map', start: 61, end: 61 }], limitations: ['Actual polygon-contact and final accepted branch are now instrumented; this fixture is not branch proof until its measured collision-winner predicate passes capture.'] });
await fixture('ricochet-shallow', [player(-300)], [], [bullet(60, { x: -300, y: -2, vx: 30, vy: 1 })], { map: ricochet, required: [{ kind: 'ricochet' }] });
for (const [name, m, targetX, objectX] of [['collider-before-player-thing', collider, 70, 35], ['player-before-thing', flat, 0, 35], ['thing-before-player', flat, 60, 0]] as const) {
  const winner = name.startsWith('collider') ? 'collider' : name.startsWith('player') ? 'sprite' : 'thing';
  const required = [{ kind: 'collision-winner', collisionKind: winner, start: 61, end: 61 }];
  if (winner === 'collider') required.push({ kind: 'collision-rejected', collisionKind: 'sprite', start: 61, end: 61 });
  if (winner !== 'thing') required.push({ kind: 'collision-rejected', collisionKind: 'thing', start: 61, end: 61 });
  else required.push({ kind: 'collision-accepted', collisionKind: 'sprite', start: 61, end: 61 });
  await fixture(`ordering-${name}`, [player(-300), player(targetX)], [], [thing(50, 1, objectX, -22), bullet(60, { x: -80, vx: 160, timeout: 400 })], { map: m, required, limitations: ['Collision winner means the last distance-accepted original response, not absence of earlier response effects. Accepted/rejected contact predicates remain unproved until captured.'] });
}
await fixture('damage-decay-500-900', [player(-1200)], [], [bullet(60, { x: -1100, y: -140, vx: 25, vy: -0.2 })], { required: [{ kind: 'decay', count: 2 }] });
for (const action of ['ChangeWeapon', 'ThrowNade', 'ThrowWeapon']) await fixture(`reload-interrupted-${action.toLowerCase()}`, [player(-300, { ammo: 1 })], [input(1, 61, 1, { Reload: true }), input(1, 80, 12, { [action]: true, MouseAimX: 300, MouseAimY: -80 }), input(1, 151, 100, { Fire: true, MouseAimX: 300, MouseAimY: -22 })], [], { required: [{ kind: 'reload' }] });
for (const weapon of [1, 5]) for (const consumers of [1, 2]) await fixture(`${weapon === 1 ? 'eagles' : 'shotgun'}-seed-${consumers}-shooters`, Array.from({ length: consumers }, (_, i) => player(-300 + i * 100, { weapon })), Array.from({ length: consumers }, (_, i) => input(i + 1, 61, 180, { Fire: true, MouseAimX: 700, MouseAimY: -60 })), [], { required: [{ kind: 'bullet-style', style: weapon === 1 ? 1 : 3 }], limitations: ['Seed values and trajectories are captured; policy equivalence is within each RNG policy, not equality between original and keyed.'] });
for (const frame of [14, 15, 23, 24, 36]) await fixture(`grenade-release-frame-${frame}`, [player(-300)], [input(1, 1, 360, { MouseAimX: 300, MouseAimY: -80 }), ...(frame === 36 ? [input(1, 61, 1, { ThrowNade: true, MouseAimX: 300, MouseAimY: -80 })] : [])], [{ tick: 60, kind: 'fixture-sprite', slot: 1, bodyAnimation: 'Throw', bodyFrame: frame, grenadeWeapon: 50 }], { required: [{ kind: 'grenade-release', frame, emitted: frame !== 14 }] });
await fixture('cluster-fragments', [player(-300)], [], [bullet(60, { weapon: 51, x: 100, y: -30, vx: 0, vy: 1, timeout: 2 })], { required: [{ kind: 'bullet-style', style: 10 }] });
await fixture('self-boost', [player(0, { health: 10000 })], [], [bullet(60, { weapon: 50, x: -10, y: -20, vx: 0, vy: 0, timeout: 2 })], { required: [{ kind: 'self-boost', slot: 1, after: 60 }] });
await fixture('weapon-drop-pickup', [player(-20, { weapon: 3 }), player(20, { weapon: 255 })], [input(1, 61, 30, { ThrowWeapon: true, MouseAimX: 100, MouseAimY: -22 }), input(2, 100, 30, { Left: true })], [], { required: [{ kind: 'thing-style', style: 7 }] });
for (const style of [16, 17, 18, 19, 20, 21, 22]) await fixture(`thing-kit-${style}`, [player(0, { health: 40, grenades: 0 })], [], [-32, -24, -16, -8].map((y, i) => thing(60 + i * 30, style, 0, y)), { required: [{ kind: 'thing-style', style }, { kind: 'pickup', slot: 1, style }] });
for (const style of [23, 27]) await fixture(`thing-kit-${style}`, [player(0)], [], [thing(60, style, 0)], { required: [{ kind: 'thing-style', style }], limitations: ['Parachute and stationary gun creation is witnessed, but use requires a heldThing/fire transition; these optional probes do not claim kit-pickup coverage.'] });
await fixture('ctf-grab-throw-capture', [player(500, { team: 1 })], [input(1, 1, 900, { MouseAimX: -600, MouseAimY: -30 }), input(1, 70, 5, { FlagThrow: true, MouseAimX: -600, MouseAimY: -30 }), input(1, 100, 500, { Left: true, MouseAimX: -600, MouseAimY: -30 })], [thing(0, 1, -600), thing(0, 2, 500)], { mode: 'ctf', ticks: 900, required: [{ kind: 'flag-held', style: 2 }, { kind: 'flag-released', style: 2 }] });
await fixture('ctf-capture-own-base', [player(-580, { team: 1, heldFlag: 2 })], [input(1, 1, 30, { Left: true })], [thing(0, 1, -600)], { mode: 'ctf', required: [{ kind: 'capture' }] });
await fixture('ctf-touch-return', [player(-500, { team: 1 }), player(-520, { team: 2, heldFlag: 1 })], [input(2, 1, 1, { FlagThrow: true, MouseAimX: -500, MouseAimY: -30 }), input(1, 30, 30, { Left: true })], [], { mode: 'ctf', required: [{ kind: 'flag-return', style: 1 }], limitations: ['Touch-return requires the flag first leave base; inspect inBase transition and base coordinates rather than the fixture name.'] });
await fixture('ctf-timeout-return', [player(0, { team: 1, heldFlag: 2 })], [input(1, 61, 1, { FlagThrow: true, MouseAimX: 300, MouseAimY: -100 }), input(1, 62, 180, { Left: true })], [thing(0, 1, -600)], { mode: 'ctf', ticks: 1800, required: [{ kind: 'flag-return', style: 2 }] });
await fixture('long-combat-10000', [player(-300, { weapon: 5 }), player(300, { weapon: 1, health: 10000 })], [input(1, 61, 9900, { Fire: true, MouseAimX: 300, MouseAimY: -22 }), input(2, 61, 9900, { Fire: true, MouseAimX: -300, MouseAimY: -22 })], [], { ticks: 10000, required: [{ kind: 'bullet-style', style: 3 }] });
// FireMode=2 is source-defined for exactly these original weapon numbers.
// Windows exceed even Barrett's startup/cooldown but avoid empty-clip reloads.
for (const weapon of [1, 5, 6, 8, 0]) await fixture(`semiauto-${weapon}-hold-release`, [player(-300, { weapon })], [
  input(1, 241, 300, { Fire: true, MouseAimX: 900, MouseAimY: -200 }),
  input(1, 601, 300, { Fire: true, MouseAimX: 900, MouseAimY: -200 }),
], [], { ticks: 1000, required: [
  { kind: 'shot-count', slot: 1, weapon, start: 241, end: 540, count: 1 },
  { kind: 'shot-count', slot: 1, weapon, start: 601, end: 900, count: 1 },
] });
await fixture('respawn-retains-chosen-weapons', [player(0, { weapon: 3, secondaryWeapon: 13, health: 10 }), player(-300)], [], [
  { tick: 240, kind: 'weapon-choice', slot: 1, weapon: 6, secondaryWeapon: 11 },
  bullet(241, { weapon: 8, owner: 2, target: 1, hitCircle: 12, x: -15, y: 0, vx: 30, vy: 0, hitMultiply: 100 }),
], { ticks: 1200, required: [{ kind: 'respawn-weapon', slot: 1, weapon: 6, secondaryWeapon: 11 }] });
await writeFile(`${directory}/corpus.json`, `${JSON.stringify({ version: 1, upstream: 'bf43a43bdd7a069e02c906768807f66e621b2888', base: '5b6e5bef23f5c0d58fb1d4d887b9b94ebcf799b4', fixtures: names, evidenceStatus: 'authored-not-captured', policy: 'T1 original only; T2/T3 original and keyed; required observations are measured by capture, never inferred from names.' }, null, 2)}\n`);
