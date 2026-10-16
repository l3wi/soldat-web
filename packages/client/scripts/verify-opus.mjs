import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInstalledBrowserTask } from '../../server/scripts/installed-browser-rig.mjs';

// Uses the installed browsers in private headless profiles, never user tabs.
const base = process.env.CLIENT_URL ?? 'http://127.0.0.1:5205';
const engine = process.env.AUDIO_BROWSER ?? 'chrome';
const out = resolve(process.env.AUDIO_OUT ?? `build-out/download-size/audio-${engine}`);
await mkdir(out, { recursive: true });
const report = { engine, url: base, runtime: '', samples: [], maxDurationDeviationSeconds: 0, completed: false };
const task = await createInstalledBrowserTask({ engine, out });
try {
  const page = task.page('p1');
  await page.goto(base);
  report.runtime = await page.evaluate(() => navigator.userAgent);
  const samples = await page.evaluate(async () => {
    const response = await fetch('/content/index.json');
    if (!response.ok) throw new Error(`index HTTP ${response.status}`);
    const index = await response.json();
    window.__opusContext = new AudioContext();
    return Object.entries(index.core.sfx).map(([id, asset]) => ({ id, ...asset }));
  });
  assert.ok(samples.length > 0);
  for (const sample of samples) {
    assert.match(sample.object, /\.(?:ogg|opus)$/);
    const result = await page.evaluate(async sample => {
      const response = await fetch(`/content/${sample.object}`);
      if (!response.ok) throw new Error(`${sample.id}: HTTP ${response.status}`);
      const context = window.__opusContext;
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (!buffer.length || !Number.isFinite(buffer.duration)) throw new Error(`Invalid decoded audio: ${sample.id}`);
      const data = buffer.getChannelData(0);
      return { id: sample.id, object: sample.object, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate, frames: buffer.length,
        sourceDuration: sample.durationSeconds, decodedDuration: buffer.duration, durationDeviationSeconds: buffer.duration - sample.durationSeconds,
        boundaryJump: Math.abs(data[0] - data[data.length - 1]), peak: data.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0) };
    }, sample);
    report.samples.push(result);
    report.maxDurationDeviationSeconds = Math.max(report.maxDurationDeviationSeconds, Math.abs(result.durationDeviationSeconds));
  }
  // A trusted input event activates the real autoplay policy in both installed
  // browsers. No autoplay preference or permission is disabled for this check.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Enable verification audio';
    button.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:60px;z-index:2147483647';
    button.onclick = () => { void window.__opusContext.resume(); };
    document.body.append(button);
  });
  await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 });
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 20, button: 'left', clickCount: 1 });
  await page.waitForFunction(() => window.__opusContext.state === 'running');
  report.playback = await page.evaluate(async sample => {
    const context = window.__opusContext;
    if (context.state !== 'running') throw new Error(`Audio context failed to unlock: ${context.state}`);
    const response = await fetch(`/content/${sample.object}`);
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = true; source.connect(context.destination);
    const startedAt = context.currentTime;
    const ended = new Promise(resolveEnded => { source.onended = resolveEnded; });
    source.start(); source.stop(startedAt + 0.15);
    await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('Audio source failed to end')), 5000))]);
    const elapsed = context.currentTime - startedAt;
    if (elapsed < 0.14) throw new Error('Audio clock did not advance during playback');
    return { id: sample.id, loop: true, state: context.state, elapsed, ended: true, evidence: 'Real Web Audio source connected to destination, started and ended; no claim of human audible-quality review' };
  }, samples.find(sample => /jet/i.test(sample.id)) ?? samples[0]);
  await page.evaluate(() => window.__opusContext.close());
  report.completed = report.samples.length === samples.length && report.playback.ended;
  assert.ok(report.completed);
} finally {
  await writeFile(resolve(out, 'opus-results.json'), JSON.stringify(report, null, 2) + '\n');
  await task.finish({ keep: [] });
}
console.log(JSON.stringify({ engine, runtime: report.runtime, decoded: report.samples.length, maxDurationDeviationSeconds: report.maxDurationDeviationSeconds, playback: report.playback, completed: report.completed }, null, 2));
