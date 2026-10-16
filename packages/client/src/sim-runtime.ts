import simWasmUrl from 'virtual:soldat-sim-wasm';
import { sha256 } from '@soldat-web/sim-host';
import { sessionBytes, sessionResult } from './session-cache';

const modules = new Map<string, Promise<{ module: WebAssembly.Module; sha256: string }>>();

/** Cache immutable code, never the host, memory, WASI imports or gameplay state. */
export function loadSimulationCode(signal?: AbortSignal, url = simWasmUrl): Promise<{ module: WebAssembly.Module; sha256: string }> {
  let request = modules.get(url);
  if (!request) {
    request = sessionBytes(url).then(async bytes => {
      const [module, hash] = await Promise.all([WebAssembly.compile(bytes), sha256(bytes)]);
      return { module, sha256: hash };
    }).catch(error => { modules.delete(url); throw error; });
    modules.set(url, request);
  }
  return sessionResult(request, signal);
}
