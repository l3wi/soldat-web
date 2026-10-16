import { describe, expect, test } from 'bun:test';
import { ContentError } from './errors.ts';
import { AUDIO_LOOPS, assertIdenticalRgba, encodeLosslessWebp, encodeOpus, opusTiming, seamStats } from './derivatives.ts';
import { encodePng } from './media.ts';

function pcmWav(sampleRate: number, sampleCount: number): Uint8Array {
  const bytes = new Uint8Array(44 + sampleCount * 2), view = new DataView(bytes.buffer), text = new TextEncoder();
  bytes.set(text.encode('RIFF')); view.setUint32(4, bytes.length - 8, true);
  bytes.set(text.encode('WAVEfmt '), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(text.encode('data'), 36); view.setUint32(40, sampleCount * 2, true);
  for (let i = 0; i < sampleCount; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / sampleCount * 8 * Math.PI) * 8000), true);
  return bytes;
}

describe('browser media derivatives', () => {
  test('lossless WebP round-trips hidden RGB, partial alpha, and NPOT dimensions', async () => {
    const rgba = new Uint8Array([17, 255, 31, 0, 0, 255, 0, 128, 30, 40, 50, 255]);
    const webp = await encodeLosslessWebp(3, 1, rgba);
    expect(new TextDecoder().decode(webp.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(webp.subarray(8, 12))).toBe('WEBP');
    // encodeLosslessWebp performs the independent dwebp -> PNG -> RGBA assertion.
  });

  test('RGBA comparison rejects changed hidden colors and dimensions', () => {
    const original = encodePng(1, 1, new Uint8Array([17, 255, 31, 0]));
    expect(() => assertIdenticalRgba(original, encodePng(1, 1, new Uint8Array([0, 0, 0, 0])))).toThrow(ContentError);
    expect(() => assertIdenticalRgba(original, encodePng(2, 1, new Uint8Array(8)))).toThrow(ContentError);
    expect(() => assertIdenticalRgba(original, original)).not.toThrow();
  });

  test('Opus pre-skip and final granule retain source duration without padding', async () => {
    for (const [rate, count] of [[48000, 4801], [11025, 1103]] as const) {
      const result = await encodeOpus(pcmWav(rate, count), true);
      expect(result.codec).toBe('opus'); expect(result.container).toBe('ogg'); expect(result.channels).toBe(1);
      expect(result.sampleCount).toBe(count); expect(result.sampleRate).toBe(rate);
      expect(result.preSkip).toBeGreaterThan(0);
      expect(result.finalGranule - result.preSkip).toBe(result.encodedSampleCount);
      expect(Math.abs(result.durationDeviationSeconds)).toBeLessThanOrEqual(1 / 48000 + Number.EPSILON);
      expect(result.loopVerification!.decodedSampleCount).toBe(result.encodedSampleCount);
      expect(opusTiming(result.bytes).encodedDurationSeconds).toBe(result.encodedDurationSeconds);
      expect(() => opusTiming(result.bytes.subarray(0, result.bytes.length - 1))).toThrow(ContentError);
    }
  }, 30000);

  test('seam metrics use normalized sample boundary and five-millisecond windows', () => {
    const data = new Uint8Array(12), view = new DataView(data.buffer);
    view.setFloat32(0, -0.5, true); view.setFloat32(4, 0, true); view.setFloat32(8, 0.5, true);
    const stats = seamStats(data);
    expect(stats.boundaryJump).toBe(1); expect(stats.adjacentDeltaRms).toBe(0.5);
    expect(stats.windowSamples).toBe(3); expect(stats.firstWindowRms).toBe(stats.lastWindowRms);
    expect(() => seamStats(new Uint8Array())).toThrow(ContentError);
  });

  test('native AL_TRUE loop inventory includes every looping sample and caller', () => {
    expect(Object.values(AUDIO_LOOPS).map(loop => loop.sampleId).sort((a, b) => a - b)).toEqual([2, 56, 133]);
    expect(AUDIO_LOOPS['sfx/chainsaw-r.wav']!.callsites).toHaveLength(2);
  });
});
