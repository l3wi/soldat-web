#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const options = { engine: 'Chrome', corpora: 'movement,combat,bots', rng: 'both', out: 'build-out/sim/g5/final', wasm: 'build-out/sim/sim.wasm', port: '4280' };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '');
  if (!Object.hasOwn(options, key) || !process.argv[index + 1]) throw new Error('Usage: node sim/build/run-browser-matrix.mjs --engine Chrome|Firefox [--corpora movement,combat,bots] [--rng both|original|keyed] [--out DIR] [--wasm FILE] [--port PORT]');
  options[key] = process.argv[index + 1];
}
if (!['Chrome', 'Firefox'].includes(options.engine) || !['both', 'original', 'keyed'].includes(options.rng)) throw new Error('Unsupported engine/policy');
const root = process.cwd(), output = resolve(options.out), policies = options.rng === 'both' ? ['original', 'keyed'] : [options.rng];
if (!output.startsWith(root + '/')) throw new Error('Output must stay inside repository');
await mkdir(output, { recursive: true });
const browserBinary = options.engine === 'Chrome' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/Applications/Firefox.app/Contents/MacOS/firefox';
const summary = [];
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once('exit', done)); child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(done => { timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000); })]);
  clearTimeout(timer);
}
let serial = 0;
for (const corpus of options.corpora.split(',')) for (const policy of policies) {
  if (!['movement', 'combat', 'bots'].includes(corpus)) throw new Error('Unknown corpus');
  const lane = join(output, corpus, policy), destination = join(lane, 'browser', options.engine);
  await mkdir(destination, { recursive: true });
  const profile = await mkdtemp(join(output, `private-${options.engine.toLowerCase()}-`));
  const port = Number(options.port) + serial++, url = `http://127.0.0.1:${port}/`;
  const log = createWriteStream(join(destination, 'process.log'));
  let server, browser;
  const started = performance.now();
  try {
    server = spawn('bun', ['packages/sim-host/src/fixture-serve.ts', '--corpus', `tests/fixtures/${corpus}/corpus.json`, '--rng', policy, '--baseline', join(lane, 'node'), '--out', destination, '--wasm', options.wasm], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
    await new Promise((done, reject) => {
      const deadline = setTimeout(() => reject(new Error('Fixture server readiness timeout')), 30000);
      server.once('error', error => { clearTimeout(deadline); reject(error); });
      server.once('exit', code => { clearTimeout(deadline); reject(new Error(`Fixture server exited ${code}`)); });
      server.stdout.on('data', chunk => { if (chunk.toString().includes('Fixture receipt server:')) { clearTimeout(deadline); done(); } });
    });
    const args = options.engine === 'Chrome'
      ? ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--user-data-dir=${profile}`, url]
      : ['-headless', '-no-remote', '-profile', profile, url];
    browser = spawn(browserBinary, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    browser.stdout.pipe(log, { end: false }); browser.stderr.pipe(log, { end: false });
    let completed;
    const deadline = Date.now() + 1800000;
    while (Date.now() < deadline) {
      if (browser.exitCode !== null || browser.signalCode !== null) throw new Error(`Browser exited before receipts: ${browser.exitCode ?? browser.signalCode}`);
      const status = await fetch(url + 'status').then(response => response.json());
      if (status.results.some(result => !result.accepted)) throw new Error(JSON.stringify(status.results.filter(result => !result.accepted)));
      if (status.results.length === status.expected) { completed = status; break; }
      await delay(500);
    }
    if (!completed) throw new Error('Browser receipt deadline exceeded');
    const result = { corpus, policy, engine: options.engine, expected: completed.expected, accepted: completed.results.length, results: completed.results, wallSeconds: (performance.now() - started) / 1000, status: 'pass' };
    await writeFile(join(destination, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
    summary.push(result); console.log(JSON.stringify({ corpus, policy, engine: options.engine, expected: result.expected, accepted: result.accepted, status: result.status, wallSeconds: result.wallSeconds }));
  } finally {
    await stop(browser); await stop(server); log.end();
    await rm(profile, { recursive: true, force: true });
  }
}
await writeFile(join(output, `browser-${options.engine.toLowerCase()}.json`), `${JSON.stringify({ version: 1, engine: options.engine, lanes: summary, status: summary.every(lane => lane.status === 'pass') ? 'pass' : 'fail' }, null, 2)}\n`);
