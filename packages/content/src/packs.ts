import { ContentError } from './errors.ts';
import { canonicalPath } from './paths.ts';

/** SPK1 is a transport envelope only: each payload remains the original simulation bytes. */
export function encodeSimPack(files: ReadonlyMap<string, Uint8Array>, mapId?: string): Uint8Array {
  if (mapId !== undefined && (canonicalPath(mapId) !== mapId || !/^maps\/[^/]+\.pms$/.test(mapId) || !files.has(mapId)))
    throw new ContentError('SIM_PACK_MAP', `Missing or noncanonical map ID: ${mapId}`);
  const encoder = new TextEncoder();
  const entries = [...files.keys()].filter(id => mapId === undefined || !id.startsWith('maps/') || id === mapId).sort().map(id => {
    if (canonicalPath(id) !== id) throw new ContentError('SIM_PACK_ID', `Noncanonical simulation ID: ${id}`);
    const name = encoder.encode(id), data = files.get(id)!;
    if (name.length > 0xffff || data.length > 0xffffffff) throw new ContentError('SIM_PACK_SIZE', `Oversized pack entry: ${id}`);
    return { name, data };
  });
  const size = 8 + entries.reduce((total, entry) => total + 6 + entry.name.length + entry.data.length, 0);
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  bytes.set([83, 80, 75, 49]); view.setUint32(4, entries.length, true);
  let offset = 8;
  for (const { name, data } of entries) {
    view.setUint16(offset, name.length, true); view.setUint32(offset + 2, data.length, true); offset += 6;
    bytes.set(name, offset); offset += name.length;
    bytes.set(data, offset); offset += data.length;
  }
  return bytes;
}
