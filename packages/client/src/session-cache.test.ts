import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionBytes, sessionJson, type SessionProgress } from './session-cache';

test('session bytes publish actual stream reads and cached completions without refetching', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-length': '5' } });
  }) as typeof fetch;
  try {
    const progress: SessionProgress[] = [];
    const request = sessionBytes('/cache-test/stream-progress', undefined, value => progress.push(value));
    stream.enqueue(new Uint8Array([1, 2]));
    stream.enqueue(new Uint8Array([3, 4, 5]));
    stream.close();
    assert.deepEqual([...await request], [1, 2, 3, 4, 5]);
    assert.ok(progress.some(value => value.bytes === 2 && value.totalBytes === 5 && !value.done));
    assert.deepEqual(progress.at(-1), { bytes: 5, totalBytes: 5, done: true });
    const cached: SessionProgress[] = [];
    await sessionBytes('/cache-test/stream-progress', undefined, value => cached.push(value));
    assert.deepEqual(cached, [{ bytes: 5, totalBytes: 5, done: true }]);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('JSON and byte consumers share the same transfer and decoded JSON object', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const source = new TextEncoder().encode('{"ready":true}');
  globalThis.fetch = (async () => { calls++; return new Response(source); }) as typeof fetch;
  try {
    const [bytes, first, second] = await Promise.all([
      sessionBytes('/cache-test/json-stream'),
      sessionJson<{ ready: boolean }>('/cache-test/json-stream'),
      sessionJson<{ ready: boolean }>('/cache-test/json-stream'),
    ]);
    assert.deepEqual(bytes, source);
    assert.deepEqual(first, { ready: true });
    assert.equal(first, second);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('an aborted observer stops progress without cancelling another consumer', async () => {
  const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
  try {
    const abort = new AbortController();
    const progress: SessionProgress[] = [];
    const leaving = sessionBytes('/cache-test/abort-progress', abort.signal, value => progress.push(value));
    const staying = sessionBytes('/cache-test/abort-progress');
    abort.abort();
    await assert.rejects(leaving, { name: 'AbortError' });
    const count = progress.length;
    finish(new Response(new Uint8Array([7, 8])));
    assert.deepEqual([...await staying], [7, 8]);
    assert.equal(progress.length, count);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
