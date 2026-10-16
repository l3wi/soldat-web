import { describe, expect, test } from 'bun:test';
import { ContentError } from './errors.ts';
import { encodeSimPack } from './packs.ts';

export function unpackForTest(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder();
  expect(decoder.decode(bytes.subarray(0, 4))).toBe('SPK1');
  const entries = new Map<string, Uint8Array>();
  let offset = 8;
  for (let i = 0; i < view.getUint32(4, true); i++) {
    const idBytes = view.getUint16(offset, true), dataBytes = view.getUint32(offset + 2, true); offset += 6;
    const id = decoder.decode(bytes.subarray(offset, offset + idBytes)); offset += idBytes;
    expect(entries.has(id)).toBe(false);
    entries.set(id, bytes.subarray(offset, offset + dataBytes)); offset += dataBytes;
  }
  expect(offset).toBe(bytes.length);
  return entries;
}

describe('SPK1 simulation transport', () => {
  test('selected-map pack contains sorted canonical IDs and exact unmodified bytes', () => {
    const files = new Map<string, Uint8Array>();
    files.set('maps/bravo.pms', new Uint8Array([99]));
    files.set('mod.ini', new Uint8Array([13, 10, 0, 255]));
    files.set('maps/alpha.pms', new Uint8Array([7, 8, 9, 0]));
    files.set('bots/sgt. mac.bot', new Uint8Array([192, 128]));
    const bytes = encodeSimPack(files, 'maps/alpha.pms'), decoded = unpackForTest(bytes);
    expect([...decoded.keys()]).toEqual(['bots/sgt. mac.bot', 'maps/alpha.pms', 'mod.ini']);
    for (const [id, data] of decoded) expect(data).toEqual(files.get(id)!);
    const reversed = new Map([...files].reverse());
    expect(encodeSimPack(reversed, 'maps/alpha.pms')).toEqual(bytes);
  });

  test('complete pack contains every manifest ID including every map', () => {
    const files = new Map([['maps/a.pms', new Uint8Array([1])], ['maps/b.pms', new Uint8Array([2])], ['mod.ini', new Uint8Array([3])]]);
    expect(unpackForTest(encodeSimPack(files))).toEqual(files);
  });

  test('UTF-8 byte length is independent of JavaScript string length', () => {
    const files = new Map([['maps/é.pms', new Uint8Array([255])]]);
    const bytes = encodeSimPack(files, 'maps/é.pms');
    expect(new DataView(bytes.buffer).getUint16(8, true)).toBe(new TextEncoder().encode('maps/é.pms').length);
    expect(unpackForTest(bytes).get('maps/é.pms')).toEqual(new Uint8Array([255]));
  });

  test('missing maps, noncanonical IDs, and unsafe paths fail', () => {
    expect(() => encodeSimPack(new Map(), 'maps/missing.pms')).toThrow(ContentError);
    expect(() => encodeSimPack(new Map([['maps/A.pms', new Uint8Array()]]), 'maps/A.pms')).toThrow(ContentError);
    expect(() => encodeSimPack(new Map([['../mod.ini', new Uint8Array()]]))).toThrow(ContentError);
  });
});
