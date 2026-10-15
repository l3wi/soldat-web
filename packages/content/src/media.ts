import { Buffer } from 'node:buffer';
import { PNG } from 'pngjs';
import { GifReader } from 'omggif';
import { inflateSync, unzlibSync } from 'fflate';
import { BinaryReader } from './binary.ts';
import { ContentError } from './errors.ts';

const MAX_DIMENSION = 8192;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface ImageFrame {
  rgba: Uint8Array;
  delayMs: number;
  /** Native Soldat delay units: milliseconds divided by ten, not simulation ticks. */
  delayTicks: number;
}
export interface DecodedImage {
  width: number;
  height: number;
  format: 'png' | 'bmp' | 'gif';
  frames: ImageFrame[];
}
export interface ImportedImage extends DecodedImage { keyed: boolean }
export interface ImportImageOptions {
  terrain: boolean;
  colorKey?: readonly [number, number, number, number];
}

function fail(code: string, message: string, offset?: number): never {
  throw new ContentError(code, message, offset);
}
function dimensions(width: number, height: number, frames = 1): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_DIMENSION || height > MAX_DIMENSION)
    fail('IMAGE_DIMENSIONS', `Image dimensions ${width}×${height} exceed 1..${MAX_DIMENSION}`);
  const size = width * height * 4;
  if (!Number.isSafeInteger(frames) || frames < 1 || size * frames > MAX_DECODED_BYTES)
    fail('IMAGE_LIMIT', 'Decoded image exceeds 256 MiB');
  return size;
}
function ascii(bytes: Uint8Array, start: number, length: number): string {
  let value = '';
  for (let i = start; i < start + length; i++) value += String.fromCharCode(bytes[i]!);
  return value;
}
function checked<T>(code: string, operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof ContentError) throw error;
    return fail(code, error instanceof Error ? error.message : String(error));
  }
}

function decodePng(bytes: Uint8Array): DecodedImage {
  const r = new BinaryReader(bytes, 'PNG');
  r.need(33);
  if (r.view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR')
    fail('PNG_HEADER', 'PNG must begin with a 13-byte IHDR');
  const width = r.view.getUint32(16), height = r.view.getUint32(20);
  dimensions(width, height);
  // pngjs bounds noninterlaced inflation itself. Its interlaced path does not;
  // preflight that stream with a fixed output buffer before handing it over.
  if (bytes[28] === 1) {
    const channels = [1, 0, 3, 1, 2, 0, 4][bytes[25]!] ?? 0;
    const depth = bytes[24]!;
    if (!channels || ![1, 2, 4, 8, 16].includes(depth)) fail('PNG_HEADER', 'Invalid PNG pixel layout');
    const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
    let expected = 0;
    for (const [x, y, dx, dy] of passes) {
      const w = Math.max(0, Math.ceil((width - x) / dx));
      const h = Math.max(0, Math.ceil((height - y) / dy));
      if (w && h) expected += h * (1 + Math.ceil(w * channels * depth / 8));
    }
    const chunks: Uint8Array[] = [];
    let compressedSize = 0;
    r.p = 8;
    while (r.p < bytes.length) {
      r.need(12);
      const length = r.view.getUint32(r.p), tag = ascii(bytes, r.p + 4, 4);
      r.skip(8); r.need(length + 4);
      if (tag === 'IDAT') { chunks.push(bytes.subarray(r.p, r.p + length)); compressedSize += length; }
      r.skip(length + 4);
      if (tag === 'IEND') break;
    }
    const compressed = new Uint8Array(compressedSize);
    let offset = 0;
    for (const chunk of chunks) { compressed.set(chunk, offset); offset += chunk.length; }
    const inflated = unzlibSync(compressed, { out: new Uint8Array(expected + 1) });
    if (inflated.length !== expected) fail('PNG_DATA', 'PNG scanline size does not match dimensions');
  }
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { checkCRC: true });
  if (png.data.length !== width * height * 4) fail('PNG_DATA', 'Unexpected PNG pixel size');
  return { width, height, format: 'png', frames: [{ rgba: png.data, delayMs: 0, delayTicks: 0 }] };
}

function decodeBmp(bytes: Uint8Array): DecodedImage {
  const r = new BinaryReader(bytes, 'BMP');
  r.need(54);
  const offset = r.view.getUint32(10, true), headerSize = r.view.getUint32(14, true);
  if (headerSize < 40 || headerSize > bytes.length - 14) fail('BMP_HEADER', 'Unsupported BMP header');
  const width = r.view.getInt32(18, true), storedHeight = r.view.getInt32(22, true);
  const height = Math.abs(storedHeight), size = dimensions(width, height);
  const depth = r.view.getUint16(28, true), compression = r.view.getUint32(30, true);
  if (r.view.getUint16(26, true) !== 1 || ![8, 24, 32].includes(depth) || compression !== 0)
    fail('BMP_FORMAT', 'Only uncompressed indexed 8-bit, 24-bit, and 32-bit BMP images are supported');
  const stride = Math.ceil(width * depth / 32) * 4;
  if (offset < 14 + headerSize || offset > bytes.length || stride * height > bytes.length - offset)
    fail('BMP_DATA', 'BMP pixels are truncated or overlap the header', offset);
  const paletteSize = depth === 8 ? r.view.getUint32(46, true) || 256 : 0;
  const paletteOffset = 14 + headerSize;
  if (paletteSize > 256 || paletteOffset + paletteSize * 4 > offset)
    fail('BMP_PALETTE', 'BMP palette is truncated or overlaps pixels');
  const rgba = new Uint8Array(size);
  let hasAlpha = false;
  for (let y = 0; y < height; y++) {
    const sourceY = storedHeight < 0 ? y : height - 1 - y;
    let source = offset + sourceY * stride, target = y * width * 4;
    for (let x = 0; x < width; x++) {
      const index = depth === 8 ? bytes[source]! : 0;
      if (depth === 8 && index >= paletteSize) fail('BMP_PALETTE', 'BMP pixel exceeds palette');
      const color = depth === 8 ? paletteOffset + index * 4 : source;
      rgba[target] = bytes[color + 2]!;
      rgba[target + 1] = bytes[color + 1]!;
      rgba[target + 2] = bytes[color]!;
      const alpha = depth === 32 ? bytes[color + 3]! : 255;
      rgba[target + 3] = alpha; hasAlpha ||= alpha !== 0;
      source += depth / 8; target += 4;
    }
  }
  // BI_RGB's fourth byte is often unused. Match stb: an entirely zero alpha
  // plane is opaque; otherwise retain the alpha values, including zeroes.
  if (depth === 32 && !hasAlpha) for (let p = 3; p < size; p += 4) rgba[p] = 255;
  return { width, height, format: 'bmp', frames: [{ rgba, delayMs: 0, delayTicks: 0 }] };
}

interface GifControl { delay: number; disposal: number; transparent: number | null }
function decodeGif(bytes: Uint8Array): DecodedImage {
  const r = new BinaryReader(bytes, 'GIF');
  r.need(13);
  const width = r.view.getUint16(6, true), height = r.view.getUint16(8, true);
  const size = dimensions(width, height), packed = bytes[10]!;
  const globalColors = packed & 128 ? 1 << ((packed & 7) + 1) : 0;
  r.p = 13; r.skip(globalColors * 3);
  const controls: GifControl[] = [];
  let control: GifControl = { delay: 0, disposal: 0, transparent: null }, ended = false;
  const subblocks = (): void => {
    for (let length = r.u8(); length; length = r.u8()) r.skip(length);
  };
  while (r.p < bytes.length) {
    const marker = r.u8();
    if (marker === 0x3b) { ended = true; break; }
    if (marker === 0x21) {
      const label = r.u8();
      if (label === 0xf9) {
        if (r.u8() !== 4) fail('GIF_CONTROL', 'Invalid GIF graphics control size', r.p - 1);
        const flags = r.u8(), delay = r.u16(), index = r.u8();
        if (r.u8() !== 0 || ((flags >> 2) & 7) > 3) fail('GIF_CONTROL', 'Invalid GIF disposal or terminator');
        control = { delay, disposal: (flags >> 2) & 7, transparent: flags & 1 ? index : null };
      } else {
        subblocks();
        if (label === 1) control = { delay: 0, disposal: 0, transparent: null };
      }
    } else if (marker === 0x2c) {
      const x = r.u16(), y = r.u16(), w = r.u16(), h = r.u16(), flags = r.u8();
      if (!w || !h || x + w > width || y + h > height) fail('GIF_FRAME', 'GIF frame is outside its logical screen');
      const colors = flags & 128 ? 1 << ((flags & 7) + 1) : globalColors;
      if (!colors || (control.transparent !== null && control.transparent >= colors))
        fail('GIF_PALETTE', 'Invalid GIF palette or transparent index');
      if (flags & 128) r.skip(colors * 3);
      const codeSize = r.u8();
      if (codeSize < 2 || codeSize > 8) fail('GIF_LZW', 'Invalid GIF LZW code size');
      subblocks(); controls.push(control); dimensions(width, height, controls.length);
      control = { delay: 0, disposal: 0, transparent: null };
    } else fail('GIF_BLOCK', 'Invalid GIF block', r.p - 1);
  }
  if (!ended || !controls.length) fail('GIF_DATA', 'GIF has no complete image stream');
  const reader = new GifReader(bytes);
  if (reader.numFrames() !== controls.length) fail('GIF_DATA', 'GIF frame directory mismatch');
  const canvas = new Uint8Array(size), frames: ImageFrame[] = [];
  const backgroundIndex = bytes[11]!;
  const background: readonly number[] = globalColors && backgroundIndex < globalColors
    ? [bytes[13 + backgroundIndex * 3]!, bytes[14 + backgroundIndex * 3]!, bytes[15 + backgroundIndex * 3]!, 255]
    : [0, 0, 0, 0];
  const fill = (x: number, y: number, w: number, h: number, color: readonly number[]): void => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const p = (row * width + col) * 4;
      for (let c = 0; c < 4; c++) canvas[p + c] = color[c]!;
    }
  };
  if (controls[0]!.transparent === null) fill(0, 0, width, height, background);
  for (let i = 0; i < controls.length; i++) {
    const info = reader.frameInfo(i), current = controls[i]!;
    // omggif retains control values when the next frame omits a GCE. The GIF
    // specification makes a control extension apply to one graphic only.
    info.transparent_index = current.transparent;
    const previous = current.disposal === 3 ? canvas.slice() : undefined;
    reader.decodeAndBlitFrameRGBA(i, canvas);
    frames.push({ rgba: canvas.slice(), delayMs: current.delay * 10, delayTicks: current.delay });
    if (current.disposal === 2)
      fill(info.x, info.y, info.width, info.height, current.transparent === null ? background : [0, 0, 0, 0]);
    else if (previous) canvas.set(previous);
  }
  return { width, height, format: 'gif', frames };
}

/** Sniffs signatures rather than trusting legacy, frequently incorrect extensions. */
export function decodeImage(bytes: Uint8Array): DecodedImage {
  return checked('IMAGE_DECODE', () => {
    if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return decodePng(bytes);
    if (bytes[0] === 66 && bytes[1] === 77) return decodeBmp(bytes);
    const header = ascii(bytes, 0, Math.min(6, bytes.length));
    if (header === 'GIF87a' || header === 'GIF89a') return decodeGif(bytes);
    return fail('IMAGE_SIGNATURE', 'Expected PNG, BMP, or GIF signature');
  });
}

/** Encodes straight (not premultiplied) RGBA8 without modifying source pixels. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  return checked('PNG_ENCODE', () => {
    if (rgba.length !== dimensions(width, height)) fail('IMAGE_PIXELS', 'RGBA byte count does not match dimensions');
    const png = new PNG();
    png.width = width; png.height = height; png.gamma = 0;
    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return PNG.sync.write(png, { colorType: 6, inputColorType: 6, inputHasAlpha: true, bitDepth: 8 });
  });
}
function applyColorKey(rgba: Uint8Array, key: readonly [number, number, number, number]): Uint8Array {
  if (rgba.length % 4) fail('IMAGE_PIXELS', 'RGBA byte count must be divisible by four');
  const result = rgba.slice();
  for (let p = 0; p < result.length; p += 4)
    if (result[p] === key[0] && result[p + 1] === key[1] && result[p + 2] === key[2] && result[p + 3] === key[3])
      result[p + 3] = 0;
  return result;
}
export function applyGreenKey(rgba: Uint8Array): Uint8Array { return applyColorKey(rgba, [0, 255, 0, 255]); }
export function importImage(bytes: Uint8Array, options: ImportImageOptions): ImportedImage {
  const image = decodeImage(bytes), keyed = !options.terrain && image.frames.length === 1;
  if (keyed) image.frames[0]!.rgba = applyColorKey(image.frames[0]!.rgba, options.colorKey ?? [0, 255, 0, 255]);
  return { ...image, keyed };
}

export interface WavMetadata {
  format: 1 | 2;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataBytes: number;
  /** Sample frames, not interleaved channel values. */
  sampleCount: number;
  durationSeconds: number;
  factSampleCount: number | null;
  samplesPerBlock: number | null;
  coefficients: readonly (readonly [number, number])[];
  dataChunks: readonly Uint8Array[];
}

/** Reads RIFF chunks with padding, including fmt extensions and fact sample count. */
export function parseWav(bytes: Uint8Array): WavMetadata {
  const r = new BinaryReader(bytes, 'WAV');
  r.need(12);
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') fail('WAV_SIGNATURE', 'Expected RIFF/WAVE');
  const end = r.view.getUint32(4, true) + 8;
  if (end < 12 || end > bytes.length) fail('WAV_SIZE', 'Invalid RIFF extent');
  let fmt: Uint8Array | undefined, factSampleCount: number | null = null, dataBytes = 0;
  const dataChunks: Uint8Array[] = [];
  r.p = 12;
  while (r.p < end) {
    if (end - r.p < 8) fail('WAV_CHUNK', 'Truncated WAV chunk header', r.p);
    const tag = ascii(bytes, r.p, 4), length = r.view.getUint32(r.p + 4, true);
    r.p += 8;
    if (length > end - r.p) fail('WAV_CHUNK', 'WAV chunk exceeds RIFF extent', r.p);
    const chunk = bytes.subarray(r.p, r.p + length);
    if (tag === 'fmt ') {
      if (fmt) fail('WAV_FORMAT', 'Duplicate WAV format chunk');
      fmt = chunk;
    } else if (tag === 'fact') {
      if (length < 4 || factSampleCount !== null) fail('WAV_FACT', 'Invalid or duplicate WAV fact chunk');
      factSampleCount = r.view.getUint32(r.p, true);
    } else if (tag === 'data') { dataChunks.push(chunk); dataBytes += length; }
    r.p += length + (length & 1);
    if (r.p > end) fail('WAV_CHUNK', 'Missing WAV chunk padding', r.p - 1);
  }
  if (!fmt || !dataChunks.length) fail('WAV_CHUNK', 'WAV requires fmt and data chunks');
  const f = new BinaryReader(fmt, 'WAV fmt');
  f.need(16);
  const format = f.u16(), channels = f.u16(), sampleRate = f.u32(), byteRate = f.u32();
  const blockAlign = f.u16(), bitsPerSample = f.u16();
  if ((format !== 1 && format !== 2) || channels < 1 || channels > 2 || !sampleRate || !blockAlign)
    fail('WAV_FORMAT', 'Expected mono/stereo PCM or Microsoft ADPCM WAV');
  let samplesPerBlock: number | null = null, sampleCount = 0;
  const coefficients: [number, number][] = [];
  if (format === 1) {
    if (![8, 16, 24, 32].includes(bitsPerSample) || blockAlign !== channels * bitsPerSample / 8 ||
        byteRate !== sampleRate * blockAlign || dataChunks.some(chunk => chunk.length % blockAlign !== 0))
      fail('WAV_PCM', 'Invalid PCM sample layout');
    sampleCount = dataBytes / blockAlign;
  } else {
    f.need(6);
    const extensionSize = f.u16();
    samplesPerBlock = f.u16();
    const coefficientCount = f.u16();
    if (bitsPerSample !== 4 || blockAlign < 7 * channels || extensionSize < 4 + coefficientCount * 4 ||
        fmt.length < 18 + extensionSize || !coefficientCount || coefficientCount > 256 ||
        samplesPerBlock !== 2 + (blockAlign - 7 * channels) * 2 / channels)
      fail('WAV_ADPCM', 'Invalid Microsoft ADPCM format extension');
    for (let i = 0; i < coefficientCount; i++) coefficients.push([f.i16(), f.i16()]);
    let capacity = 0;
    for (const chunk of dataChunks) {
      const full = Math.floor(chunk.length / blockAlign), remainder = chunk.length % blockAlign;
      capacity += full * samplesPerBlock;
      if (remainder) {
        if (remainder < channels * 7) fail('WAV_ADPCM', 'Truncated ADPCM block header');
        capacity += 2 + (remainder - channels * 7) * 2 / channels;
      }
    }
    if (factSampleCount !== null && factSampleCount > capacity) fail('WAV_FACT', 'WAV fact exceeds decodable samples');
    sampleCount = factSampleCount ?? capacity;
  }
  if (sampleCount * channels * (format === 2 ? 2 : bitsPerSample / 8) > MAX_DECODED_BYTES)
    fail('WAV_LIMIT', 'Decoded WAV exceeds 256 MiB');
  return { format, channels, sampleRate, byteRate, blockAlign, bitsPerSample, dataBytes, sampleCount,
    durationSeconds: sampleCount / sampleRate, factSampleCount, samplesPerBlock, coefficients, dataChunks };
}

const ADAPTATION = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230] as const;
export interface ConvertedWav {
  bytes: Uint8Array;
  converted: boolean;
  sampleCount: number;
  channels: number;
  sampleRate: number;
  durationSeconds: number;
}
export function convertWav(bytes: Uint8Array): ConvertedWav {
  const wav = parseWav(bytes);
  const metadata = { sampleCount: wav.sampleCount, channels: wav.channels, sampleRate: wav.sampleRate,
    durationSeconds: wav.durationSeconds };
  if (wav.format === 1) return { bytes, converted: false, ...metadata };
  const output = new Uint8Array(44 + wav.sampleCount * wav.channels * 2), view = new DataView(output.buffer);
  output.set([82, 73, 70, 70], 0); view.setUint32(4, output.length - 8, true);
  output.set([87, 65, 86, 69, 102, 109, 116, 32], 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, wav.channels, true);
  view.setUint32(24, wav.sampleRate, true); view.setUint32(28, wav.sampleRate * wav.channels * 2, true);
  view.setUint16(32, wav.channels * 2, true); view.setUint16(34, 16, true);
  output.set([100, 97, 116, 97], 36); view.setUint32(40, output.length - 44, true);
  let written = 0;
  const totalValues = wav.sampleCount * wav.channels;
  const emit = (sample: number): void => {
    if (written < totalValues) { view.setInt16(44 + written * 2, sample, true); written++; }
  };
  for (const chunk of wav.dataChunks) for (let start = 0; start < chunk.length; start += wav.blockAlign) {
    const block = new BinaryReader(chunk.subarray(start, Math.min(start + wav.blockAlign, chunk.length)), 'ADPCM block');
    block.need(7 * wav.channels);
    const predictor: number[] = [], delta: number[] = [], sample1: number[] = [], sample2: number[] = [];
    for (let channel = 0; channel < wav.channels; channel++) {
      const index = block.u8();
      if (index >= wav.coefficients.length) fail('WAV_ADPCM', 'ADPCM predictor exceeds coefficient table', start + channel);
      predictor.push(index);
    }
    for (let channel = 0; channel < wav.channels; channel++) delta.push(Math.max(16, block.u16()));
    for (let channel = 0; channel < wav.channels; channel++) sample1.push(block.i16());
    for (let channel = 0; channel < wav.channels; channel++) sample2.push(block.i16());
    for (const sample of sample2) emit(sample);
    for (const sample of sample1) emit(sample);
    const nibble = (value: number, channel: number): void => {
      const [a, b] = wav.coefficients[predictor[channel]!]!;
      const prediction = Math.trunc((sample1[channel]! * a + sample2[channel]! * b) / 256);
      const sample = Math.max(-32768, Math.min(32767, prediction + (value < 8 ? value : value - 16) * delta[channel]!));
      sample2[channel] = sample1[channel]!; sample1[channel] = sample;
      delta[channel] = Math.max(16, Math.floor(delta[channel]! * ADAPTATION[value]! / 256));
      emit(sample);
    };
    while (block.p < block.bytes.length) {
      const value = block.u8(); nibble(value >> 4, 0); nibble(value & 15, wav.channels - 1);
    }
  }
  if (written !== totalValues) fail('WAV_ADPCM', 'ADPCM sample count does not match decoded output');
  return { bytes: output, converted: true, ...metadata };
}

export interface ZipLimits {
  maxEntries?: number;
  maxCompressedBytes?: number;
  maxUncompressedBytes?: number;
  maxEntryCompressedBytes?: number;
  maxEntryUncompressedBytes?: number;
}
const DEFAULT_ZIP_LIMITS: Required<ZipLimits> = {
  maxEntries: 10000,
  maxCompressedBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxEntryCompressedBytes: 64 * 1024 * 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
};
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  CRC_TABLE[i] = crc >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function zipName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return checked('ZIP_NAME', () => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  let name = '';
  for (const byte of bytes) name += byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128]!;
  return name;
}
function safeZipPath(name: string): string {
  const path = name.replaceAll('\\', '/').normalize('NFC');
  if (!path || path.startsWith('/') || /[\x00-\x1f\x7f:]/.test(path)) fail('ZIP_PATH', `Unsafe ZIP path: ${JSON.stringify(name)}`);
  const segments = path.endsWith('/') ? path.slice(0, -1).split('/') : path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)))
    fail('ZIP_PATH', `Unsafe ZIP path: ${JSON.stringify(name)}`);
  return path;
}
interface ZipEntry {
  name: string;
  rawName: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  offset: number;
  dataStart: number;
  dataEnd: number;
}

/** Validates the complete directory and local extents before any inflation. */
export function readZip(bytes: Uint8Array, limits: ZipLimits = {}): Map<string, Uint8Array> {
  return checked('ZIP_DECODE', () => {
    const bound = { ...DEFAULT_ZIP_LIMITS, ...limits };
    for (const [key, value] of Object.entries(bound))
      if (!Number.isSafeInteger(value) || value < 0) fail('ZIP_LIMIT', `Invalid ${key}`);
    if (bytes.length > bound.maxCompressedBytes) fail('ZIP_LIMIT', 'ZIP archive exceeds compressed limit');
    const r = new BinaryReader(bytes, 'ZIP');
    r.need(22);
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
      if (r.view.getUint32(p, true) === 0x06054b50 && p + 22 + r.view.getUint16(p + 20, true) === bytes.length) { end = p; break; }
    if (end < 0) fail('ZIP_DIRECTORY', 'Missing ZIP end directory');
    const disk = r.view.getUint16(end + 4, true), centralDisk = r.view.getUint16(end + 6, true);
    const diskEntries = r.view.getUint16(end + 8, true), count = r.view.getUint16(end + 10, true);
    const centralSize = r.view.getUint32(end + 12, true), centralOffset = r.view.getUint32(end + 16, true);
    if (disk || centralDisk || diskEntries !== count || count === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff)
      fail('ZIP_FORMAT', 'Multidisk and ZIP64 archives are unsupported');
    if (count > bound.maxEntries) fail('ZIP_LIMIT', 'ZIP entry count exceeds limit');
    if (centralOffset + centralSize !== end) fail('ZIP_DIRECTORY', 'Invalid central directory extent');
    r.p = centralOffset;
    const entries: ZipEntry[] = [], names = new Set<string>();
    const fileNames = new Set<string>(), directoryNames = new Set<string>();
    let compressedTotal = 0, uncompressedTotal = 0;
    for (let i = 0; i < count; i++) {
      r.need(46);
      if (r.view.getUint32(r.p, true) !== 0x02014b50) fail('ZIP_DIRECTORY', 'Invalid central directory entry', r.p);
      const p = r.p, flags = r.view.getUint16(p + 8, true), method = r.view.getUint16(p + 10, true);
      const crc = r.view.getUint32(p + 16, true), compressed = r.view.getUint32(p + 20, true);
      const uncompressed = r.view.getUint32(p + 24, true), nameLength = r.view.getUint16(p + 28, true);
      const extraLength = r.view.getUint16(p + 30, true), commentLength = r.view.getUint16(p + 32, true);
      const offset = r.view.getUint32(p + 42, true), attributes = r.view.getUint32(p + 38, true);
      if (r.view.getUint16(p + 34, true) || compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff)
        fail('ZIP_FORMAT', 'Multidisk and ZIP64 entries are unsupported');
      if (flags & ~0x080e || (method !== 0 && method !== 8)) fail('ZIP_FORMAT', 'Encrypted or unsupported ZIP entry');
      if (((attributes >>> 16) & 0xf000) === 0xa000) fail('ZIP_PATH', 'ZIP symbolic links are forbidden');
      if (compressed > bound.maxEntryCompressedBytes || uncompressed > bound.maxEntryUncompressedBytes)
        fail('ZIP_LIMIT', 'ZIP entry exceeds size limit');
      compressedTotal += compressed; uncompressedTotal += uncompressed;
      if (compressedTotal > bound.maxCompressedBytes || uncompressedTotal > bound.maxUncompressedBytes)
        fail('ZIP_LIMIT', 'ZIP total exceeds size limit');
      r.skip(46); r.need(nameLength + extraLength + commentLength);
      const rawName = bytes.subarray(r.p, r.p + nameLength), name = safeZipPath(zipName(rawName, !!(flags & 0x0800)));
      const folded = name.toLowerCase(), identity = folded.endsWith('/') ? folded.slice(0, -1) : folded;
      if (names.has(folded)) fail('ZIP_COLLISION', `Duplicate/case-colliding ZIP path: ${name}`);
      names.add(folded);
      const parts = identity.split('/');
      for (let depth = 1; depth < parts.length; depth++) directoryNames.add(parts.slice(0, depth).join('/'));
      if (name.endsWith('/')) {
        directoryNames.add(identity);
        if (uncompressed) fail('ZIP_DIRECTORY', 'ZIP directory contains file data');
      } else fileNames.add(identity);
      entries.push({ name, rawName, flags, method, crc, compressed, uncompressed, offset, dataStart: 0, dataEnd: 0 });
      r.skip(nameLength + extraLength + commentLength);
      if (r.p > end) fail('ZIP_DIRECTORY', 'Entry exceeds central directory');
    }
    if (r.p !== end) fail('ZIP_DIRECTORY', 'Central directory size/count mismatch');
    for (const name of fileNames) if (directoryNames.has(name)) fail('ZIP_COLLISION', `File/directory collision: ${name}`);
    for (const entry of entries) {
      r.p = entry.offset; r.need(30);
      const p = r.p;
      if (p + 30 > centralOffset || r.view.getUint32(p, true) !== 0x04034b50 ||
          r.view.getUint16(p + 6, true) !== entry.flags || r.view.getUint16(p + 8, true) !== entry.method)
        fail('ZIP_LOCAL', 'ZIP local header disagrees with directory', p);
      const nameLength = r.view.getUint16(p + 26, true), extraLength = r.view.getUint16(p + 28, true);
      r.skip(30); r.need(nameLength + extraLength);
      if (nameLength !== entry.rawName.length || !entry.rawName.every((value, i) => bytes[r.p + i] === value))
        fail('ZIP_LOCAL', 'ZIP local filename disagrees with directory', p);
      if (!(entry.flags & 8) && (r.view.getUint32(p + 14, true) !== entry.crc ||
          r.view.getUint32(p + 18, true) !== entry.compressed || r.view.getUint32(p + 22, true) !== entry.uncompressed))
        fail('ZIP_LOCAL', 'ZIP local sizes/CRC disagree with directory', p);
      entry.dataStart = p + 30 + nameLength + extraLength;
      entry.dataEnd = entry.dataStart + entry.compressed;
      if (entry.dataEnd > centralOffset || (entry.method === 0 && entry.compressed !== entry.uncompressed))
        fail('ZIP_LOCAL', 'ZIP entry has invalid data extent', p);
    }
    const ordered = [...entries].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < ordered.length; i++) if (ordered[i]!.offset < ordered[i - 1]!.dataEnd)
      fail('ZIP_LOCAL', 'Overlapping ZIP entries');
    const files = new Map<string, Uint8Array>();
    for (const entry of entries) {
      const compressed = bytes.subarray(entry.dataStart, entry.dataEnd);
      // One sentinel byte detects understated sizes without unbounded inflation.
      const data = entry.method === 0 ? compressed.slice()
        : inflateSync(compressed, { out: new Uint8Array(entry.uncompressed + 1) });
      if (data.length !== entry.uncompressed) fail('ZIP_SIZE', `ZIP decoded size mismatch: ${entry.name}`);
      if (crc32(data) !== entry.crc) fail('ZIP_CRC', `ZIP CRC mismatch: ${entry.name}`);
      if (!entry.name.endsWith('/')) files.set(entry.name, data);
    }
    return files;
  });
}
