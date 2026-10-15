import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GifWriter } from 'omggif';
import { zipSync, zlibSync } from 'fflate';
import { ContentError } from './errors.ts';
import { applyGreenKey, convertWav, decodeImage, encodePng, importImage, parseWav, readZip } from './media.ts';

const base = fileURLToPath(new URL('../../../reference/base/', import.meta.url));
async function corpusFiles(directory: string, extensions: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await corpusFiles(path, extensions));
    else if (extensions.some(extension => entry.name.toLowerCase().endsWith(extension))) found.push(path);
  }
  return found;
}

function bmp(width: number, height: number, pixels: number[], topDown = false, depth = 24): Uint8Array {
  const stride = Math.ceil(width * depth / 32) * 4;
  const bytes = new Uint8Array(54 + stride * height), view = new DataView(bytes.buffer);
  bytes.set([66, 77]); view.setUint32(2, bytes.length, true); view.setUint32(10, 54, true);
  view.setUint32(14, 40, true); view.setInt32(18, width, true); view.setInt32(22, topDown ? -height : height, true);
  view.setUint16(26, 1, true); view.setUint16(28, depth, true);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4;
    const target = 54 + (topDown ? y : height - y - 1) * stride + x * depth / 8;
    bytes[target] = pixels[source + 2]!; bytes[target + 1] = pixels[source + 1]!;
    bytes[target + 2] = pixels[source]!;
    if (depth === 32) bytes[target + 3] = pixels[source + 3]!;
  }
  return bytes;
}
function testCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(tag: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + data.length), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length); bytes.set(new TextEncoder().encode(tag), 4); bytes.set(data, 8);
  view.setUint32(bytes.length - 4, testCrc(bytes.subarray(4, bytes.length - 4)));
  return bytes;
}
function pngFixture(colorType: number, depth: number, scanline: number[], extras: Uint8Array[] = [], interlace = 0): Uint8Array {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, 1); view.setUint32(4, 1); header[8] = depth; header[9] = colorType; header[12] = interlace;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), ...extras,
    pngChunk('IDAT', zlibSync(new Uint8Array(scanline))), pngChunk('IEND', new Uint8Array())];
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function gifFixture(): Uint8Array {
  const bytes = new Uint8Array(1024);
  const writer = new GifWriter(bytes, 2, 1, { palette: [0, 0xff0000, 0x00ff00, 0x0000ff] });
  writer.addFrame(0, 0, 2, 1, [1, 1], { delay: 3, transparent: 0, disposal: 1 });
  writer.addFrame(0, 0, 1, 1, [2], { delay: 5, transparent: 0, disposal: 3 });
  writer.addFrame(1, 0, 1, 1, [3], { delay: 7, transparent: 0, disposal: 2 });
  writer.addFrame(0, 0, 1, 1, [0], { delay: 9, transparent: 0, disposal: 1 });
  return bytes.subarray(0, writer.end());
}

function adpcmFixture(channels = 1, fact = 4): Uint8Array {
  const blockAlign = channels * 7 + 1;
  const samplesPerBlock = 2 + 2 / channels;
  const bytes = new Uint8Array(8 + 4 + 8 + 26 + 8 + 4 + 8 + blockAlign + (blockAlign & 1));
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF')); view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8); view.setUint32(16, 26, true);
  view.setUint16(20, 2, true); view.setUint16(22, channels, true); view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 4, true);
  view.setUint16(36, 8, true); view.setUint16(38, samplesPerBlock, true); view.setUint16(40, 1, true);
  view.setInt16(42, 256, true); view.setInt16(44, 0, true);
  bytes.set(new TextEncoder().encode('fact'), 46); view.setUint32(50, 4, true); view.setUint32(54, fact, true);
  bytes.set(new TextEncoder().encode('data'), 58); view.setUint32(62, blockAlign, true);
  let p = 66 + channels;
  for (let channel = 0; channel < channels; channel++, p += 2) view.setUint16(p, 16, true);
  for (let channel = 0; channel < channels; channel++, p += 2) view.setInt16(p, channel ? -100 : 100, true);
  for (let channel = 0; channel < channels; channel++, p += 2) view.setInt16(p, channel ? -90 : 90, true);
  bytes[p] = 0x1f;
  return bytes;
}
function pcmSamples(bytes: Uint8Array): number[] {
  const metadata = parseWav(bytes), values: number[] = [];
  for (const data of metadata.dataChunks) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let p = 0; p < data.length; p += 2) values.push(view.getInt16(p, true));
  }
  return values;
}

// Corpus checks are intentionally explicit: changing a decoder must continue to
// accept original assets, including deliberately misleading filename extensions.
describe('image compatibility', () => {
  test('all 1066 corpus images decode to bounded RGBA', async () => {
    const files = await corpusFiles(base, ['.png', '.bmp', '.gif']);
    expect(files.length).toBe(1066);
    for (const file of files) {
      const decoded = decodeImage(await readFile(file));
      expect(decoded.width).toBeGreaterThan(0); expect(decoded.height).toBeGreaterThan(0);
      for (const frame of decoded.frames) expect(frame.rgba.length).toBe(decoded.width * decoded.height * 4);
    }
  }, 120000);

  test('terrain retains opaque green; sprite keys only exact opaque green', () => {
    const rgba = new Uint8Array([0, 255, 0, 255, 0, 255, 0, 128, 1, 255, 0, 255]);
    const bytes = encodePng(3, 1, rgba);
    const terrain = importImage(bytes, { terrain: true }), sprite = importImage(bytes, { terrain: false });
    expect(terrain.keyed).toBe(false); expect(Array.from(terrain.frames[0]!.rgba)).toEqual(Array.from(rgba));
    expect(sprite.keyed).toBe(true);
    expect(Array.from(sprite.frames[0]!.rgba)).toEqual([0, 255, 0, 0, 0, 255, 0, 128, 1, 255, 0, 255]);
    expect(Array.from(rgba)).toEqual([0, 255, 0, 255, 0, 255, 0, 128, 1, 255, 0, 255]);
    expect(Array.from(applyGreenKey(rgba))).toEqual(Array.from(sprite.frames[0]!.rgba));
  });

  test('explicit opaque black sprite key does not key green', () => {
    const bytes = encodePng(2, 1, new Uint8Array([0, 0, 0, 255, 0, 255, 0, 255]));
    expect(Array.from(importImage(bytes, { terrain: false, colorKey: [0, 0, 0, 255] }).frames[0]!.rgba))
      .toEqual([0, 0, 0, 0, 0, 255, 0, 255]);
  });

  test('PNG encoding preserves straight semi-transparent channels', () => {
    const rgba = new Uint8Array([200, 100, 50, 64]);
    expect(Array.from(decodeImage(encodePng(1, 1, rgba)).frames[0]!.rgba)).toEqual(Array.from(rgba));
  });

  test('PNG grayscale, RGB, indexed tRNS, grayscale alpha, RGBA and Adam7 decode', () => {
    const fixtures: [Uint8Array, number[]][] = [
      [pngFixture(0, 1, [0, 0x80]), [255, 255, 255, 255]],
      [pngFixture(2, 8, [0, 20, 40, 60]), [20, 40, 60, 255]],
      [pngFixture(3, 1, [0, 0], [pngChunk('PLTE', new Uint8Array([30, 60, 90, 0, 0, 0])),
        pngChunk('tRNS', new Uint8Array([128, 255]))]), [30, 60, 90, 128]],
      [pngFixture(4, 8, [0, 80, 128]), [80, 80, 80, 128]],
      [pngFixture(6, 8, [0, 20, 40, 60, 128]), [20, 40, 60, 128]],
      [pngFixture(6, 8, [0, 20, 40, 60, 128], [], 1), [20, 40, 60, 128]],
    ];
    for (const [bytes, expected] of fixtures) expect(Array.from(decodeImage(bytes).frames[0]!.rgba)).toEqual(expected);
  });

  test('BMP padding, bottom-up and top-down orientation, BGR(A)', () => {
    const rgba = [255, 0, 0, 255, 0, 0, 255, 255];
    for (const topDown of [false, true])
      expect(Array.from(decodeImage(bmp(1, 2, rgba, topDown)).frames[0]!.rgba)).toEqual(rgba);
    const translucent = [10, 20, 30, 128, 40, 50, 60, 0];
    expect(Array.from(decodeImage(bmp(1, 2, translucent, false, 32)).frames[0]!.rgba)).toEqual(translucent);
    expect(Array.from(decodeImage(bmp(1, 1, [1, 2, 3, 0], false, 32)).frames[0]!.rgba)).toEqual([1, 2, 3, 255]);
  });

  test('indexed BMP8 honors palette entries and row padding', () => {
    const bytes = new Uint8Array(66), view = new DataView(bytes.buffer);
    bytes.set([66, 77]); view.setUint32(2, bytes.length, true); view.setUint32(10, 62, true);
    view.setUint32(14, 40, true); view.setInt32(18, 1, true); view.setInt32(22, 1, true);
    view.setUint16(26, 1, true); view.setUint16(28, 8, true); view.setUint32(46, 2, true);
    bytes.set([0, 0, 0, 0, 30, 20, 10, 0], 54); bytes[62] = 1;
    expect(Array.from(decodeImage(bytes).frames[0]!.rgba)).toEqual([10, 20, 30, 255]);
  });

  test('GIF composes partial frames and restores previous/background with native delays', () => {
    const gif = importImage(gifFixture(), { terrain: false });
    expect(gif.keyed).toBe(false);
    expect(gif.frames.map(frame => [frame.delayMs, frame.delayTicks])).toEqual([[30, 3], [50, 5], [70, 7], [90, 9]]);
    expect(gif.frames.map(frame => Array.from(frame.rgba))).toEqual([
      [255, 0, 0, 255, 255, 0, 0, 255],
      [0, 255, 0, 255, 255, 0, 0, 255],
      [255, 0, 0, 255, 0, 0, 255, 255],
      [255, 0, 0, 255, 0, 0, 0, 0],
    ]);
  });

  test('signature and dimension failures are typed before decoding', () => {
    expect(() => decodeImage(new Uint8Array([1, 2, 3]))).toThrow(ContentError);
    const bytes = bmp(1, 1, [0, 0, 0, 255]); new DataView(bytes.buffer).setInt32(18, 8193, true);
    expect(() => decodeImage(bytes)).toThrow(ContentError);
    expect(() => encodePng(1, 1, new Uint8Array(3))).toThrow(ContentError);
  });
});

describe('WAV compatibility', () => {
  test('all 164 corpus sounds convert or preserve PCM bytes', async () => {
    const files = await corpusFiles(base, ['.wav']);
    expect(files.length).toBe(164);
    let conversions = 0;
    for (const file of files) {
      const bytes = await readFile(file), metadata = parseWav(bytes), converted = convertWav(bytes);
      expect(converted.sampleRate).toBe(metadata.sampleRate); expect(converted.channels).toBe(metadata.channels);
      expect(converted.sampleCount).toBe(metadata.sampleCount);
      expect(parseWav(converted.bytes).format).toBe(1);
      if (converted.converted) conversions++;
      else expect(converted.bytes).toBe(bytes);
    }
    expect(conversions).toBe(1);
  });

  test('jump.wav honors fact count instead of padded ADPCM block capacity', async () => {
    const bytes = await readFile(`${base}/shared/sfx/jump.wav`);
    const source = parseWav(bytes), converted = convertWav(bytes), pcm = parseWav(converted.bytes);
    expect(source.format).toBe(2); expect(source.samplesPerBlock).toBe(1012);
    expect(source.factSampleCount).toBe(8351); expect(converted.sampleCount).toBe(8351);
    expect(converted.durationSeconds).toBeCloseTo(8351 / 22050, 12);
    expect(pcm.sampleCount).toBe(8351); expect(pcm.dataBytes).toBe(16702);
    expect(converted.bytes.length).toBe(16746);
  });

  test('MS ADPCM emits sample2/sample1 then high/low nibbles', () => {
    const converted = convertWav(adpcmFixture());
    expect(pcmSamples(converted.bytes)).toEqual([90, 100, 116, 100]);
    expect(converted.durationSeconds).toBe(4 / 8000);
    expect(pcmSamples(convertWav(adpcmFixture(1, 3)).bytes)).toEqual([90, 100, 116]);
  });

  test('MS ADPCM stereo nibble order and channel state remain independent', () => {
    const converted = convertWav(adpcmFixture(2, 3));
    expect(pcmSamples(converted.bytes)).toEqual([90, -90, 100, -100, 116, -116]);
    expect(converted.sampleCount).toBe(3); expect(converted.channels).toBe(2);
  });

  test('MS ADPCM uses file coefficients, adaptation table and saturation', () => {
    const custom = adpcmFixture(), customView = new DataView(custom.buffer);
    customView.setInt16(42, 512, true); customView.setInt16(44, -256, true);
    expect(pcmSamples(convertWav(custom).bytes)).toEqual([90, 100, 126, 136]);
    const extended = new Uint8Array(76); extended.set(adpcmFixture());
    const view = new DataView(extended.buffer);
    view.setUint32(4, 68, true); view.setUint16(32, 9, true); view.setUint16(38, 6, true);
    view.setUint32(54, 6, true); view.setUint32(62, 9, true); extended[73] = 0x71; extended[74] = 0x81;
    expect(pcmSamples(convertWav(extended).bytes)).toEqual([90, 100, 212, 250, -22, 80]);
    const saturated = adpcmFixture(), saturatedView = new DataView(saturated.buffer);
    saturatedView.setInt16(69, 32760, true); saturatedView.setInt16(71, 32760, true); saturated[73] = 0x77;
    expect(pcmSamples(convertWav(saturated).bytes)).toEqual([32760, 32760, 32767, 32767]);
  });

  test('invalid predictor, fact count and truncated RIFF are typed errors', () => {
    const badPredictor = adpcmFixture(); badPredictor[66] = 1;
    expect(() => convertWav(badPredictor)).toThrow(ContentError);
    expect(() => convertWav(adpcmFixture(1, 5))).toThrow(ContentError);
    expect(() => parseWav(adpcmFixture().subarray(0, 20))).toThrow(ContentError);
  });
});

describe('bounded ZIP', () => {
  test('reads stored and deflated bytes, excluding directories', () => {
    const bytes = zipSync({ 'textures/': new Uint8Array(), 'textures/a.bin': [new Uint8Array([1, 2]), { level: 0 }],
      'sfx/b.bin': new Uint8Array([3, 4, 5]) });
    const files = readZip(bytes);
    expect([...files.keys()]).toEqual(['textures/a.bin', 'sfx/b.bin']);
    expect(Array.from(files.get('textures/a.bin')!)).toEqual([1, 2]);
    expect(Array.from(files.get('sfx/b.bin')!)).toEqual([3, 4, 5]);
  });

  test('reads original classic.smod', async () => {
    const files = readZip(await readFile(`${base}/client/mods/classic.smod`));
    expect(files.size).toBeGreaterThan(0);
    expect([...files.keys()].every(name => name.startsWith('classic/'))).toBe(true);
  });

  test('rejects traversal, absolute, drive paths and case collisions', () => {
    for (const name of ['../bad', '/bad', 'C:/bad', 'a/../bad', 'a\\..\\bad'])
      expect(() => readZip(zipSync({ [name]: new Uint8Array([1]) }))).toThrow(ContentError);
    expect(() => readZip(zipSync({ 'A.txt': new Uint8Array(), 'a.txt': new Uint8Array() }))).toThrow(ContentError);
    expect(() => readZip(zipSync({ a: new Uint8Array(), 'a/b': new Uint8Array() }))).toThrow(ContentError);
  });

  test('preflight checks all entry and aggregate size limits', () => {
    const bytes = zipSync({ a: new Uint8Array(10), b: new Uint8Array(20) });
    expect(() => readZip(bytes, { maxEntries: 1 })).toThrow(ContentError);
    expect(() => readZip(bytes, { maxCompressedBytes: bytes.length - 1 })).toThrow(ContentError);
    expect(() => readZip(bytes, { maxUncompressedBytes: 29 })).toThrow(ContentError);
    expect(() => readZip(bytes, { maxEntryUncompressedBytes: 19 })).toThrow(ContentError);
    expect(() => readZip(bytes, { maxEntryCompressedBytes: 0 })).toThrow(ContentError);
  });

  test('verifies CRC and rejects understated deflate sizes without unbounded allocation', () => {
    const bytes = zipSync({ a: new Uint8Array(100).fill(7) });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let central = -1;
    for (let p = 0; p + 46 <= bytes.length; p++) if (view.getUint32(p, true) === 0x02014b50) { central = p; break; }
    expect(central).toBeGreaterThan(0);
    const badCrc = bytes.slice(), crcView = new DataView(badCrc.buffer);
    crcView.setUint32(14, 0, true); crcView.setUint32(central + 16, 0, true);
    expect(() => readZip(badCrc)).toThrow(ContentError);
    view.setUint32(22, 1, true); view.setUint32(central + 24, 1, true);
    expect(() => readZip(bytes)).toThrow(ContentError);
  });
});
