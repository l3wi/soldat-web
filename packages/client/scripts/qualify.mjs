import { spawn } from 'node:child_process';
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
const profiles = await Promise.all(['chrome', 'firefox'].map(name => mkdtemp(resolve(tmpdir(), `${runId}-${name}-`))));
const browsers = [
  spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', `--user-data-dir=${profiles[0]}`, url], { stdio: 'ignore' }),
  spawn('/Applications/Firefox.app/Contents/MacOS/firefox', ['--no-remote', '--profile', profiles[1], url], { stdio: 'ignore' }),
];
for (const child of browsers) child.on('error', error => { console.error(error); process.exitCode = 1; });
spawn('open', ['-a', 'Safari', url], { stdio: 'ignore' });
console.log(JSON.stringify({ runId, url, expected: config.fixtures.length * 9, timing: 'deterministic Phaser.Game.step timestamps; real installed Chrome, Firefox, Safari' }));
try {
  const deadline = Date.now() + 3_600_000;
  while (true) {
    if (Date.now() > deadline) throw new Error('Browser qualification deadline exceeded');
    const rows = (await (await fetch(`${base}/g2/results`)).json()).filter(row => row.runId === runId);
    const failure = rows.find(row => !row.accepted);
    if (failure) throw new Error(JSON.stringify(failure));
    const accepted = new Map(rows.map(row => [`${row.browser}:${row.hz}:${row.fixture}`, row]));
    if (accepted.size === config.fixtures.length * 9) {
      const hashes = new Set(rows.map(row => row.wasmSha256));
      if (hashes.size !== 1 || !rows[0]?.wasmSha256) throw new Error('Qualification mixed simulation artifacts');
      const results = { runId, wasmSha256: rows[0].wasmSha256, timing: 'deterministic display timestamps, not physical display refresh', total: accepted.size, failures: 0, results: [...accepted.values()] };
      const out = resolve(import.meta.dirname, '../../../build-out/client-g2');
      await mkdir(out, { recursive: true }); await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
      console.log(JSON.stringify({ runId, accepted: accepted.size, failures: 0 })); break;
    }
    await setTimeout(2000);
  }
} finally {
  await Promise.all(browsers.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }));
  // Only these disposable headless profiles belong to this command.
  await Promise.all(profiles.map(path => rm(path, { recursive: true, force: true })));
}
