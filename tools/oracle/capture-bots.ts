import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { parseCombatTraceRow, type CombatTraceRow } from './combat-evidence.ts';
import type { Fixture } from '../../packages/sim-host/src/fixture.ts';
import type { SimManifest } from '../../packages/sim-host/src/sim.ts';
import { stringifyReceipt } from '../../scripts/receipt-paths.mjs';

// Uses the existing run.sh Docker isolation/binds and combat JSONL validation.
// A generated corpus is not evidence: only attempted runs write capture-results.
const root = process.cwd(), directory = 'tests/fixtures/bots', output = 'build-out/sim/bots/oracle';
const platform = process.env.ORACLE_PLATFORM ?? 'linux/arm64';
const imageName = process.env.ORACLE_IMAGE ?? 'soldat-web/fpc:bcd7288';
interface CaptureEvidence { fixture: string; status: string; [key: string]: unknown }
interface BotFixture extends Fixture {
  mapSha256: string;
  traceStages: 'tick';
  botDirectory: '/sim-content/bots';
  rules: { mode: 'dm' | 'ctf'; world: 'original' | 'fixture'; ai: true; rng: 'original'; botDifficulty: number; traceCombat: true; stationaryGuns?: boolean };
  capturePickups?: boolean;
  metadata: { profileSha256: Record<string, string>; requiredObservations: string[]; limitations: string[]; originalStartup?: { medikits: number; grenadeKits: number; flagStyles: number[]; stationaryGuns: number } };
}
interface BotState {
  name: string; accuracy: number; target: number; path: number; waypoint: number; nextWaypoint: number; favWeapon: number;
  left: boolean; right: boolean; up: boolean; down: boolean; fire: boolean; jetpack: boolean; throwNade: boolean; aimX: number; aimY: number;
}
interface PickupEvidence { tick: number; thing: number; slot: number; style: number; healthBefore: number; grenadesBefore: number }
async function readPickups(path: string, fixture: BotFixture): Promise<PickupEvidence[]> {
  if (!fixture.capturePickups) return [];
  const pickups: PickupEvidence[] = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    const pickup = JSON.parse(line) as PickupEvidence;
    if (!pickup || !['tick', 'thing', 'slot', 'style', 'grenadesBefore'].every(key => Number.isInteger(Reflect.get(pickup, key))) || !Number.isFinite(pickup.healthBefore) || pickup.tick < 1 || pickup.tick > fixture.ticks || pickup.thing < 1 || pickup.style < 16 || pickup.style > 22 || fixture.players[pickup.slot - 1]?.control !== 'bot' || pickup.tick < (pickups.at(-1)?.tick ?? 0)) throw new Error('Malformed bot kit pickup send-site evidence');
    pickups.push(pickup);
  }
  return pickups;
}
async function execute(command: string, args: string[], image?: string) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...(image ? { ORACLE_IMAGE: image } : {}), ORACLE_PLATFORM: platform } });
    const out: Buffer[] = [], err: Buffer[] = [];
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
async function summarize(path: string, fixture: BotFixture, pickups: PickupEvidence[]) {
  const botSlots = fixture.players.flatMap((player, i) => player.control === 'bot' ? [i + 1] : []);
  const bots = new Map<number, { name: string; accuracy: number; samples: number; initialX: number; initialY: number; maxDisplacement: number; waypoints: Set<number>; targets: Set<number>; controlTicks: number; fireTicks: number; jetTicks: number; grenadeTicks: number; healthLossTicks: number; deaths: number; respawns: number; ammunitionDecrements: number; heldThingTicks: number; dead: boolean; health: number; weapon: number; ammo: number }>();
  let finalTick = -1, records = 0, headerSeen = false, hitRecords = 0;
  const teamScores = [0, 0, 0, 0], bulletStyles = new Set<number>(), flagStyles = new Set<number>();
  const initialThings = new Map<number, number>();
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    const row = parseCombatTraceRow(line);
    if (!row) {
      const header = JSON.parse(line) as { map: string; contentSetHash: string; seed: number; ticks: number };
      if (headerSeen || records || header.map !== fixture.map || header.contentSetHash !== fixture.contentSetHash || header.seed !== fixture.seed || header.ticks !== fixture.ticks) throw new Error('Oracle trace header does not match fixture');
      headerSeen = true; continue;
    }
    if (!headerSeen || row.tick !== finalTick + 1 || row.stage !== (row.tick === 0 ? 'initial' : 'tick')) throw new Error(`Unexpected bot trace ordering at tick ${row.tick}`);
    finalTick = row.tick; records++;
    if (row.sprites.length !== fixture.players.length) throw new Error('Oracle player roster changed');
    hitRecords += row.combatHits.length;
    if (row.tick === 0) for (const thing of row.things) initialThings.set(thing.style, (initialThings.get(thing.style) ?? 0) + 1);
    row.teamScores.forEach((score, i) => { teamScores[i] = Math.max(teamScores[i] ?? 0, score); });
    for (const bullet of row.bullets) bulletStyles.add(bullet.style);
    for (const thing of row.things) if (thing.style >= 1 && thing.style <= 3) flagStyles.add(thing.style);
    for (const slot of botSlots) {
      const sprite = row.sprites.find(sprite => sprite.id === slot) as (CombatTraceRow['sprites'][number] & { bot?: BotState; heldThing: number }) | undefined;
      if (!sprite?.bot) throw new Error(`Missing original bot trace for slot ${slot}`);
      const b = sprite.bot;
      if (typeof b.name !== 'string' || !['accuracy', 'target', 'path', 'waypoint', 'nextWaypoint', 'favWeapon', 'aimX', 'aimY'].every(key => Number.isInteger(Reflect.get(b, key))) || !['left', 'right', 'up', 'down', 'fire', 'jetpack', 'throwNade'].every(key => typeof Reflect.get(b, key) === 'boolean')) throw new Error('Malformed original bot diagnostic');
      const x = sprite.particle.pos[0].decimal, y = sprite.particle.pos[1].decimal;
      const prior = bots.get(slot) ?? { name: b.name, accuracy: b.accuracy, samples: 0, initialX: x, initialY: y, maxDisplacement: 0, waypoints: new Set<number>(), targets: new Set<number>(), controlTicks: 0, fireTicks: 0, jetTicks: 0, grenadeTicks: 0, healthLossTicks: 0, deaths: 0, respawns: 0, ammunitionDecrements: 0, heldThingTicks: 0, dead: sprite.dead, health: sprite.health.decimal, weapon: sprite.weapon.num, ammo: sprite.weapon.ammo };
      prior.samples++;
      prior.maxDisplacement = Math.max(prior.maxDisplacement, Math.hypot(x - prior.initialX, y - prior.initialY));
      if (b.waypoint > 0) prior.waypoints.add(b.waypoint);
      if (b.target > 0 && b.target !== slot) prior.targets.add(b.target);
      if (b.left || b.right || b.up || b.down || b.fire || b.jetpack || b.throwNade) prior.controlTicks++;
      if (b.fire) prior.fireTicks++;
      if (b.jetpack) prior.jetTicks++;
      if (b.throwNade) prior.grenadeTicks++;
      if (sprite.health.decimal < prior.health) prior.healthLossTicks++;
      if (!prior.dead && sprite.dead) prior.deaths++;
      if (prior.dead && !sprite.dead) prior.respawns++;
      if (!prior.dead && !sprite.dead && prior.weapon === sprite.weapon.num && sprite.weapon.ammo < prior.ammo) prior.ammunitionDecrements += prior.ammo - sprite.weapon.ammo;
      if (sprite.heldThing > 0) prior.heldThingTicks++;
      prior.dead = sprite.dead; prior.health = sprite.health.decimal; prior.weapon = sprite.weapon.num; prior.ammo = sprite.weapon.ammo;
      bots.set(slot, prior);
    }
  }
  const observations: Record<string, boolean> = {
    'complete-ticks': headerSeen && finalTick === fixture.ticks && records === fixture.ticks + 1,
    'bot-roster': bots.size === botSlots.length && [...bots.values()].every(bot => bot.samples === fixture.ticks + 1),
    'bot-movement': [...bots.values()].some(bot => bot.maxDisplacement > 20),
    'bot-waypoint': [...bots.values()].some(bot => bot.waypoints.size > 0),
    'bot-controls': [...bots.values()].some(bot => bot.controlTicks > 0),
    'original-world-kits': fixture.rules.world === 'original' && !!fixture.metadata.originalStartup && (initialThings.get(16) ?? 0) === fixture.metadata.originalStartup.medikits && (initialThings.get(17) ?? 0) === fixture.metadata.originalStartup.grenadeKits,
    'original-world-flags': fixture.rules.world === 'original' && !!fixture.metadata.originalStartup && [1, 2, 3].every(style => (initialThings.get(style) ?? 0) === (fixture.metadata.originalStartup!.flagStyles.includes(style) ? 1 : 0)),
    'original-world-stationary-guns': fixture.rules.world === 'original' && !!fixture.metadata.originalStartup && (initialThings.get(27) ?? 0) === fixture.metadata.originalStartup.stationaryGuns,
    'bot-kit-pickup': pickups.length > 0,
  };
  const required = fixture.metadata.requiredObservations.map(kind => {
    if (!(kind in observations)) throw new Error(`Unknown bot observation: ${kind}`);
    return { kind, observed: observations[kind] };
  });
  return {
    records, finalTick, required, allRequiredObserved: required.every(item => item.observed),
    bots: [...bots].map(([slot, { waypoints, targets, ...stats }]) => ({ slot, ...stats, waypoints: [...waypoints].sort((a, b) => a - b), targets: [...targets].sort((a, b) => a - b) })),
    teamScores, hitRecords, bulletStyles: [...bulletStyles].sort((a, b) => a - b), flagStyles: [...flagStyles].sort(),
    initialThings: Object.fromEntries([...initialThings].sort(([a], [b]) => a - b)), pickups,
    measurement: 'Tick snapshots measure startup Things and state transitions. Kit pickups are exact original ServerThingTaken callbacks in a separate oracle-only sidecar, never inferred from health/ammo deltas. Ammunition decrements are not hit/shot proof; heldThing is not a scored capture.',
    limitations: fixture.metadata.limitations,
  };
}
const imageResult = await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', imageName]);
if (imageResult.code !== 0) throw new Error(`Pinned image unavailable: ${imageResult.stderr}`);
const image = imageResult.stdout.trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Docker did not return a content-addressed image ID');
const manifest = JSON.parse(await readFile('dist/content/sim/manifest.json', 'utf8')) as SimManifest;
const identity = Object.keys(manifest.files).sort().map(id => `${id}\t${manifest.files[id]!.sha256}\n`).join('');
if (createHash('sha256').update(identity).digest('hex') !== manifest.sha256) throw new Error('Malformed simulation manifest identity');
const corpus = JSON.parse(await readFile(`${directory}/corpus.json`, 'utf8')) as { contentSetHash: string; fixtures: string[] };
if (corpus.contentSetHash !== manifest.sha256 || !Array.isArray(corpus.fixtures) || !corpus.fixtures.every(name => /^[a-z0-9-]+[.]fixture[.]json$/.test(name))) throw new Error('Stale/malformed bot corpus; regenerate it');
const prefixes = process.argv.slice(2), names = corpus.fixtures.filter(name => !prefixes.length || prefixes.some(prefix => name.startsWith(prefix)));
if (!names.length) throw new Error('No matching bot fixtures');
// Fail before run.sh can auto-build: all heavy work is an explicit coordinator action.
const oracleBinarySha256 = await hashFile('build-out/oracle/cmake/bin/opensoldatserver');
const harnessSha256 = await hashFile('tools/oracle/OracleHarness.pas'), sharedTraceSha256 = await hashFile('tools/oracle/OracleTrace.inc');
const diagnosticsSha256 = await hashFile('sim/opensoldat/sim/CombatDiagnostics.pas');
if (harnessSha256 !== await hashFile('build-out/oracle/source/server/OracleHarness.pas') || sharedTraceSha256 !== await hashFile('build-out/oracle/source/server/OracleTrace.inc') || diagnosticsSha256 !== await hashFile('build-out/oracle/source/server/CombatDiagnostics.pas')) throw new Error('Oracle build is stale; rebuild before capturing');
const sourcePatchSha256 = await hashFile('tools/oracle/patches/0001-oracle-entry-and-stage-hooks.patch');
const runnerSha256 = await hashFile('tools/oracle/run.sh'), baseSmodSha256 = await hashFile('build-out/oracle/base/soldat.smod');
const captures = new Map<string, CaptureEvidence>();
try {
  const previous = JSON.parse(await readFile(`${directory}/capture-results.json`, 'utf8')) as { captures: CaptureEvidence[] };
  for (const capture of previous.captures) {
    if (typeof capture.fixture !== 'string' || typeof capture.status !== 'string') throw new Error('Malformed previous bot capture');
    captures.set(capture.fixture, capture);
  }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true }); await mkdir(`${directory}/golden`, { recursive: true });
let failed = false;
for (const name of names) {
  const fixturePath = `${directory}/${name}`, fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as BotFixture;
  if (fixture.version !== 1 || fixture.ticks < 1000 || fixture.contentSetHash !== manifest.sha256 || fixture.rules?.ai !== true || fixture.rules.rng !== 'original' || !Number.isInteger(fixture.rules.botDifficulty) || fixture.rules.botDifficulty < 0 || fixture.rules.botDifficulty > 300 || fixture.rules.traceCombat !== true || fixture.traceStages !== 'tick' || fixture.botDirectory !== '/sim-content/bots') throw new Error(`Malformed/stale bot fixture: ${name}`);
  if (!['original', 'fixture'].includes(fixture.rules.world) || (fixture.rules.world === 'original' && (fixture.capturePickups !== true || !fixture.metadata.originalStartup)) || (fixture.rules.world === 'fixture' && fixture.capturePickups)) throw new Error(`Malformed bot world contract: ${name}`);
  const map = manifest.files[`maps/${fixture.map.toLowerCase()}.pms`];
  if (!map || map.sha256 !== fixture.mapSha256 || await hashFile(`dist/content/${map.path}`) !== map.sha256) throw new Error(`Map identity mismatch: ${name}`);
  for (const player of fixture.players) if (player.control === 'bot') {
    const id = `bots/${player.bot?.toLowerCase()}.bot`, entry = manifest.files[id];
    if (!entry || fixture.metadata.profileSha256[id] !== entry.sha256 || await hashFile(`dist/content/${entry.path}`) !== entry.sha256) throw new Error(`Bot profile identity mismatch: ${id}`);
  }
  if (!fixture.players.some(player => player.control === 'bot') || fixture.inputs.some(input => fixture.players[input.player - 1]?.control === 'bot')) throw new Error('Bot fixture must not inject bot controls');
  const basename = name.replace(/\.fixture\.json$/, ''), raw = `${output}/${basename}.jsonl`, golden = `${directory}/golden/${basename}.jsonl.gz`;
  const args = [resolve(fixturePath), resolve(raw)];
  const identity = { fixture: name, fixtureSha256: await hashFile(fixturePath), contentSetHash: fixture.contentSetHash, mapSha256: fixture.mapSha256, profileSha256: fixture.metadata.profileSha256, seed: fixture.seed, botDifficulty: fixture.rules.botDifficulty, chat: false, oracleBinarySha256, harnessSha256, sharedTraceSha256, diagnosticsSha256, sourcePatchSha256, runnerSha256, baseSmodSha256, image, platform, command: ['tools/oracle/run.sh', ...args], env: { ORACLE_IMAGE: image, ORACLE_PLATFORM: platform }, mounts: { work: `${root}/build-out/oracle:/work:ro`, profiles: `${root}/dist/content/sim:/sim-content:ro`, fixture: `${args[0]}:/fixture.json:ro`, maps: `${resolve(directory)}:/fixture-maps:ro`, output: `${resolve(output)}:/output` } };
  const pickupRaw = `${raw}.pickups.jsonl`, pickupGolden = `${directory}/golden/${basename}.pickups.jsonl`;
  Object.assign(identity, { world: fixture.rules.world, stationaryGuns: fixture.rules.stationaryGuns ?? false, capturePickups: fixture.capturePickups ?? false });
  try {
    const result = await execute('tools/oracle/run.sh', args, image);
    if (result.code !== 0) { captures.set(name, { ...identity, ...result, status: 'capture-failed' }); failed = true; }
    else {
      const pickups = await readPickups(pickupRaw, fixture);
      const summary = await summarize(raw, fixture, pickups);
      const pickupEvidence = fixture.capturePickups ? { golden: `golden/${basename}.pickups.jsonl`, sha256: await hashFile(pickupRaw), bytes: (await stat(pickupRaw)).size } : null;
      if (pickupEvidence) await writeFile(pickupGolden, await readFile(pickupRaw));
      const sha256 = await hashFile(raw), bytes = (await stat(raw)).size;
      await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(golden));
      const compressedSha256 = await hashFile(golden), compressedBytes = (await stat(golden)).size;
      const repeat = await execute('tools/oracle/run.sh', args, image);
      const repeatSha256 = repeat.code === 0 ? await hashFile(raw) : null;
      const repeatPickupSha256 = fixture.capturePickups && repeat.code === 0 ? await hashFile(pickupRaw) : null;
      const byteIdentical = repeat.code === 0 && repeatSha256 === sha256 && (!pickupEvidence || repeatPickupSha256 === pickupEvidence.sha256);
      const status = !byteIdentical ? 'repeat-diverged' : !summary.allRequiredObserved ? 'observations-missing' : 'captured-with-limitations';
      captures.set(name, { ...identity, ...result, status, golden: `golden/${basename}.jsonl.gz`, sha256, bytes, compressedSha256, compressedBytes, summary, pickups: pickupEvidence, repeat: { ...repeat, sha256: repeatSha256, pickupSha256: repeatPickupSha256, byteIdentical } });
      failed ||= !byteIdentical || !summary.allRequiredObserved;
      await unlink(raw);
    }
  } catch (error) {
    captures.set(name, { ...identity, status: 'capture-error', error: error instanceof Error ? error.message : String(error) }); failed = true;
  } finally {
    if (fixture.capturePickups) await unlink(pickupRaw).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
  await writeFile(`${directory}/capture-results.json`, `${stringifyReceipt({ version: 1, tier: 'bot-oracle-evidence', image, platform, rng: 'original', chat: false, network: 'none', captures: [...captures.values()].sort((a, b) => a.fixture.localeCompare(b.fixture)) })}\n`);
  console.log(JSON.stringify({ fixture: name, status: captures.get(name)!.status }));
}
if (failed) process.exitCode = 1;
