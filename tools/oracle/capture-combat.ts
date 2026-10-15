import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { parseCombatFixture, parseCombatTraceRow, type CombatFixture, type CollisionObservation } from './combat-evidence.ts';
import type { SimManifest } from '../../packages/sim-host/src/sim.ts';

interface CaptureEvidence { fixture: string; status: string; [key: string]: unknown }

const root = process.cwd(), directory = 'tests/fixtures/combat', output = 'build-out/combat-oracle';
const imageName = process.env.ORACLE_IMAGE ?? 'soldat-web/fpc:bcd7288';
const platform = process.env.ORACLE_PLATFORM ?? 'linux/arm64';
async function execute(command: string, args: string[]) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(command, args, { cwd: root }), out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => done({ code: code ?? -1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function summarize(path: string, fixture: CombatFixture) {
  const styles = new Set<number>(), things = new Set<number>();
  const sprites = new Map<number, { initialHealth: number; minHealth: number; maxHealth: number; maxVest: number; maxGrenades: number; bonusStyles: Set<number>; weapons: Set<number>; grenadeWeapons: Set<number>; postures: Set<number>; minX: number; maxX: number; maxSpeedAfter: number }>();
  const held = new Set<number>(), released = new Set<number>(), returned = new Set<number>();
  const flagState = new Map<number, { held: boolean; away: boolean }>();
  const firstBulletStyle: Record<number, number> = {}, grenadeTicks = new Set<number>();
  const removals: number[] = [], bulletIds = new Set<number>();
  const hitCircles = new Set<string>();
  const previousSprites = new Map<number, { dead: boolean; weapon: number; ammo: number }>();
  const shots: { tick: number; slot: number; weapon: number; ammoSpent: number }[] = [];
  const respawns: { tick: number; slot: number; weapon: number; secondaryWeapon: number }[] = [];
  const collisions: (CollisionObservation & { tick: number })[] = [];
  let injectedFrame: number | null = null, releasedAt61 = false;
  let records = 0, finalTick = -1, maxDecay = 0, maxRicochet = 0, reload = false, capture = false;
  const samples: unknown[] = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    records++; const row = parseCombatTraceRow(line);
    if (!row) continue;
    for (const hit of row.combatHits) hitCircles.add(`${hit.target}:${hit.where}`);
    if (row.tick === 60 && row.stage === 'tick') injectedFrame = row.sprites.find(sprite => sprite.id === 1)?.body.frame ?? null;
    if (row.tick === 61 && row.bullets.some(bullet => bullet.style === 2)) releasedAt61 = true;
    for (const bullet of row.bullets) {
      styles.add(bullet.style); firstBulletStyle[bullet.style] ??= row.tick;
      maxDecay = Math.max(maxDecay, bullet.degradeCount); maxRicochet = Math.max(maxRicochet, bullet.ricochetCount);
      if (bullet.style === 2) grenadeTicks.add(row.tick);
    }
    for (const item of row.things) {
      things.add(item.style);
      if (item.style > 3) continue;
      const prior = flagState.get(item.style) ?? { held: false, away: false };
      if (item.holdingSprite > 0) { held.add(item.style); prior.held = true; }
      else if (prior.held) released.add(item.style);
      if (prior.away && item.inBase && item.holdingSprite === 0) returned.add(item.style);
      if (!item.inBase) prior.away = true;
      flagState.set(item.style, prior);
    }
    if (row.teamScores.some(score => score > 0) && fixture.rules.mode === 'ctf') capture = true;
    for (const sprite of row.sprites) {
      const x = sprite.particle.pos[0].decimal, speed = Math.hypot(...sprite.particle.velocity.map(v => v.decimal));
      const prior = sprites.get(sprite.id) ?? { initialHealth: sprite.health.decimal, minHealth: sprite.health.decimal, maxHealth: sprite.health.decimal, maxVest: 0, maxGrenades: 0, bonusStyles: new Set<number>(), weapons: new Set<number>(), grenadeWeapons: new Set<number>(), postures: new Set<number>(), minX: x, maxX: x, maxSpeedAfter: 0 };
      prior.minHealth = Math.min(prior.minHealth, sprite.health.decimal); prior.postures.add(sprite.position);
      prior.maxHealth = Math.max(prior.maxHealth, sprite.health.decimal); prior.maxVest = Math.max(prior.maxVest, sprite.vest.decimal);
      prior.maxGrenades = Math.max(prior.maxGrenades, sprite.tertiaryWeapon.ammo);
      prior.bonusStyles.add(sprite.bonusStyle); prior.weapons.add(sprite.weapon.num); prior.grenadeWeapons.add(sprite.tertiaryWeapon.num);
      prior.minX = Math.min(prior.minX, x); prior.maxX = Math.max(prior.maxX, x);
      if (row.tick > 60) prior.maxSpeedAfter = Math.max(prior.maxSpeedAfter, speed);
      if (sprite.weapon.reload > 0 && sprite.weapon.reload < 500) reload = true;
      sprites.set(sprite.id, prior);
    }
    if (!['initial', 'tick'].includes(row.stage)) continue;
    for (const collision of row.combatCollisions) collisions.push({ tick: row.tick, ...collision });
    for (const sprite of row.sprites) {
      const prior = previousSprites.get(sprite.id);
      if (prior?.dead && !sprite.dead) respawns.push({ tick: row.tick, slot: sprite.id, weapon: sprite.weapon.num, secondaryWeapon: sprite.secondaryWeapon.num });
      if (prior && !prior.dead && !sprite.dead && prior.weapon === sprite.weapon.num && sprite.weapon.ammo < prior.ammo) shots.push({ tick: row.tick, slot: sprite.id, weapon: sprite.weapon.num, ammoSpent: prior.ammo - sprite.weapon.ammo });
      previousSprites.set(sprite.id, { dead: sprite.dead, weapon: sprite.weapon.num, ammo: sprite.weapon.ammo });
    }
    finalTick = row.tick;
    const nextIds = new Set<number>(row.bullets.map(bullet => bullet.id));
    if ([...bulletIds].some(id => !nextIds.has(id))) removals.push(row.tick);
    bulletIds.clear(); for (const id of nextIds) bulletIds.add(id);
    if (row.tick >= 60 && row.tick <= 65) samples.push({ tick: row.tick, sprites: row.sprites.map(s => ({ id: s.id, body: s.body, health: s.health, weapon: s.weapon, tertiary: s.tertiaryWeapon })), bullets: row.bullets });
  }
  const observations = fixture.metadata.requiredObservations.map(predicate => {
    const sprite = 'slot' in predicate ? sprites.get(predicate.slot) : undefined; let observed = false;
    switch (predicate.kind) {
      case 'health-loss': observed = !!sprite && sprite.minHealth < sprite.initialHealth; break;
      case 'hit-circle': observed = hitCircles.has(`${predicate.slot}:${predicate.circle}`); break;
      case 'grenade-release': observed = injectedFrame === predicate.frame && releasedAt61 === predicate.emitted; break;
      case 'shot-count': observed = shots.filter(shot => shot.slot === predicate.slot && shot.weapon === predicate.weapon && shot.tick >= predicate.start && shot.tick <= predicate.end).length === predicate.count; break;
      case 'respawn-weapon': observed = respawns.some(respawn => respawn.slot === predicate.slot && respawn.weapon === predicate.weapon && respawn.secondaryWeapon === predicate.secondaryWeapon); break;
      case 'collision-winner':
      case 'collision-accepted':
      case 'collision-rejected':
        observed = collisions.some(collision => collision.tick >= predicate.start && collision.tick <= predicate.end && collision.kind === predicate.collisionKind && (predicate.kind === 'collision-winner' ? collision.winner : predicate.kind === 'collision-accepted' ? collision.accepted : !collision.accepted));
        break;
      case 'pickup': observed = !!sprite && (predicate.style === 16 ? sprite.maxHealth > sprite.initialHealth : predicate.style === 17 ? sprite.maxGrenades > 0 : predicate.style === 18 ? sprite.weapons.has(14) && sprite.bonusStyles.has(18) : predicate.style === 19 ? sprite.bonusStyles.has(19) : predicate.style === 20 ? sprite.maxVest > 0 : predicate.style === 21 ? sprite.bonusStyles.has(21) : predicate.style === 22 ? sprite.grenadeWeapons.has(51) && sprite.maxGrenades > 0 : false); break;
      case 'posture': observed = !!sprite && (predicate.posture === 'moving' ? sprite.maxX - sprite.minX > 20 : sprite.postures.has(({ standing: 1, crouch: 2, prone: 4 } as Record<string, number>)[predicate.posture]!)); break;
      case 'bullet-style': observed = styles.has(predicate.style); break;
      case 'thing-style': observed = things.has(predicate.style); break;
      case 'ricochet': observed = maxRicochet > 0; break;
      case 'decay': observed = maxDecay >= predicate.count; break;
      case 'reload': observed = reload; break;
      case 'bullet-disappeared': observed = removals.some(tick => tick > predicate.after); break;
      case 'no-grenade-window': observed = ![...grenadeTicks].some(tick => tick >= predicate.start && tick <= predicate.end); break;
      case 'self-boost': observed = !!sprite && sprite.maxSpeedAfter > 1 && sprite.minHealth < sprite.initialHealth; break;
      case 'flag-held': observed = held.has(predicate.style); break;
      case 'flag-released': observed = released.has(predicate.style); break;
      case 'flag-return': observed = returned.has(predicate.style); break;
      case 'capture': observed = capture; break;
      default: throw new Error(`Unknown observation predicate ${predicate.kind}`);
    }
    return { ...predicate, observed };
  });
  return { records, finalTick, styles: [...styles], things: [...things], hitCircles: [...hitCircles], firstBulletStyle, maxDecay, maxRicochet, collisions, collisionWinnerMeaning: 'Last distance-accepted response for that bullet in the original dispatch order. Earlier accepted responses may already have effects; rejected candidates include measured distance/priorLimit.', shots, shotMeasurement: 'One live, same-weapon per-tick ammunition decrement is one firing action in no-reload hold/release fixtures; this is not a projectile count.', respawns, sprites: [...sprites].map(([id, value]) => ({ id, ...value, postures: [...value.postures], bonusStyles: [...value.bonusStyles], weapons: [...value.weapons], grenadeWeapons: [...value.grenadeWeapons] })), observations, allRequiredObserved: observations.every(p => p.observed), limitations: fixture.metadata.limitations, coverageStatus: 'Only explicitly measured predicates are evidence; limitations remain open.', releaseSamples: samples };
}
const imageResult = await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', imageName]);
if (imageResult.code !== 0) throw new Error(`Pinned image unavailable: ${imageResult.stderr}`);
const image = imageResult.stdout.trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Docker did not return a content-addressed image ID');
// The authoring tool owns the index; reject anything other than its filename list.
const corpus = JSON.parse(await readFile(`${directory}/corpus.json`, 'utf8')) as { fixtures: string[] };
if (!Array.isArray(corpus.fixtures) || !corpus.fixtures.every(name => typeof name === 'string' && /^[a-z0-9-]+[.]fixture[.]json$/.test(name))) throw new Error('Malformed combat index');
const prefixes = process.argv.slice(2);
const names: string[] = corpus.fixtures.filter((name: string) => !prefixes.length || prefixes.some(prefix => name.startsWith(prefix)));
if (!names.length) throw new Error('No matching combat fixtures');
await mkdir(`${directory}/golden`, { recursive: true });
await mkdir(`${output}/tmp`, { recursive: true }); await mkdir(`${output}/home`, { recursive: true });
const oracleBinarySha256 = await hashFile('build-out/oracle/cmake/bin/opensoldatserver');
const harnessSha256 = await hashFile('build-out/oracle/source/server/OracleHarness.pas');
const sharedTraceSha256 = await hashFile('build-out/oracle/source/server/OracleTrace.inc');
if (harnessSha256 !== await hashFile('tools/oracle/OracleHarness.pas') || sharedTraceSha256 !== await hashFile('tools/oracle/OracleTrace.inc')) throw new Error('Oracle build is stale; rebuild it before capturing');
const sourcePatchSha256 = await hashFile('tools/oracle/patches/0001-oracle-entry-and-stage-hooks.patch');
const diagnosticsSha256 = await hashFile('sim/opensoldat/sim/CombatDiagnostics.pas');
if (diagnosticsSha256 !== await hashFile('build-out/oracle/source/server/CombatDiagnostics.pas')) throw new Error('Oracle diagnostic build is stale');
// Content identity uses exactly the manifest's sorted ID/hash convention.
const manifest = JSON.parse(await readFile('dist/content/sim/manifest.json', 'utf8')) as SimManifest;
const captures = new Map<string, CaptureEvidence>();
try {
  // Previous evidence is produced exclusively by this capture tool.
  const previous = JSON.parse(await readFile(`${directory}/capture-results.json`, 'utf8')) as { captures: CaptureEvidence[] };
  for (const item of previous.captures) {
    if (typeof item.fixture !== 'string' || typeof item.status !== 'string') throw new Error('Malformed prior capture');
    captures.set(item.fixture, item);
  }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
let failed = false;
for (const name of names) {
  const fixturePath = `${directory}/${name}`, fixture = parseCombatFixture(await readFile(fixturePath, 'utf8'));
  if (fixture.ticks < 300 || fixture.rules.rng !== 'original') throw new Error(`Invalid combat fixture ${name}`);
  if (await hashFile(fixture.mapPath) !== fixture.mapSha256) throw new Error(`Map digest mismatch: ${name}`);
  const mapId = `maps/${fixture.mapPath.split('/').at(-1)!}`;
  const files = { ...manifest.files, [mapId]: { sha256: fixture.mapSha256 } };
  const contentIdentity = Object.keys(files).sort().map(id => `${id}\t${files[id]!.sha256}\n`).join('');
  if (createHash('sha256').update(contentIdentity).digest('hex') !== fixture.contentSetHash) throw new Error(`Content-set mismatch: ${name}`);
  const basename = name.replace(/\.fixture\.json$/, ''), raw = `${output}/${basename}.jsonl`, gzip = `${directory}/golden/${basename}.jsonl.gz`;
  const args = ['run', '--rm', '--network', 'none', '--read-only', '--platform', platform,
    '-v', `${root}/build-out/oracle:/work:ro`, '-v', `${resolve(fixturePath)}:/fixture.json:ro`,
    '-v', `${root}/${directory}:/fixture-maps:ro`, '-v', `${root}/${output}:/output`,
    '-w', '/output/home', '-e', 'LD_LIBRARY_PATH=/work/cmake/bin', '-e', 'TMPDIR=/output/tmp', '-e', 'HOME=/output/home', image,
    '/work/cmake/bin/opensoldatserver', '/fixture.json', `/output/${basename}.jsonl`, '/work/base/soldat.smod', '/work/runtime'];
  const result = await execute('docker', args);
  const identity = { fixture: name, fixtureSha256: await hashFile(fixturePath), mapSha256: fixture.mapSha256, contentSetHash: fixture.contentSetHash, oracleBinarySha256, harnessSha256, sharedTraceSha256, diagnosticsSha256, sourcePatchSha256, image, platform, command: ['docker', ...args], exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  if (result.code !== 0) { captures.set(name, { ...identity, status: 'capture-failed' }); failed = true; }
  else {
    const summary = await summarize(raw, fixture);
    if (summary.finalTick !== fixture.ticks) throw new Error(`Truncated oracle trace: ${name}`);
    const sha256 = await hashFile(raw), bytes = (await stat(raw)).size;
    await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(gzip));
    const compressedSha256 = await hashFile(gzip), compressedBytes = (await stat(gzip)).size;
    // Repeat every fixture, not just one seed, before claiming reproducibility.
    const repeat = await execute('docker', args);
    const repeatSha256 = repeat.code === 0 ? await hashFile(raw) : null;
    const reproducible = repeat.code === 0 && repeatSha256 === sha256;
    captures.set(name, { ...identity, golden: `golden/${basename}.jsonl.gz`, sha256, bytes, compressedSha256, compressedBytes, summary, repeat: { ...repeat, sha256: repeatSha256, byteIdentical: reproducible }, status: !reproducible ? 'repeat-diverged' : !summary.allRequiredObserved ? 'observations-missing' : summary.limitations.length ? 'captured-with-limitations' : 'captured' });
    failed ||= !reproducible || !summary.allRequiredObserved;
    await unlink(raw);
  }
  await writeFile(`${directory}/capture-results.json`, `${JSON.stringify({ version: 1, tier: 'oracle-evidence', image, platform, rng: 'original', network: 'none', captures: [...captures.values()].sort((a, b) => a.fixture.localeCompare(b.fixture)) }, null, 2)}\n`);
  console.log(JSON.stringify({ fixture: name, status: captures.get(name)!.status }));
}
if (failed) process.exitCode = 1;
