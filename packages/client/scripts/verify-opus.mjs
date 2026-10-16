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
  let browsingContext;
  const evaluate = async (fn, argument) => {
    if (!task.bidi) return page.evaluate(fn, argument);
    // Firefox 115's legacy CDP Runtime may lose its default context on an
    // origin change. Evaluate against the explicit BiDi browsing context.
    const expression = `(async()=>JSON.stringify({value:await (${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})}))()`;
    const reply = await task.bidi.send('script.evaluate', {
      expression, target: { context: browsingContext }, awaitPromise: true, resultOwnership: 'none',
    });
    if (reply.type !== 'success') throw new Error(`Firefox page evaluation failed: ${JSON.stringify(reply)}`);
    return JSON.parse(reply.result.value).value;
  };
  const destination = new URL('/', base).href;
  if (task.bidi) {
    // Wait for the actual new document before evaluating browser audio code.
    const { contexts } = await task.bidi.send('browsingContext.getTree', {});
    assert.equal(contexts.length, 1, 'Expected one owned private browsing context');
    browsingContext = contexts[0].context;
    await task.bidi.send('browsingContext.navigate', { context: contexts[0].context, url: destination, wait: 'complete' });
  } else await page.goto(destination);
  report.runtime = await evaluate(() => navigator.userAgent);
  const samples = await evaluate(async () => {
    const response = await fetch('/content/index.json');
    if (!response.ok) throw new Error(`index HTTP ${response.status}`);
    const index = await response.json();
    window.__opusContext = new AudioContext();
    return Object.entries(index.core.sfx).map(([id, asset]) => ({ id, ...asset }));
  });
  assert.ok(samples.length > 0);
  for (const sample of samples) {
    assert.match(sample.object, /\.(?:ogg|opus)$/);
    const result = await evaluate(async sample => {
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
  await evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Enable verification audio';
    button.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:60px;z-index:2147483647';
    button.onclick = () => { void window.__opusContext.resume(); };
    document.body.append(button);
  });
  await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 });
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 20, button: 'left', clickCount: 1 });
  await evaluate(async () => {
    if (window.__opusContext.state === 'running') return;
    await new Promise((resolveRunning, reject) => {
      const timeout = setTimeout(() => reject(new Error('Trusted input failed to unlock Web Audio')), 5000);
      window.__opusContext.onstatechange = () => {
        if (window.__opusContext.state === 'running') { clearTimeout(timeout); resolveRunning(); }
      };
    });
  });
  const loops = samples.filter(sample => sample.loop);
  assert.equal(loops.length, 3, 'All three native looping samples must be exercised');
  report.playback = [];
  for (const sample of loops) {
    report.playback.push(await evaluate(async sample => {
      const context = window.__opusContext;
      if (context.state !== 'running') throw new Error(`Audio context failed to unlock: ${context.state}`);
      const response = await fetch(`/content/${sample.object}`);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      const source = context.createBufferSource(); source.buffer = buffer; source.loop = true; source.connect(context.destination);
      const startedAt = context.currentTime, duration = buffer.duration * 2.1;
      const ended = new Promise(resolveEnded => { source.onended = resolveEnded; });
      source.start(); source.stop(startedAt + duration);
      await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('Audio source failed to end')), 5000))]);
      const elapsed = context.currentTime - startedAt;
      if (elapsed < duration - 0.01) throw new Error('Audio clock did not advance through two loop boundaries');
      return { id: sample.id, loop: true, wraps: 2, state: context.state, elapsed, ended: true, evidence: 'Real Web Audio source connected to destination and played through two wraps; no claim of human audible-quality review' };
    }, sample));
  }
  await evaluate(() => window.__opusContext.close());
  report.completed = report.samples.length === samples.length && report.playback.every(row => row.ended);
  assert.ok(report.completed);
} finally {
  await writeFile(resolve(out, 'opus-results.json'), JSON.stringify(report, null, 2) + '\n');
  await task.finish({ keep: [] });
}
console.log(JSON.stringify({ engine, runtime: report.runtime, decoded: report.samples.length, maxDurationDeviationSeconds: report.maxDurationDeviationSeconds, playback: report.playback, completed: report.completed }, null, 2));
