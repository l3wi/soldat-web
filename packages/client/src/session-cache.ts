export interface SessionProgress {
  bytes: number;
  totalBytes: number;
  done: boolean;
}
export type SessionProgressCallback = (progress: SessionProgress) => void;

interface ByteRequest {
  promise: Promise<Uint8Array<ArrayBuffer>>;
  progress: SessionProgress;
  listeners: Set<SessionProgressCallback>;
}
const byteRequests = new Map<string, ByteRequest>();
const jsonRequests = new Map<string, Promise<unknown>>();
const imageRequests = new Map<string, Promise<HTMLImageElement>>();

/** A consumer can leave without cancelling shared session work for another mount. */
export function sessionResult<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    request.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

function cached<T>(cache: Map<string, Promise<T>>, url: string, load: () => Promise<T>): Promise<T> {
  let request = cache.get(url);
  if (!request) {
    request = load().catch(error => { cache.delete(url); throw error; });
    cache.set(url, request);
  }
  return request;
}

export function sessionBytes(url: string, signal?: AbortSignal, onProgress?: SessionProgressCallback): Promise<Uint8Array<ArrayBuffer>> {
  let entry = byteRequests.get(url);
  if (!entry) {
    const state: ByteRequest = { promise: undefined!, progress: { bytes: 0, totalBytes: 0, done: false }, listeners: new Set() };
    const publish = (bytes: number, totalBytes: number, done = false) => {
      state.progress = { bytes, totalBytes, done };
      for (const listener of state.listeners) listener(state.progress);
    };
    state.promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      // Encoded Content-Length is not comparable with the browser's decoded stream.
      const declared = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length'));
      const expected = Number.isFinite(declared) && declared > 0 ? declared : 0;
      publish(0, expected);
      if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        publish(bytes.byteLength, bytes.byteLength, true);
        return bytes;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          length += value.byteLength;
          publish(length, Math.max(expected, length));
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      publish(length, length, true);
      return bytes;
    })().catch(error => { byteRequests.delete(url); throw error; });
    entry = state;
    byteRequests.set(url, entry);
  }
  if (!onProgress || signal?.aborted) return sessionResult(entry.promise, signal);
  const observed = entry;
  const stop = () => { observed.listeners.delete(onProgress); signal?.removeEventListener('abort', stop); };
  observed.listeners.add(onProgress);
  signal?.addEventListener('abort', stop, { once: true });
  onProgress(observed.progress);
  return sessionResult(observed.promise, signal).then(value => { stop(); return value; }, error => { stop(); throw error; });
}

export function sessionJson<T>(url: string, signal?: AbortSignal, onProgress?: SessionProgressCallback): Promise<T> {
  const bytes = sessionBytes(url, signal, onProgress);
  // Parsing is shared as well as the bytes. Consumer abort never poisons the cache.
  const parsed = cached(jsonRequests, url, async () => {
    const data = await sessionBytes(url);
    try { return JSON.parse(new TextDecoder().decode(data)) as T; }
    catch (error) { byteRequests.delete(url); throw error; }
  });
  return Promise.all([bytes, sessionResult(parsed, signal)]).then(([, value]) => value as T);
}

/** Decoded original images are shared by shell previews, HUDs and texture banks. */
export function sessionImage(url: string, signal?: AbortSignal, onProgress?: SessionProgressCallback): Promise<HTMLImageElement> {
  const bytes = sessionBytes(url, signal, onProgress);
  const image = cached(imageRequests, url, async () => {
    const data = await sessionBytes(url);
    const objectUrl = URL.createObjectURL(new Blob([data]));
    try {
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      return image;
    } finally { URL.revokeObjectURL(objectUrl); }
  });
  return Promise.all([bytes, sessionResult(image, signal)]).then(([, value]) => value);
}

export function sessionFont(family: string, url: string, signal?: AbortSignal, onProgress?: SessionProgressCallback): Promise<FontFace> {
  return sessionBytes(url, signal, onProgress).then(data => sessionResult(new FontFace(family, data.buffer).load(), signal));
}
