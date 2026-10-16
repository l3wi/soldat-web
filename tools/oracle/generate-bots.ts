import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parsePms } from '../../packages/content/src/readers.ts';
import type { Fixture } from '../../packages/sim-host/src/fixture.ts';
import type { SimManifest } from '../../packages/sim-host/src/sim.ts';

// Authoring only: reads pinned stock content, never runs the simulation or oracle.
const directory = 'tests/fixtures/bots';
const manifest = JSON.parse(await readFile('dist/content/sim/manifest.json', 'utf8')) as SimManifest;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity = Object.keys(manifest.files).sort().map(id => `${id}\t${manifest.files[id]!.sha256}\n`).join('');
if (hash(identity) !== manifest.sha256) throw new Error('Malformed simulation manifest identity');
const profiles = ['Billy', 'Commando', 'Dutch', 'John', 'Danko', 'Kruger', 'Poncho', 'Roach'];
const profileHashes: Record<string, string> = {};
for (const profile of profiles) {
  const id = `bots/${profile.toLowerCase()}.bot`, entry = manifest.files[id];
  if (!entry) throw new Error(`Missing original bot profile: ${id}`);
  const original = await readFile(`reference/base/server/configs/bots/${profile}.bot`);
  const mounted = await readFile(`dist/content/${entry.path}`);
  if (hash(original) !== entry.sha256 || hash(mounted) !== entry.sha256) throw new Error(`Bot identity mismatch: ${id}`);
  profileHashes[id] = entry.sha256;
}
await mkdir(directory, { recursive: true });
const names: string[] = [];
const maps: { name: string; sha256: string; activeWaypoints: number; connectedWaypoints: number }[] = [];
for (const name of ['Arena', 'ctf_Ash', 'ctf_Laos']) {
  const id = `maps/${name.toLowerCase()}.pms`, entry = manifest.files[id];
  if (!entry) throw new Error(`Missing stock map: ${id}`);
  const original = await readFile(`reference/base/shared/maps/${name}.pms`);
  const bytes = await readFile(`dist/content/${entry.path}`);
  if (hash(original) !== entry.sha256 || hash(bytes) !== entry.sha256) throw new Error(`Stock map identity mismatch: ${id}`);
  const map = parsePms(bytes);
  const activeWaypoints = map.waypoints.filter(w => w.active).length;
  const connectedWaypoints = map.waypoints.filter(w => w.active && w.connectionCount > 0).length;
  if (!connectedWaypoints) throw new Error(`Map has no connected bot waypoints: ${name}`);
  maps.push({ name, sha256: entry.sha256, activeWaypoints, connectedWaypoints });
  const spawn = (team: number) => {
    const preferred = map.spawnpoints.findIndex(s => s.active && s.team === team);
    const index = preferred < 0 ? map.spawnpoints.findIndex(s => s.active && s.team < 5) : preferred;
    if (index < 0) throw new Error(`No player spawn in ${name}`);
    return index + 1;
  };
  const bot = (profile: string, team: number): Fixture['players'][number] => ({ team, spawnpoint: spawn(team), control: 'bot', bot: profile });
  async function fixture(suffix: string, mode: 'dm' | 'ctf', players: Fixture['players'], inputs: Fixture['inputs'] = [], ticks = 1500, botDifficulty = 100) {
    const filename = `${name.toLowerCase().replaceAll('_', '-')}-${suffix}.fixture.json`;
    const record = {
      version: 1, map: name, mapSha256: entry!.sha256, contentSetHash: manifest.sha256,
      seed: 123456789, ticks, traceStages: 'tick', botDirectory: '/sim-content/bots',
      rules: { mode, rng: 'original', ai: true, botDifficulty, traceCombat: true },
      players, inputs,
      commands: suffix === 'human-and-bot' ? [
        { tick: 0, kind: 'weapon-apply', slot: 1, weapon: 3, secondaryWeapon: 11, selection: 'secondary' },
        { tick: 0, kind: 'weapon-apply', slot: 1, weapon: 2, selection: 'primary' },
      ] : [],
      metadata: {
        purpose: `${suffix}: original stock bot profiles and unmodified waypoint AI on ${name}`,
        source: 'reference/base/shared/maps + reference/base/server/configs/bots; hashes verified against mounted simulation manifest',
        botJoin: 'team shirt -> RandomizeStart -> CreateSprite -> original LoadBotConfig -> Respawn -> BOT; fixture spawnpoint/loadout ignored for bots',
        controls: 'Human/authoritative inputs only. Bot controls persist between ticks and are produced exclusively by original AI.',
        weaponMenu: suffix === 'human-and-bot' ? 'Initial authoritative human selects knife secondary (menu stays open), then MP5 primary (menu closes); original active/WeaponSel/alive/non-bow guards apply.' : 'Bots choose weapons through original profiles/AI, never injected menu commands.',
        chat: false, activeWaypoints, connectedWaypoints,
        profileSha256: Object.fromEntries(players.filter(p => p.control === 'bot').map(p => {
          const id = `bots/${p.bot!.toLowerCase()}.bot`; return [id, profileHashes[id]];
        })),
        requiredObservations: ['complete-ticks', 'bot-roster', 'bot-movement', 'bot-waypoint', 'bot-controls'],
        limitations: ['Authoring is not capture evidence. Combat, deaths, respawns, flag interactions and scores are reported only if observed; none are presumed.'],
      },
    };
    await writeFile(`${directory}/${filename}`, `${JSON.stringify(record, null, 2)}\n`);
    names.push(filename);
  }
  const mode = name === 'Arena' ? 'dm' : 'ctf';
  const humanTeam = mode === 'ctf' ? 1 : 0, enemyTeam = mode === 'ctf' ? 2 : 0;
  const human: Fixture['players'][number] = { team: humanTeam, spawnpoint: spawn(humanTeam), control: 'authoritative', weapon: 3, secondaryWeapon: 0 };
  const humanSpawn = map.spawnpoints[human.spawnpoint - 1]!;
  const aim = { MouseAimX: humanSpawn.x + 600, MouseAimY: humanSpawn.y - 20 };
  await fixture('human-and-bot', mode, [human, bot('Billy', enemyTeam)], [
    { player: 1, start: 61, ticks: 360, control: { Right: true, Fire: true, ...aim } },
    { player: 1, start: 421, ticks: 60, control: { Up: true, Right: true, Jetpack: true, ...aim } },
    { player: 1, start: 601, ticks: 360, control: { Left: true, Fire: true, MouseAimX: humanSpawn.x - 600, MouseAimY: humanSpawn.y - 20 } },
    { player: 1, start: 1101, ticks: 180, control: { Reload: true, ...aim } },
  ]);
  await fixture('four-bot-dm', 'dm', profiles.slice(0, 4).map(profile => bot(profile, 0)));
  if (mode === 'ctf') {
    for (const team of [1, 2, 5, 6]) if (!map.spawnpoints.some(s => s.active && s.team === team)) throw new Error(`Missing CTF spawn ${team} in ${name}`);
    await fixture('four-bot-ctf', 'ctf', profiles.slice(0, 4).map((profile, i) => bot(profile, i % 2 + 1)));
  } else {
    await fixture('four-bot-dm-difficulty-0', 'dm', profiles.slice(0, 4).map(profile => bot(profile, 0)), [], 1500, 0);
    await fixture('four-bot-dm-difficulty-300', 'dm', profiles.slice(0, 4).map(profile => bot(profile, 0)), [], 1500, 300);
    await fixture('eight-bot-dm-10000', 'dm', profiles.map(profile => bot(profile, 0)), [], 10000);
  }
}
await writeFile(`${directory}/corpus.json`, `${JSON.stringify({
  version: 1, tier: 'bot-oracle', status: 'authored-not-captured', contentSetHash: manifest.sha256,
  fixtures: names, maps, profiles: profileHashes,
  commands: { generate: 'bun tools/oracle/generate-bots.ts', build: 'tools/oracle/build.sh', capture: 'bun tools/oracle/capture-bots.ts' },
  captureEvidence: 'capture-results.json is written only by capture-bots.ts after actual Docker runs; no goldens are generated by this authoring tool.',
}, null, 2)}\n`);
console.log(JSON.stringify({ status: 'authored-not-captured', fixtures: names.length, contentSetHash: manifest.sha256, maps }));
