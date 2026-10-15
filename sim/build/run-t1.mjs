#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const corpus = join(root, 'tests/fixtures/movement');
const output = resolve(process.argv[2] ?? join(root, 'build-out/sim/t1'));
const authoritative = process.argv.includes('--authoritative');
if (!output.startsWith(`${root}/`)) throw new Error('Output must remain inside the repository host bind mount');
await mkdir(output, { recursive: true });
await mkdir(join(output, 'tmp'), { recursive: true });
await mkdir(join(output, 'home'), { recursive: true });
const containerPath = path => `/work/${path.slice(root.length + 1)}`;
function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const process = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    process.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    process.on('error', reject);
    process.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}
const fixtures = (await readdir(corpus)).filter(name => name.endsWith('.fixture.json')).sort();
if (!fixtures.length) throw new Error('Movement corpus is empty');
const evidence = JSON.parse(await readFile(join(corpus, 'capture-results.json'), 'utf8'));
const captures = new Map(evidence.captures.map(capture => [capture.fixture, capture]));
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function golden(fixture, name) {
  const capture = captures.get(fixture);
  if (!capture || capture.exitCode !== 0) throw new Error(`Missing successful oracle capture: ${fixture}`);
  if (capture.golden) {
    const path = join(corpus, capture.golden);
    if (await sha256(path) !== capture.compressedSha256) throw new Error(`Golden digest mismatch: ${fixture}`);
    return { path, regeneration: null };
  }
  const directory = join(root, 'build-out/movement-oracle');
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, 'tmp'), { recursive: true });
  await mkdir(join(directory, 'home'), { recursive: true });
  const args = ['run', '--rm', '--network', 'none', '--read-only', '--platform', 'linux/arm64',
    '-v', `${root}/build-out/oracle:/work:ro`,
    '-v', `${join(corpus, fixture)}:/fixture.json:ro`, '-v', `${corpus}:/fixture-maps:ro`,
    '-v', `${directory}:/output`, '-w', '/work/runtime',
    '-e', 'LD_LIBRARY_PATH=/work/cmake/bin', '-e', 'TMPDIR=/output/tmp', '-e', 'HOME=/output/home',
    evidence.image, '/work/cmake/bin/opensoldatserver', '/fixture.json', `/output/${name}.jsonl`,
    '/work/base/soldat.smod', '/work/runtime'];
  const regeneration = await run('docker', args);
  if (regeneration.code !== 0) throw new Error(`Oracle regeneration failed: ${fixture}: ${regeneration.stderr}`);
  const path = join(directory, `${name}.jsonl`);
  if (await sha256(path) !== capture.sha256) throw new Error(`Regenerated oracle digest mismatch: ${fixture}`);
  return { path, regeneration };
}
const results = [];
for (const fixture of fixtures) {
  const name = fixture.slice(0, -'.fixture.json'.length);
  const trace = join(output, `${name}.jsonl`);
  const expected = await golden(fixture, name);
  const args = ['run', '--rm', '--network', 'none', '-v', `${root}:/work`,
    '-e', `SIM_CONTROL_POLICY=${authoritative ? 'authoritative' : 'human'}`,
    '-e', `TMPDIR=${containerPath(join(output, 'tmp'))}`,
    '-e', `SIM_RECEIPT_OUT=${containerPath(join(output, `${name}.hashes.jsonl`))}`,
    '-e', `HOME=${containerPath(join(output, 'home'))}`, '-w', '/work',
    'soldat-web/fpc:bcd7288', '/work/build-out/sim/linux/sim-native',
    containerPath(join(corpus, fixture)), containerPath(trace),
    '/work/dist/content/sim', '/work/tests/fixtures/movement/maps'];
  const capture = await run('docker', args);
  let comparison = null;
  if (capture.code === 0) {
    comparison = await run(process.execPath, ['sim/build/compare-traces.mjs',
      expected.path, trace]);
  }
  const result = { fixture: basename(fixture), oracleRegeneration: expected.regeneration, native: capture, comparison,
    status: capture.code === 0 && comparison?.code === 0 ? 'pass' : 'fail' };
  results.push(result);
  console.log(JSON.stringify(result));
}
const summary = { tier: 'T1', control: authoritative ? 'authoritative' : 'human', passed: results.filter(result => result.status === 'pass').length,
  total: results.length, results };
await writeFile(join(output, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
if (summary.passed !== summary.total) process.exitCode = 1;
