import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';

const base = process.env.CLIENT_URL ?? 'http://127.0.0.1:5195';
const config = await (await fetch(`${base}/g2/config`)).json();
const runId = `g2-${Date.now()}`;
await fetch(`${base}/g2/start?run=${runId}`, { method: 'POST' });
const url = `${base}/?g2&map=Airpirates&run=${runId}`;
const engines = [
  { name: 'chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: profile => ['--headless=new', '--mute-audio', '--no-first-run', `--user-data-dir=${profile}`, url] },
  { name: 'firefox', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', args: profile => ['--headless', '--no-remote', '--profile', profile, url] },
];
const accepted = new Map();
console.log(JSON.stringify({ runId, url, expected: config.fixtures.length * 3 * engines.length, timing: 'serial private headless installed Chrome and Firefox; deterministic Phaser.Game.step timestamps', skipped: { safari: 'Not run by user decision' } }));
for (const engine of engines) {
  console.log(execFileSync('memory_pressure', { encoding: 'utf8' }));
  const profile = await mkdtemp(resolve(tmpdir(), `${runId}-${engine.name}-`));
  // Test browsers must never be audible on the host speakers.
  if (engine.name === 'firefox') await writeFile(resolve(profile, 'user.js'), 'user_pref("media.volume_scale", "0.0");\n');
  const child = spawn(engine.executable, engine.args(profile), { stdio: 'ignore' });
  let launchError;
  child.on('error', error => { launchError = error; });
  try {
    const deadline = Date.now() + 3_600_000;
    while (true) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${engine.name} exited before qualification completed`);
      if (Date.now() > deadline) throw new Error(`${engine.name} qualification deadline exceeded`);
      const rows = (await (await fetch(`${base}/g2/results`)).json()).filter(row => row.runId === runId);
      const failure = rows.find(row => !row.accepted);
      if (failure) throw new Error(JSON.stringify(failure));
      const engineRows = rows.filter(row => row.browser === engine.name);
      const distinct = new Map(engineRows.map(row => [`${row.hz}:${row.fixture}`, row]));
      if (distinct.size === config.fixtures.length * 3) {
        for (const row of distinct.values()) accepted.set(`${row.browser}:${row.hz}:${row.fixture}`, row);
        console.log(JSON.stringify({ runId, browser: engine.name, accepted: distinct.size, failures: 0 }));
        break;
      }
      await setTimeout(2000);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    await rm(profile, { recursive: true, force: true });
  }
}
const rows = [...accepted.values()];
const hashes = new Set(rows.map(row => row.wasmSha256));
if (hashes.size !== 1 || !rows[0]?.wasmSha256) throw new Error('Qualification mixed simulation artifacts');
const results = { runId, wasmSha256: rows[0].wasmSha256, timing: 'deterministic display timestamps, not physical display refresh', total: accepted.size, failures: 0, skipped: { safari: 'Not run by user decision' }, results: rows };
const out = resolve(import.meta.dirname, '../../../build-out/client-g2');
await mkdir(out, { recursive: true }); await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ runId, accepted: accepted.size, failures: 0 }));
