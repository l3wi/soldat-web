import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContentIndex, loadContentManifest, loadRenderMap } from './content';
import { sessionBytes, sessionJson } from './session-cache';

test('index and selected render map are shared across mounts; provenance stays lazy', async () => {
  const original = globalThis.fetch, requests: string[] = [];
  const index = { maps: { Arena: { path: 'maps/Arena.json' }, Airpirates: { path: 'maps/Airpirates.json' } } };
  globalThis.fetch = (async input => {
    const url = String(input); requests.push(url);
    return Response.json(url === '/content/index.json' ? index : url === '/content/manifest.json' ? { objects: {} } : { name: url });
  }) as typeof fetch;
  try {
    const [first, second] = await Promise.all([loadContentIndex(), loadContentIndex()]);
    assert.equal(first, second);
    const [map, sameMap] = await Promise.all([loadRenderMap('Arena'), loadRenderMap('Arena')]);
    assert.equal(map, sameMap);
    assert.equal(await loadRenderMap('Arena'), map);
    assert.deepEqual(requests, ['/content/index.json', '/content/maps/Arena.json']);
    await loadContentManifest(); await loadContentManifest();
    assert.deepEqual(requests, ['/content/index.json', '/content/maps/Arena.json', '/content/manifest.json']);
  } finally { globalThis.fetch = original; }
});

test('aborting one mount does not cancel a shared in-flight request', async () => {
  const original = globalThis.fetch;
  let finish!: (response: Response) => void, calls = 0;
  globalThis.fetch = (async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
  try {
    const abort = new AbortController();
    const leaving = sessionJson('/cache-test/shared', abort.signal), staying = sessionJson('/cache-test/shared');
    abort.abort();
    await assert.rejects(leaving, { name: 'AbortError' });
    finish(Response.json({ ready: true }));
    assert.deepEqual(await staying, { ready: true });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('failed requests can be retried; successful bytes remain shared', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1 ? new Response(null, { status: 503 }) : new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
  try {
    await assert.rejects(sessionBytes('/cache-test/retry'), /503/);
    const bytes = await sessionBytes('/cache-test/retry');
    assert.equal(await sessionBytes('/cache-test/retry'), bytes);
    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
