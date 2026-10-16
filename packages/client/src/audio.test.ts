import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type Phaser from 'phaser';
import { Audio, attenuation, soundPosition } from './audio';
import { BOT_PROFILES } from './sandbox-options';
import { BOT_SOUND_LOADOUTS, LOOPING_SOUND_SAMPLES, SOUND_SAMPLES, soundPreloadSamples } from './sound-samples';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function event(sample: number, channel = -1, operation = 0, flags = 0, x = 200, y = 100, volume = 0.8): Uint8Array {
  const bytes = new Uint8Array(52), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x80000004, true); view.setUint32(4, 1, true); view.setUint32(16, 32, true);
  view.setInt32(20, sample, true); view.setInt32(24, channel, true);
  view.setInt32(28, operation, true); view.setUint32(32, flags, true);
  view.setFloat32(36, x, true); view.setFloat32(40, y, true);
  view.setFloat32(44, volume, true); view.setFloat32(48, 750, true);
  return bytes;
}

class FakeSound {
  isPlaying = false;
  isPaused = false;
  loop = false;
  volume = 1;
  plays = 0;
  destroyed = false;
  spatialNode = { positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } };
  constructor(readonly key: string) {}
  setVolume(value: number) { this.volume = value; }
  setLoop(value: boolean) { this.loop = value; }
  play(options: { loop: boolean }) { this.loop = options.loop; this.isPlaying = true; this.isPaused = false; this.plays++; }
  stop() { this.isPlaying = false; this.isPaused = false; }
  pause() { this.isPlaying = false; this.isPaused = true; }
  resume() { this.isPlaying = true; this.isPaused = false; }
  destroy() { this.stop(); this.destroyed = true; }
}

test('preload IDs follow pinned native weapon numbers, bot profiles and looping rules', () => {
  const nativeWeaponNumbers: Record<string, number> = {
    'FN Minimi': 9, 'Spas-12': 5, 'XM214 Minigun': 10, Chainsaw: 12, 'Steyr AUG': 4,
    'Ak-74': 3, 'Desert Eagles': 1, 'Ruger 77': 6, 'HK MP5': 2, M79: 7, 'Barrett M82A1': 8,
  };
  for (const name of BOT_PROFILES) {
    const source = readFileSync(new URL(`../../../reference/base/server/configs/bots/${name}.bot`, import.meta.url), 'utf8');
    const favourite = /^Favourite_Weapon=(.*)$/m.exec(source)![1]!.trim();
    const secondary = Number(/^Secondary_Weapon=(.*)$/m.exec(source)![1]);
    assert.deepEqual(BOT_SOUND_LOADOUTS[name], { weapon: nativeWeaponNumbers[favourite], secondaryWeapon: [0, 11, 12, 13][secondary] });
  }
  const constants = readFileSync(new URL('../../../reference/opensoldat/shared/Constants.pas', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../../../reference/opensoldat/client/Sound.pas', import.meta.url), 'utf8');
  const loopRule = /if \(SampleNum = (SFX_\w+)\) or \(SampleNum = (SFX_\w+)\) or \(SampleNum = (SFX_\w+)\) then\s+PlayMode := AL_TRUE/.exec(native)!;
  const loopIds = loopRule.slice(1).map(name => Number(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(constants)![1]));
  assert.deepEqual([...LOOPING_SOUND_SAMPLES].sort((a, b) => a - b), loopIds.sort((a, b) => a - b));
  assert.deepEqual(LOOPING_SOUND_SAMPLES.map(id => SOUND_SAMPLES[id]), ['rocketz.wav', 'flamer.wav', 'chainsaw-r.wav']);
  const local = soundPreloadSamples({ bots: 0 });
  assert.equal(local.length, 56);
  for (const id of [2, 70, 73, 108, 111, 89, 91, 85, 87, 50, 31, 32, 41, 42]) assert.ok(local.includes(id));
  assert.ok(!local.includes(133)); assert.ok(!local.includes(56)); assert.ok(!local.includes(161));
  const practice = soundPreloadSamples({ bots: 4 });
  assert.equal(practice.length, 71);
  for (const id of [5, 8, 11, 12, 120, 129, 130, 35, 36, 37, 38, 131, 132, 133, 136]) assert.ok(practice.includes(id));
  assert.deepEqual(soundPreloadSamples({ bots: 31 }), soundPreloadSamples({ bots: 16 }));
  for (const id of soundPreloadSamples({ loadout: { weapon: 13, secondaryWeapon: 12 } })) assert.ok(SOUND_SAMPLES[id]);
  for (const id of [135, 147, 148, 131, 132, 133, 136]) assert.ok(soundPreloadSamples({ loadout: { weapon: 13, secondaryWeapon: 12 } }).includes(id));
});

test('per-sample Opus cache, delayed voice validity and scene lifecycle', async t => {
  const requests: number[] = [], decodes: number[] = [];
  const holds = new Map<number, Deferred<AudioBuffer>>();
  const httpFailures = new Set<number>();
  let indexRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async input => {
    const path = new URL(String(input), 'https://test.invalid').pathname;
    if (path === '/content/index.json') {
      indexRequests++;
      return Response.json({ core: { sfx: Object.fromEntries(SOUND_SAMPLES.flatMap((name, id) => name ? [[`sfx/${name}`, { object: `objects/${id}.opus` }]] : [])) }, maps: {} });
    }
    const sample = Number(/^\/content\/objects\/(\d+)\.opus$/.exec(path)?.[1]);
    assert.ok(Number.isInteger(sample), `unexpected audio request ${path}`);
    requests.push(sample);
    return new Response(httpFailures.has(sample) ? null : new Uint32Array([sample]), { status: httpFailures.has(sample) ? 503 : 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  // Bun supports node:test's cleanup hook but not nested t.test calls. Keep the
  // stateful lifecycle sequence in one test and retain each scenario's context.
  const step = async (name: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) { throw new Error(name, { cause: error }); }
  };
  function fixture() {
    const sounds: FakeSound[] = [], failures: Error[] = [], cached = new Map<string, AudioBuffer>();
    const context = {
      state: 'running', listener: { positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } },
      async decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer> {
        const id = new Uint32Array(bytes)[0]!;
        decodes.push(id);
        return holds.get(id)?.promise ?? ({ sample: id } as unknown as AudioBuffer);
      },
    };
    const scene = {
      sound: { context, setListenerPosition() {}, unlock() {}, add(key: string) { const sound = new FakeSound(key); sounds.push(sound); return sound; } },
      cache: { audio: { add(key: string, buffer: AudioBuffer) { cached.set(key, buffer); } } },
    } as unknown as Phaser.Scene;
    return { audio: new Audio(scene, error => failures.push(error)), sounds, failures, cached };
  }
  const first = fixture();
  await first.audio.prepare({ bots: 0 });
  await first.audio.unlock();
  assert.deepEqual([...requests].sort((a, b) => a - b), soundPreloadSamples({ bots: 0 }));
  assert.equal(decodes.length, 56);
  assert.equal(indexRequests, 1);
  const second = fixture();
  await second.audio.prepare({ bots: 0 }); await second.audio.unlock();
  assert.equal(requests.length, 56); assert.equal(decodes.length, 56);
  assert.equal(second.cached.get('sfx/rocketz.wav'), first.cached.get('sfx/rocketz.wav'));

  await step('repeated pending loops share one decode and stop cannot resurrect them', async () => {
    const pending = deferred<AudioBuffer>(); holds.set(56, pending);
    for (let tick = 0; tick < 8; tick++) first.audio.drain(event(56, 10, 0, 1));
    const concurrent = fixture(); await concurrent.audio.unlock();
    concurrent.audio.drain(event(56, 10, 0, 1));
    await settle();
    assert.equal(requests.filter(id => id === 56).length, 1);
    assert.equal(decodes.filter(id => id === 56).length, 1);
    first.audio.drain(event(56, 10, 1));
    pending.resolve({} as AudioBuffer); await settle();
    assert.equal(first.sounds.length, 0);
    assert.equal(concurrent.sounds.length, 1); assert.equal(concurrent.sounds[0]!.plays, 1);
    concurrent.audio.destroy();
    first.audio.drain(event(56, 10, 0, 1));
    assert.equal(first.sounds.length, 1); assert.equal(first.sounds[0]!.loop, true);
    first.audio.drain(event(56, 10, 1)); assert.equal(first.sounds[0]!.isPlaying, false);
  });

  await step('same-channel replacement invalidates the older decoded buffer continuation', async () => {
    const old = deferred<AudioBuffer>(), replacement = deferred<AudioBuffer>();
    holds.set(133, old); holds.set(135, replacement);
    first.audio.drain(event(133, 11, 0, 1)); await settle();
    first.audio.drain(event(135, 11)); await settle();
    old.resolve({} as AudioBuffer); await settle();
    assert.equal(first.sounds.length, 1, 'old loop must not appear');
    replacement.resolve({} as AudioBuffer); await settle();
    assert.equal(first.sounds.length, 2);
    assert.equal(first.sounds[1]!.key, 'sfx/law.wav'); assert.equal(first.sounds[1]!.loop, false);
  });

  await step('lazy default voices reserve channels, copy events and preserve latest position/loop', async () => {
    const pending = deferred<AudioBuffer>(); holds.set(48, pending);
    const bytes = event(48); first.audio.drain(bytes);
    first.audio.drain(event(48, -1, 0, 2));
    bytes.fill(0); first.audio.setListener(100, 50);
    await settle(); pending.resolve({} as AudioBuffer); await settle();
    const voices = first.sounds.filter(sound => sound.key === 'sfx/bow-fire.wav');
    assert.equal(voices.length, 2); assert.equal(requests.filter(id => id === 48).length, 1);
    assert.equal(voices[0]!.plays, 1); assert.equal(voices[0]!.loop, false);
    const position = { x: 0, y: 0, z: 0 }; soundPosition(100, 50, position);
    assert.equal(voices[0]!.spatialNode.positionX.value, position.x);
    assert.equal(voices[0]!.spatialNode.positionY.value, position.y);
    assert.ok(Math.abs(voices[0]!.volume - 0.8 * attenuation(Math.hypot(100, 50))) < 1e-6);
    assert.equal(voices[1]!.spatialNode.positionX.value, 0);
    assert.ok(Math.abs(voices[1]!.volume - 0.8) < 1e-6);
  });

  await step('pending pause/resume and volume controls survive decode without early playback', async () => {
    const pending = deferred<AudioBuffer>(); holds.set(137, pending);
    first.audio.drain(event(137, 12, 0, 1)); first.audio.drain(event(137, 12, 3));
    first.audio.drain(event(137, 12, 2, 0, 0, 0, 0.25));
    await settle(); pending.resolve({} as AudioBuffer); await settle();
    assert.ok(!first.sounds.some(sound => sound.key === 'sfx/m2fire.wav'));
    first.audio.drain(event(137, 12, 4));
    const sound = first.sounds.find(sound => sound.key === 'sfx/m2fire.wav')!;
    assert.equal(sound.plays, 1); assert.equal(sound.loop, true);
    assert.ok(Math.abs(sound.volume - 0.25 * attenuation(Math.hypot(100, 50))) < 1e-6);
  });

  await step('stop followed by a new same-sample request keeps only the new event state', async () => {
    const pending = deferred<AudioBuffer>(); holds.set(147, pending);
    first.audio.drain(event(147, 14, 0, 1));
    first.audio.drain(event(147, 14, 1));
    first.audio.drain(event(147, 14, 4));
    first.audio.drain(event(147, 14, 0, 0, 500, 300));
    await settle(); pending.resolve({} as AudioBuffer); await settle();
    const sound = first.sounds.find(sound => sound.key === 'sfx/law-start.wav')!;
    assert.equal(sound.plays, 1); assert.equal(sound.loop, false);
    assert.equal(sound.spatialNode.positionX.value, 0.2);
    assert.equal(sound.spatialNode.positionY.value, 0.125);
    assert.equal(requests.filter(id => id === 147).length, 1);
  });

  await step('destroy invalidates pending voices but retains decoded session buffers', async () => {
    const pending = deferred<AudioBuffer>(); holds.set(57, pending);
    second.audio.drain(event(57, 8, 0, 1)); await settle(); second.audio.destroy();
    pending.resolve({} as AudioBuffer); await settle();
    assert.equal(second.sounds.length, 0); assert.ok(!second.cached.has('sfx/predator.wav'));
    const next = fixture(); await next.audio.unlock(); next.audio.drain(event(57, 8)); await settle();
    assert.equal(next.sounds.length, 1); assert.equal(requests.filter(id => id === 57).length, 1);
    assert.equal(decodes.filter(id => id === 57).length, 1); next.audio.destroy();
  });

  await step('lazy HTTP/decode failures surface sample names without playing or unhandled rejection', async () => {
    httpFailures.add(58);
    first.audio.drain(event(58, 15)); await settle();
    assert.match(first.failures.at(-1)!.message, /killberserk\.wav: HTTP 503/);
    assert.equal(first.audio.lastError, first.failures.at(-1));
    const pending = deferred<AudioBuffer>(); holds.set(60, pending);
    first.audio.drain(event(60, 16)); await settle(); pending.reject(new Error('Opus decode rejected')); await settle();
    assert.match(first.failures.at(-1)!.message, /burn\.wav: Opus decode rejected/);
    assert.ok(!first.sounds.some(sound => sound.key === 'sfx/killberserk.wav' || sound.key === 'sfx/burn.wav'));
  });

  await step('changed loadouts preload additively and concurrent preparation deduplicates samples', async () => {
    await Promise.all([first.audio.prepare({ bots: 4 }), first.audio.prepare({ bots: 4 })]);
    for (const sample of soundPreloadSamples({ bots: 4 })) {
      assert.equal(requests.filter(id => id === sample).length, 1, SOUND_SAMPLES[sample]);
      assert.equal(decodes.filter(id => id === sample).length, 1, SOUND_SAMPLES[sample]);
    }
    await first.audio.prepare({ loadout: { weapon: 8, secondaryWeapon: 11 } });
    for (const sample of [33, 34, 97, 98, 142, 129, 130]) assert.ok(first.cached.has(`sfx/${SOUND_SAMPLES[sample]}`));
    first.audio.destroy(); assert.ok(first.sounds.every(sound => sound.destroyed));
  });

  await step('preload failures reject preparation and missing Web Audio rejects clearly', async () => {
    const broken = fixture();
    await assert.rejects(broken.audio.prepare({ loadout: { weapon: 14, secondaryWeapon: 0 } }), /burn\.wav: Opus decode rejected/);
    broken.audio.destroy();
    const unavailable = new Audio({ sound: {} } as unknown as Phaser.Scene);
    await assert.rejects(unavailable.prepare(), /Web Audio required/);
    unavailable.destroy();
  });
});
