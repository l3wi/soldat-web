#!/usr/bin/env node
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, join, relative, isAbsolute } from 'node:path';

const root = resolve(import.meta.dirname, '../..'), corpus = 'tests/fixtures/combat/corpus.json';
const options = { tier: 'all', rng: 'both', out: 'build-out/sim/combat', wasm: 'build-out/sim/sim.wasm', native: 'build-out/sim/linux/sim-native' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, ''), value = args[i + 1];
  if (!Object.hasOwn(options, key) || !value) throw new Error('Usage: node sim/build/run-combat.mjs [--tier all|t1|t2|t3] [--rng both|original|keyed] [--out DIRECTORY] [--wasm FILE] [--native LINUX-FILE]');
  options[key] = value;
}
if (!['all', 't1', 't2', 't3'].includes(options.tier) || !['both', 'original', 'keyed'].includes(options.rng)) throw new Error('Invalid tier or RNG policy');
if (options.tier === 't1' && options.rng === 'keyed') throw new Error('T1 is original RNG only');
const output = resolve(root, options.out), relOutput = relative(root, output);
if (isAbsolute(relOutput) || relOutput.startsWith('..')) throw new Error('Output must remain in the host repository mount');
const container = path => {
  const rel = relative(root, resolve(root, path));
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error(`Path escapes host bind: ${path}`);
  return `/repo/${rel}`;
};
await mkdir(join(output, 'tmp'), { recursive: true }); await mkdir(join(output, 'home'), { recursive: true });
async function run(command, args) {
  return await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root }), out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject); child.on('close', code => done({ command: [command, ...args], code: code ?? -1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}
async function hashFile(path) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
const index = JSON.parse(await readFile(resolve(root, corpus), 'utf8'));
if (!Array.isArray(index.fixtures) || !index.fixtures.length) throw new Error('Empty combat corpus');
const fixtures = index.fixtures.map(name => ({ name, path: `tests/fixtures/combat/${name}` }));
const policies = options.rng === 'both' ? ['original', 'keyed'] : [options.rng];
const results = [];
let evidence;
if (options.tier === 'all' || options.tier === 't1') {
  evidence = JSON.parse(await readFile(resolve(root, 'tests/fixtures/combat/capture-results.json'), 'utf8'));
}
const image = evidence?.image ?? process.env.ORACLE_IMAGE ?? 'soldat-web/fpc:bcd7288';
const platform = evidence?.platform ?? process.env.ORACLE_PLATFORM ?? 'linux/arm64';
for (const policy of policies) {
  const lane = join(output, policy), nativeOut = join(lane, 'native'), nodeOut = join(lane, 'node');
  await mkdir(nativeOut, { recursive: true }); await mkdir(nodeOut, { recursive: true });
  if (options.tier === 'all' || options.tier === 't2') {
    const node = await run(process.execPath, ['packages/sim-host/src/fixture-node.ts', '--corpus', corpus, '--rng', policy, '--trace', '--wasm', options.wasm, '--out', nodeOut]);
    results.push({ tier: 'T3-node-roundtrip', policy, ...node, status: node.code === 0 ? 'pass' : 'fail' });
  }
  for (const file of fixtures) {
    const name = file.name.replace(/[.]fixture[.]json$/, ''), fixture = JSON.parse(await readFile(resolve(root, file.path), 'utf8'));
    if (fixture.ticks < 300) throw new Error(`Short combat fixture: ${file.name}`);
    if (options.tier === 't3') continue;
    if (options.tier === 't1' && policy !== 'original') continue;
    const trace = join(nativeOut, `${name}.jsonl`), hashes = join(nativeOut, `${name}.hashes.jsonl`);
    const native = await run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--platform', platform,
      '-v', `${root}:/repo`, '-w', '/repo', '-e', `TMPDIR=${container(join(output, 'tmp'))}`, '-e', `HOME=${container(join(output, 'home'))}`,
      '-e', `SIM_RNG_POLICY=${policy}`, '-e', `SIM_RECEIPT_OUT=${container(hashes)}`, image, container(options.native), container(file.path), container(trace), '/repo/dist/content/sim', '/repo/tests/fixtures/combat/maps']);
    results.push({ tier: 'native-capture', policy, fixture: file.name, ...native, status: native.code === 0 ? 'pass' : 'fail' });
    if (native.code !== 0) continue;
    if ((options.tier === 'all' || options.tier === 't1') && policy === 'original') {
      const expected = evidence.captures.find(item => item.fixture === file.name);
      if (!expected?.golden || expected.exitCode !== 0 || !expected.repeat?.byteIdentical) throw new Error(`Missing reproducible oracle golden: ${file.name}`);
      if (expected.fixtureSha256 !== await hashFile(resolve(root, file.path))) throw new Error(`Stale oracle fixture: ${file.name}`);
      const golden = resolve(root, 'tests/fixtures/combat', expected.golden);
      if (expected.compressedSha256 !== await hashFile(golden)) throw new Error(`Corrupt oracle golden: ${file.name}`);
      const comparison = await run(process.execPath, ['sim/build/compare-traces.mjs', golden, trace]);
      results.push({ tier: 'T1', policy, fixture: file.name, ...comparison, status: comparison.code === 0 ? 'pass' : 'fail' });
      results.push({ tier: 'observed-corpus-predicates', policy, fixture: file.name, observations: expected.summary?.observations, limitations: expected.summary?.limitations, status: expected.summary?.allRequiredObserved ? 'pass' : 'fail' });
    }
    if (options.tier === 'all' || options.tier === 't2') {
      const comparison = await run(process.execPath, ['sim/build/compare-traces.mjs', '--target', '--ticks-only', trace, join(nodeOut, `${name}.trace.jsonl`)]);
      results.push({ tier: 'T2', policy, fixture: file.name, ...comparison, status: comparison.code === 0 ? 'pass' : 'fail' });
      const expected = (await readFile(hashes, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const receipt = JSON.parse(await readFile(join(nodeOut, `${name}.receipt.json`), 'utf8'));
      const mismatch = expected.find((row, i) => row.tick !== receipt.baseline[i]?.tick || row.events !== receipt.baseline[i]?.events);
      results.push({ tier: 'T2-discrete-events', policy, fixture: file.name, mismatch: mismatch ?? null, status: !mismatch && expected.length === receipt.baseline.length ? 'pass' : 'fail' });
    }
  }
  if (options.tier === 'all' || options.tier === 't3') {
    // Use the existing browser receipt harness; never substitute WebKit for Safari.
    const browserRoot = join(lane, 'browser'); let files = [];
    try { files = (await readdir(browserRoot)).filter(name => name.endsWith('.receipt.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const accepted = new Map();
    for (const file of fixtures) {
      const name = file.name.replace(/[.]fixture[.]json$/, ''), baselinePath = join(nodeOut, `${name}.receipt.json`);
      let baseline;
      try { baseline = JSON.parse(await readFile(baselinePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const engine of ['Chrome', 'Firefox', 'Safari']) {
        const candidates = [];
        for (const receiptFile of files) {
          const receipt = JSON.parse(await readFile(join(browserRoot, receiptFile), 'utf8'));
          const actualEngine = /Firefox\//.test(receipt.runtime) ? 'Firefox' : /Chrome\//.test(receipt.runtime) ? 'Chrome' : /Version\/.*Safari\//.test(receipt.runtime) ? 'Safari' : 'unknown';
          if (receipt.fixture.endsWith(file.path) && actualEngine === engine) candidates.push(receipt);
        }
        const matched = baseline && /^Node v24[.]/.test(baseline.runtime) && candidates.some(receipt => receipt.rngPolicy === policy && receipt.identical && baseline.identical && ['fixtureSha256', 'wasmSha256', 'mapSha256', 'contentSetHash', 'abiVersion', 'rngPolicy'].every(key => receipt[key] === baseline[key]) && JSON.stringify(receipt.baseline) === JSON.stringify(baseline.baseline) && JSON.stringify(receipt.restored) === JSON.stringify(baseline.restored) && JSON.stringify(receipt.checkpoints) === JSON.stringify(baseline.checkpoints));
        accepted.set(`${file.name}:${engine}`, !!matched);
      }
    }
    results.push({ tier: 'T3-cross-runtime', policy, status: [...accepted.values()].every(Boolean) ? 'pass' : 'fail', missing: [...accepted].filter(([, passed]) => !passed).map(([key]) => key), browserCommand: `bun packages/sim-host/src/fixture-serve.ts --corpus ${corpus} --rng ${policy} --baseline ${relative(root, nodeOut)} --out ${relative(root, browserRoot)} --wasm ${options.wasm}`, note: 'Open returned URL in actual Chrome, Firefox and Safari, then rerun --tier t3. Missing browser evidence fails closed.' });
  }
}
const summary = { version: 1, corpus, policies, tier: options.tier, status: results.length > 0 && results.every(result => result.status === 'pass') ? 'pass' : 'fail', results };
await writeFile(join(output, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
for (const result of results) console.log(JSON.stringify(result));
if (summary.status !== 'pass') process.exitCode = 1;
