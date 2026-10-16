import { requireStatus, sha256, type SimHost, type SimManifest } from '@soldat-web/sim-host';
import { contentUrl, loadContentIndex } from './content';
import { sessionBytes, sessionJson, sessionResult } from './session-cache';

const packs = new Map<string | null, Promise<ReadonlyMap<string, Uint8Array>>>();
let manifestRequest: Promise<SimManifest> | undefined;

export function loadSimulationManifest(signal?: AbortSignal): Promise<SimManifest> {
  manifestRequest ??= sessionJson<SimManifest>(contentUrl('sim/manifest.json')).then(async manifest => {
    if (manifest.schemaVersion !== 1) throw new Error('Unsupported simulation content schema');
    const ids = Object.keys(manifest.files).sort();
    for (const id of ids) {
      if (id !== id.toLowerCase() || id.includes('\\') || id.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Noncanonical sim VFS path: ${id}`);
    }
    const identity = ids.map(id => `${id}\t${manifest.files[id]!.sha256}\n`).join('');
    if (await sha256(new TextEncoder().encode(identity)) !== manifest.sha256) throw new Error('Simulation content-set identity mismatch');
    return manifest;
  }).catch(error => { manifestRequest = undefined; throw error; });
  return sessionResult(manifestRequest, signal);
}

/** SPK1 is a transport only: every raw file retains its original manifest identity. */
export async function verifySimulationPack(bytes: Uint8Array, manifest: SimManifest, selected: string | null, expected: { sha256: string; bytes: number }): Promise<ReadonlyMap<string, Uint8Array>> {
  if (bytes.length !== expected.bytes || await sha256(bytes) !== expected.sha256) throw new Error('Simulation pack identity mismatch');
  if (selected !== null && !manifest.files[selected]) throw new Error(`Selected map absent from sim content: ${selected}`);
  const ids = Object.keys(manifest.files).filter(id => selected === null || !id.startsWith('maps/') || id === selected).sort();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint32(0, false) !== 0x53504b31) throw new Error('Invalid simulation pack magic');
  if (view.getUint32(4, true) !== ids.length) throw new Error('Simulation pack ID set mismatch');
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 8;
  for (const expectedId of ids) {
    if (offset + 6 > bytes.length) throw new Error('Truncated simulation pack header');
    const idLength = view.getUint16(offset, true), dataLength = view.getUint32(offset + 2, true);
    offset += 6;
    if (offset + idLength + dataLength > bytes.length) throw new Error('Truncated simulation pack file');
    const id = decoder.decode(bytes.subarray(offset, offset + idLength));
    offset += idLength;
    if (id !== expectedId) throw new Error(`Simulation pack ID set mismatch: ${id}`);
    const data = bytes.subarray(offset, offset + dataLength), entry = manifest.files[id]!;
    offset += dataLength;
    if (data.length !== entry.bytes || await sha256(data) !== entry.sha256) throw new Error(`Simulation content identity mismatch: ${id}`);
    files.set(id, data);
  }
  if (offset !== bytes.length) throw new Error('Trailing simulation pack bytes');
  return files;
}

export function loadSimulationPack(map: string | null, signal?: AbortSignal): Promise<ReadonlyMap<string, Uint8Array>> {
  let request = packs.get(map);
  if (!request) {
    request = Promise.all([loadContentIndex(), loadSimulationManifest()]).then(async ([index, manifest]) => {
      if (index.simContentSha256 !== manifest.sha256) throw new Error('Simulation index content-set identity mismatch');
      if (map === null) return verifySimulationPack(await sessionBytes(contentUrl(index.simPack.path)), manifest, null, index.simPack);
      const entry = index.maps[map], selected = `maps/${map.toLowerCase()}.pms`;
      if (!entry) throw new Error(`Map absent from content index: ${map}`);
      if (entry.simContentSha256 !== manifest.sha256) throw new Error('Simulation index content-set identity mismatch');
      if (entry.mapSha256 !== manifest.files[selected]?.sha256) throw new Error('Simulation index map identity mismatch');
      return verifySimulationPack(await sessionBytes(contentUrl(entry.simPack.path)), manifest, selected, entry.simPack);
    }).catch(error => { packs.delete(map); throw error; });
    packs.set(map, request);
  }
  return sessionResult(request, signal);
}

export async function mountSimulationPack(host: SimHost, map: string | null, signal?: AbortSignal): Promise<void> {
  const files = await loadSimulationPack(map, signal);
  signal?.throwIfAborted();
  for (const [id, data] of files) requireStatus(host.putFile(id, data), `sim_vfs_put(${id})`);
}
