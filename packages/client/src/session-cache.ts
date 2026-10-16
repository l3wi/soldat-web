const byteRequests = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
const jsonRequests = new Map<string, Promise<unknown>>();

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

export function sessionBytes(url: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return sessionResult(cached(byteRequests, url, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }), signal);
}

export function sessionJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return sessionResult(cached(jsonRequests, url, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }) as Promise<T>, signal);
}
