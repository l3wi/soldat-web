import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { SimManifest } from '../../packages/sim-host/src/sim.ts';
import { stringifyReceipt } from '../../scripts/receipt-paths.mjs';

// Restore omitted historical data, not new acceptance evidence. Never rewrite captures.
const root = process.cwd(), directory = 'tests/fixtures/bots';
const names = ['arena-eight-bot-dm-10000', 'arena-original-world-eight-bot-dm-10000'];
const contentRoot = resolve(process.env.RESTORE_CONTENT_ROOT ?? 'dist/content-next');
const output = 'build-out/oracle/restored-bots';
interface Capture {
  fixture: string; fixtureSha256: string; golden: string; sha256: string; bytes: number;
  compressedSha256: string; compressedBytes: number; repeat: { byteIdentical: boolean };
}
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function execute(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
const manifest = JSON.parse(await readFile(`${directory}/sim-manifest.json`, 'utf8')) as SimManifest;
const corpus = JSON.parse(await readFile(`${directory}/corpus.json`, 'utf8')) as { contentSetHash: string };
const evidence = JSON.parse(await readFile(`${directory}/capture-results.json`, 'utf8')) as { captures: Capture[] };
const identity = Object.keys(manifest.files).sort().map(id => `${id}\t${manifest.files[id]!.sha256}\n`).join('');
if (manifest.sha256 !== corpus.contentSetHash || createHash('sha256').update(identity).digest('hex') !== manifest.sha256) throw new Error('Frozen bot input manifest does not match its corpus');
const oracle = 'build-out/oracle/cmake/bin/opensoldatserver';
if (!(await stat(oracle)).isFile()) throw new Error('Build the pinned native oracle with tools/oracle/build.sh before restoring goldens');
const oracleSha256 = await hashFile(oracle);
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(output, 'work-'));
const restored: { fixture: string; sha256: string; compressedSha256: string; bytes: number; compressedBytes: number }[] = [];
try {
  // A frozen input projection preserves the old corpus identity even when the runtime
  // import adds other files. Every original byte is checked; production content stays untouched.
  const projectedRoot = join(work, 'content');
  for (const entry of Object.values(manifest.files)) {
    const destination = join(projectedRoot, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(contentRoot, entry.path), destination);
    if ((await stat(destination)).size !== entry.bytes || await hashFile(destination) !== entry.sha256) throw new Error(`Historical oracle input differs: ${entry.path}`);
  }
  await writeFile(join(projectedRoot, 'sim/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(work, 'traces'));
  await mkdir(`${directory}/golden`, { recursive: true });
  for (const name of names) {
    const fixture = `${directory}/${name}.fixture.json`;
    const expected = evidence.captures.find(capture => capture.fixture === `${name}.fixture.json`);
    if (!expected?.repeat.byteIdentical || expected.golden !== `golden/${name}.jsonl.gz` || expected.fixtureSha256 !== await hashFile(fixture)) throw new Error(`Missing or stale historical capture: ${name}`);
    const raw = join(work, 'traces', `${name}.jsonl`), packed = `${raw}.gz`;
    execute('tools/oracle/run.sh', [fixture, raw], { ...process.env, ORACLE_CONTENT_ROOT: resolve(projectedRoot, 'sim') });
    const sha256 = await hashFile(raw), bytes = (await stat(raw)).size;
    if (sha256 !== expected.sha256 || bytes !== expected.bytes) throw new Error(`Regenerated native trace differs: ${name}; do not update the historical receipt to accept it`);
    await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(packed));
    const compressedSha256 = await hashFile(packed), compressedBytes = (await stat(packed)).size;
    if (compressedSha256 !== expected.compressedSha256 || compressedBytes !== expected.compressedBytes) throw new Error(`Regenerated gzip differs: ${name}; use the recorded Bun/compression toolchain`);
    // Only verified, byte-identical output replaces the local generated fixture.
    await rename(packed, `${directory}/${expected.golden}`);
    restored.push({ fixture, sha256, compressedSha256, bytes, compressedBytes });
    console.log(JSON.stringify({ fixture, status: 'restored-byte-identical', sha256, compressedSha256 }));
    await rm(raw);
    await rm(`${raw}.pickups.jsonl`, { force: true });
  }
  await writeFile(`${output}/results.json`, `${stringifyReceipt({ version: 1, purpose: 'historical-golden-restoration-only', status: 'pass', contentSetHash: manifest.sha256, oracleSha256, runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, restored })}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
