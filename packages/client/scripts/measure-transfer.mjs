import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

// Same private Chrome/CDP workflow for both production previews. Cache stays
// enabled: the third row is a real page reload, not a cleared browser profile.
const base = process.env.CLIENT_URL ?? 'http://127.0.0.1:5205';
const out = resolve(process.env.TRANSFER_OUT ?? 'build-out/download-size/transfer.json');
console.log(execFileSync('memory_pressure', { encoding: 'utf8' }));
const metadataResponse = await fetch(`${base}/content/manifest.json`);
assert.ok(metadataResponse.ok, 'Full provenance manifest must remain available');
const manifest = await metadataResponse.json();
const coreImages = new Set(Object.values(manifest.core.graphics).flatMap(group => group.flatMap(graphic => graphic.asset?.frames.map(frame => frame.object) ?? [])));
const coreObjects = new Set([manifest.core.font, manifest.core.gostek]);
function category(url) {
  const path = decodeURIComponent(new URL(url).pathname);
  if (/\.wasm$/.test(path)) return 'WASM';
  if (/\.(pack|spk)$/.test(path) || path.startsWith('/content/sim/') && !path.endsWith('.json')) return 'Simulation content';
  if (/\.(wav|ogg|opus)$/.test(path)) return 'Audio';
  if (/\.(png|webp)$/.test(path)) return coreImages.has(path.slice('/content/'.length)) ? 'Core images' : 'Map images';
  if (/\.js$/.test(path)) return 'JavaScript';
  if (/\.json$/.test(path)) return 'JSON';
  if (coreObjects.has(path.slice('/content/'.length))) return 'Font / core data';
  return 'HTML / CSS / other';
}
const report = { url: base, method: 'Chrome CDP Network.loadingFinished.encodedDataLength (wire bytes incl. response headers); dataReceived.dataLength (decoded body)', cache: 'fresh private context; normal HTTP cache enabled throughout, including reload', browser: '', rows: [], errors: [], completed: false };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
await mkdir(dirname(out), { recursive: true });
try {
  report.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const requests = new Map();
  let current;
  cdp.on('Network.requestWillBeSent', event => {
    if (!current || !event.request.url.startsWith(base)) return;
    const row = { url: event.request.url, category: category(event.request.url), transferred: 0, decoded: 0, cached: false, finished: false };
    requests.set(event.requestId, row); current.requests.push(row);
  });
  cdp.on('Network.responseReceived', event => {
    const row = requests.get(event.requestId); if (!row) return;
    row.status = event.response.status; row.cached = !!(event.response.fromDiskCache || event.response.fromPrefetchCache);
    row.encoding = event.response.headers['Content-Encoding'] ?? event.response.headers['content-encoding'] ?? null;
    if (row.status >= 400) report.errors.push(`HTTP ${row.status}: ${row.url}`);
  });
  cdp.on('Network.requestServedFromCache', event => { const row = requests.get(event.requestId); if (row) row.cached = true; });
  cdp.on('Network.dataReceived', event => { const row = requests.get(event.requestId); if (row) row.decoded += event.dataLength; });
  cdp.on('Network.loadingFinished', event => { const row = requests.get(event.requestId); if (row) { row.transferred = event.encodedDataLength; row.finished = true; } });
  cdp.on('Network.loadingFailed', event => { const row = requests.get(event.requestId); if (row) { row.failed = event.errorText; report.errors.push(`${event.errorText}: ${row.url}`); } });
  page.on('pageerror', error => report.errors.push(error.message));
  for (const [stage, map, mode] of [['First Arena', 'Arena', 'dm'], ['Then ctf_Ash', 'ctf_Ash', 'ctf'], ['Reload + Arena', 'Arena', 'dm']]) {
    current = { stage, map, bots: 4, categories: {}, requests: [] }; report.rows.push(current);
    if (stage === 'First Arena') await page.goto(base);
    else if (stage === 'Reload + Arena') await page.reload();
    else await page.getByRole('button', { name: 'Main menu', exact: true }).click();
    await page.waitForSelector('#map-choice option[value="Arena"]');
    await page.selectOption('#map-choice', map);
    await page.selectOption('#game-mode', mode);
    await page.fill('#bot-count', '4');
    await page.getByRole('button', { name: 'Start sandbox', exact: true }).click();
    await page.waitForFunction(() => (window.__soldatClient?.tick ?? 0) > 2 || /unavailable|stopped|error/i.test(window.__soldatClient?.simulation ?? ''), undefined, { timeout: 120_000 });
    const diagnostics = await page.evaluate(() => window.__soldatClient);
    assert.ok(diagnostics?.tick > 2 && !/unavailable|stopped|error/i.test(diagnostics.simulation), JSON.stringify(diagnostics));
    await page.getByRole('button', { name: 'Enable audio', exact: true }).click();
    await page.getByText('Audio enabled.', { exact: true }).waitFor();
    const firstTick = await page.evaluate(() => window.__soldatClient.tick);
    await page.waitForFunction(tick => window.__soldatClient.tick >= tick + 300, firstTick, { timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    current.diagnostics = await page.evaluate(() => window.__soldatClient);
    for (const row of current.requests) {
      const totals = current.categories[row.category] ??= { requests: 0, transferred: 0, decoded: 0, cached: 0 };
      totals.requests++; totals.transferred += row.transferred; totals.decoded += row.decoded; totals.cached += Number(row.cached);
    }
    current.transferred = Object.values(current.categories).reduce((sum, row) => sum + row.transferred, 0);
    current.decoded = Object.values(current.categories).reduce((sum, row) => sum + row.decoded, 0);
    await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  }
  report.completed = report.errors.length === 0;
  assert.ok(report.completed, report.errors.join('\n'));
} finally {
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify({ browser: report.browser, rows: report.rows.map(({ requests, ...row }) => row), errors: report.errors, completed: report.completed }, null, 2));
