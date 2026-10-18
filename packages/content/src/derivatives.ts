import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ContentError } from './errors.ts';
import { convertWav, decodeImage, encodePng } from './media.ts';

const exec = promisify(execFile);
const FFMPEG = 'ffmpeg';
const OPUS_RATE = 48000;

async function run(command: string, args: string[]): Promise<void> {
  try {
    await exec(command, args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new ContentError('MEDIA_TOOL', `${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Every output frame is independently decoded and compared with the old PNG derivative. */
export async function encodeLosslessWebp(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), 'soldat-webp-'));
  try {
    const png = encodePng(width, height, rgba);
    const input = join(directory, 'input.png'), output = join(directory, 'output.webp'), decoded = join(directory, 'decoded.png');
    await writeFile(input, png);
    await run('cwebp', ['-quiet', '-lossless', '-exact', '-z', '9', input, '-o', output]);
    await run('dwebp', ['-quiet', output, '-o', decoded]);
    assertIdenticalRgba(png, await readFile(decoded));
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function assertIdenticalRgba(originalPng: Uint8Array, decodedPng: Uint8Array): void {
  const original = decodeImage(originalPng), decoded = decodeImage(decodedPng);
  const a = original.frames[0]!.rgba, b = decoded.frames[0]!.rgba;
  if (original.width !== decoded.width || original.height !== decoded.height || a.length !== b.length ||
      !a.every((value, index) => value === b[index]))
    throw new ContentError('WEBP_PIXELS', 'Lossless WebP changed dimensions or straight-alpha RGBA bytes');
}

export interface OpusTiming {
  preSkip: number;
  finalGranule: number;
  encodedSampleRate: number;
  encodedSampleCount: number;
  encodedDurationSeconds: number;
}

/** Opus granules are always 48 kHz; the last granule excludes encoder end padding. */
export function opusTiming(bytes: Uint8Array): OpusTiming {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0, serial: number | undefined, sequence = 0, preSkip: number | undefined, finalGranule: number | undefined;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'OggS' || bytes[offset + 4] !== 0)
      throw new ContentError('OPUS_OGG', 'Invalid Ogg page');
    const flags = bytes[offset + 5]!, segments = bytes[offset + 26]!;
    const body = offset + 27 + segments;
    if (body > bytes.length) throw new ContentError('OPUS_OGG', 'Truncated Ogg segment table');
    let size = 0;
    for (let i = offset + 27; i < body; i++) size += bytes[i]!;
    if (body + size > bytes.length) throw new ContentError('OPUS_OGG', 'Truncated Ogg page body');
    const pageSerial = view.getUint32(offset + 14, true), pageSequence = view.getUint32(offset + 18, true);
    if (offset === 0) {
      serial = pageSerial;
      if (flags !== 2 || segments !== 1 || size !== 19 || String.fromCharCode(...bytes.subarray(body, body + 8)) !== 'OpusHead' ||
          bytes[body + 8] !== 1 || bytes[body + 9] !== 1 || bytes[body + 18] !== 0)
        throw new ContentError('OPUS_HEAD', 'Expected a mono OpusHead identification packet');
      preSkip = view.getUint16(body + 10, true);
    }
    if (pageSerial !== serial || pageSequence !== sequence++ || finalGranule !== undefined)
      throw new ContentError('OPUS_OGG', 'Unexpected Ogg logical stream or page sequence');
    if (flags & 4) {
      const granule = view.getBigUint64(offset + 6, true);
      if (granule > BigInt(Number.MAX_SAFE_INTEGER)) throw new ContentError('OPUS_GRANULE', 'Invalid final Opus granule');
      finalGranule = Number(granule);
    }
    offset = body + size;
  }
  if (preSkip === undefined || finalGranule === undefined || finalGranule < preSkip)
    throw new ContentError('OPUS_GRANULE', 'Missing or invalid Opus pre-skip/final granule');
  const encodedSampleCount = finalGranule - preSkip;
  return { preSkip, finalGranule, encodedSampleRate: OPUS_RATE, encodedSampleCount, encodedDurationSeconds: encodedSampleCount / OPUS_RATE };
}

export interface AudioLoopSource {
  sampleId: number;
  symbol: string;
  callsites: readonly string[];
}

/** All AL_TRUE sample selection and callers in the pinned native sound code. */
export const AUDIO_LOOPS: Readonly<Record<string, AudioLoopSource>> = {
  'sfx/rocketz.wav': { sampleId: 2, symbol: 'SFX_ROCKETZ', callsites: ['shared/mechanics/Control.pas:416'] },
  'sfx/flamer.wav': { sampleId: 56, symbol: 'SFX_FLAMER', callsites: ['shared/mechanics/Sprites.pas:4232'] },
  'sfx/chainsaw-r.wav': { sampleId: 133, symbol: 'SFX_CHAINSAW_R', callsites: ['shared/mechanics/Control.pas:1371', 'shared/mechanics/Sprites.pas:1149'] },
};

export interface SeamStats {
  boundaryJump: number;
  firstWindowRms: number;
  lastWindowRms: number;
  adjacentDeltaRms: number;
  windowSamples: number;
}

/** Normalized PCM statistics, not a listening test or proof of perceptual continuity. */
export function seamStats(pcm: Uint8Array, sampleRate = OPUS_RATE): SeamStats {
  if (!pcm.length || pcm.length % 4) throw new ContentError('OPUS_PCM', 'Expected nonempty float32 PCM');
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength), count = pcm.length / 4;
  const sample = (index: number): number => view.getFloat32(index * 4, true);
  const windowSamples = Math.min(count, Math.max(1, Math.round(sampleRate * 0.005)));
  let first = 0, last = 0, deltas = 0;
  for (let i = 0; i < count; i++) {
    const value = sample(i);
    if (!Number.isFinite(value)) throw new ContentError('OPUS_PCM', 'Non-finite decoded PCM');
    if (i < windowSamples) first += value * value;
    if (i >= count - windowSamples) last += value * value;
    if (i > 0) deltas += (value - sample(i - 1)) ** 2;
  }
  return { boundaryJump: Math.abs(sample(0) - sample(count - 1)), firstWindowRms: Math.sqrt(first / windowSamples),
    lastWindowRms: Math.sqrt(last / windowSamples), adjacentDeltaRms: count > 1 ? Math.sqrt(deltas / (count - 1)) : 0, windowSamples };
}

export interface LoopVerification {
  source: SeamStats;
  opus: SeamStats;
  boundaryJumpChange: number;
  decodedSampleCount: number;
}

export interface EncodedOpus extends OpusTiming {
  bytes: Uint8Array;
  converted: boolean;
  sampleCount: number;
  sampleRate: number;
  sourceChannels: number;
  channels: number;
  durationSeconds: number;
  codec: 'opus';
  container: 'ogg';
  bitrate: number;
  durationDeviationSeconds: number;
  loop: boolean;
  loopVerification?: LoopVerification;
}

export async function encodeOpus(bytes: Uint8Array, loop: boolean): Promise<EncodedOpus> {
  const source = convertWav(bytes), directory = await mkdtemp(join(tmpdir(), 'soldat-opus-'));
  try {
    const input = join(directory, 'input.wav'), output = join(directory, 'output.opus');
    await writeFile(input, source.bytes);
    await run(FFMPEG, ['-v', 'error', '-nostdin', '-y', '-fflags', '+bitexact', '-i', input, '-map_metadata', '-1',
      '-vn', '-ac', '1', '-ar', String(OPUS_RATE), '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on', '-application', 'audio', '-flags:a', '+bitexact', output]);
    const encoded = await readFile(output), timing = opusTiming(encoded);
    const durationDeviationSeconds = timing.encodedDurationSeconds - source.durationSeconds;
    // Resampling to the mandatory Opus clock can quantize by at most one 48-kHz sample.
    if (Math.abs(durationDeviationSeconds) > 1 / OPUS_RATE + Number.EPSILON)
      throw new ContentError('OPUS_DURATION', `Opus duration changed by ${durationDeviationSeconds}s`);
    let loopVerification: LoopVerification | undefined;
    if (loop) {
      const originalPcm = join(directory, 'source.f32'), encodedPcm = join(directory, 'opus.f32');
      const decodeArgs = ['-map_metadata', '-1', '-vn', '-ac', '1', '-ar', String(OPUS_RATE), '-f', 'f32le'];
      await run(FFMPEG, ['-v', 'error', '-nostdin', '-y', '-i', input, ...decodeArgs, originalPcm]);
      await run(FFMPEG, ['-v', 'error', '-nostdin', '-y', '-i', output, ...decodeArgs, encodedPcm]);
      const sourceDecoded = await readFile(originalPcm), opusDecoded = await readFile(encodedPcm);
      if (opusDecoded.length / 4 !== timing.encodedSampleCount || Math.abs(sourceDecoded.length - opusDecoded.length) > 4)
        throw new ContentError('OPUS_DURATION', 'Decoded loop PCM does not match pre-skip/final-granule sample count');
      const sourceSeam = seamStats(sourceDecoded), opusSeam = seamStats(opusDecoded);
      loopVerification = { source: sourceSeam, opus: opusSeam, boundaryJumpChange: opusSeam.boundaryJump - sourceSeam.boundaryJump,
        decodedSampleCount: opusDecoded.length / 4 };
    }
    return { bytes: encoded, converted: source.converted, sampleCount: source.sampleCount, sampleRate: source.sampleRate,
      sourceChannels: source.channels, channels: 1, durationSeconds: source.durationSeconds, codec: 'opus', container: 'ogg', bitrate: 64000,
      ...timing, durationDeviationSeconds, loop, ...(loopVerification ? { loopVerification } : {}) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
