import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256, type SimManifest } from '@soldat-web/sim-host';
import { verifySimulationPack } from './sim-content';

const encoder = new TextEncoder();
async function fixture() {
  const data: Record<string, Uint8Array> = {
    'bots/admiral.bot': encoder.encode('bot'),
    'maps/arena.pms': encoder.encode('arena'),
    'maps/airpirates.pms': encoder.encode('airpirates'),
    'weapons.ini': encoder.encode('weapons'),
  };
  const files: SimManifest['files'] = {};
  for (const [id, bytes] of Object.entries(data)) files[id] = { path: `sim/${id}`, object: `sim/${id}`, bytes: bytes.length, sha256: await sha256(bytes) };
  const manifest: SimManifest = { schemaVersion: 1, files, sha256: await sha256(encoder.encode(Object.keys(files).sort().map(id => `${id}\t${files[id]!.sha256}\n`).join(''))) };
  return { manifest, data };
}
function pack(data: Record<string, Uint8Array>, ids: string[]) {
  const bytes = new Uint8Array(8 + ids.reduce((total, id) => total + 6 + encoder.encode(id).length + data[id]!.length, 0));
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode('SPK1')); view.setUint32(4, ids.length, true);
  let offset = 8;
  for (const id of ids) {
    const name = encoder.encode(id), file = data[id]!;
    view.setUint16(offset, name.length, true); view.setUint32(offset + 2, file.length, true); offset += 6;
    bytes.set(name, offset); offset += name.length;
    bytes.set(file, offset); offset += file.length;
  }
  return bytes;
}
async function verify(bytes: Uint8Array, manifest: SimManifest, selected: string | null = 'maps/arena.pms') {
  return verifySimulationPack(bytes, manifest, selected, { bytes: bytes.length, sha256: await sha256(bytes) });
}

test('selected packs contain exactly core plus selected map; full packs retain server VFS identity', async () => {
  const { manifest, data } = await fixture();
  const selected = Object.keys(data).filter(id => id !== 'maps/airpirates.pms').sort();
  const decoded = await verify(pack(data, selected), manifest);
  assert.deepEqual([...decoded.keys()], selected);
  for (const id of selected) assert.deepEqual(decoded.get(id), data[id]);
  const all = Object.keys(data).sort();
  assert.deepEqual([...(await verify(pack(data, all), manifest, null)).keys()], all);
});

test('pack hash, raw file hashes, exact ID set, canonical ordering and framing are enforced', async () => {
  const { manifest, data } = await fixture();
  const ids = Object.keys(data).filter(id => id !== 'maps/airpirates.pms').sort();
  const bytes = pack(data, ids);
  await assert.rejects(verifySimulationPack(bytes, manifest, 'maps/arena.pms', { bytes: bytes.length, sha256: '0'.repeat(64) }), /pack identity/);
  await assert.rejects(verifySimulationPack(bytes, manifest, 'maps/arena.pms', { bytes: bytes.length + 1, sha256: await sha256(bytes) }), /pack identity/);
  await assert.rejects(verify(pack(data, ids.slice(1)), manifest), /ID set/);
  await assert.rejects(verify(pack(data, Object.keys(data).sort()), manifest), /ID set/);
  await assert.rejects(verify(pack(data, [...ids].reverse()), manifest), /ID set/);
  await assert.rejects(verify(pack(data, [ids[0]!, ids[0]!, ids[2]!]), manifest), /ID set/);
  const corrupt = bytes.slice(); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  await assert.rejects(verify(corrupt, manifest), /content identity/);
  await assert.rejects(verify(bytes.slice(0, -1), manifest), /Truncated/);
  const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
  await assert.rejects(verify(trailing, manifest), /Trailing/);
  const magic = bytes.slice(); magic[0] = 0;
  await assert.rejects(verify(magic, manifest), /magic/);
});
