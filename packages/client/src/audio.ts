import type Phaser from 'phaser';
import { SOUND_SAMPLES, soundPreloadSamples, type SoundPreloadOptions } from './sound-samples';
import { contentUrl, loadContentIndex } from './content';
import { SIM_PRESENTATION_EVENTS } from '@soldat-web/sim-host';
import type { RadioChoice } from '@soldat-web/protocol';

/** NetworkUtils.pas:97-105: each recording is the complete phrase, not stitched words. */
function radioSample(category: RadioChoice, direction: RadioChoice): number {
  if (![1, 2, 3].includes(category) || ![1, 2, 3].includes(direction)) throw new RangeError('Invalid native radio choice');
  return 151 + (category - 1) * 3 + direction - 1;
}

// Successful buffers and in-flight requests survive scene teardown for the session.
const decodedSounds = new Map<number, Promise<AudioBuffer>>();

const EVENT_HEADER_BYTES = 20;
const PRESENTATION_BIT = 0x80000000;

/**
 * Sound.pas:442,464-469,492: linear gain, no OpenAL distance model.
 * distance is Euclidean WORLD distance, not pixels or already-normalized range.
 * Grenade deafening is optional; SFX_HUM callers must leave it zero.
 * Battle/distant substitutions are disabled in original sound.cfg and require
 * authoritative sample IDs; they must not be guessed from gameplay events.
 */
export function attenuation(distance: number, grenadeEffectTicks = 0): number {
  let normalized = distance / 750;
  if (grenadeEffectTicks > 0) {
    normalized += (1 - normalized) * Math.sqrt(grenadeEffectTicks / 280);
  }
  return normalized > 1 ? 0 : 1 - normalized;
}

/** Sound.pas:214-216, converting the original 0..100 setting to master gain. */
export function scaleVolumeSetting(volume: number): number {
  return (Math.pow(1.0404, volume) - 1) / (1.0404 - 1) / 1275;
}

/**
 * Sound.pas:495-498 source coordinates for the ORIGINAL positional pan model.
 * This is a 3D direction, not a made-up linear stereo-pan approximation:
 * OpenAL uses (dx/2000, dy/2000, -1000/2000), with AL_NONE attenuation.
 * A Web Audio mapping must use these coordinates with rolloffFactor=0 and
 * the separate attenuation() gain, rather than applying distance loss twice.
 */
export function soundPosition(
  deltaX: number, deltaY: number, out: { x: number; y: number; z: number },
): void {
  out.x = deltaX / 2000;
  out.y = deltaY / 2000;
  out.z = -1000 / 2000;
}

export const SOUND_MAPPING_STATUS = 'ABI sound events mapped to original sample IDs and Phaser Web Audio; explicit gesture required.';

interface Voice {
  sound?: Phaser.Sound.WebAudioSound;
  sample: number;
  x: number;
  y: number;
  volume: number;
  nonpositional: boolean;
  maxDistance: number;
  loop: boolean;
  active: boolean;
  paused: boolean;
}

/** Owns scene voices, never the game-wide Phaser sound manager. */
export class Audio {
  public listenerX = 0;
  public listenerY = 0;
  public unmappedPresentationEvents = 0;
  public gameplayEvents = 0;
  public readonly unmappedKinds = new Map<number, number>();
  public lastTick = 0;
  public lastSource = 0;
  public lastTarget = 0;
  private destroyed = false;
  private eventView: DataView | undefined;
  private loading: Promise<void> | undefined;
  private initialized = false;
  private readonly sampleLoads = new Map<number, Promise<void>>();
  private readonly readySamples = new Set<number>();
  public lastError: Error | undefined;
  soundEvents = 0;
  playedSounds = 0;
  private unlocked = false;
  private radioNextAt = 0;
  private readonly voices: (Voice | undefined)[] = new Array(256);
  private readonly pendingVoices = new Set<Voice>();
  private readonly position = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly onError: (error: Error) => void = error => console.error(error),
  ) {}

  /** Additive match preload; later loadout changes reuse the same per-sample promises. */
  async prepare(options: SoundPreloadOptions = {}): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.initialize();
    return this.loading = Promise.all([
      this.loading,
      ...soundPreloadSamples(options).map(sample => this.loadSample(sample)),
    ]).then(() => {});
  }

  private initialize(): void {
    if (this.initialized) return;
    const manager = this.scene.sound as Phaser.Sound.WebAudioSoundManager;
    if (!manager.context) throw new Error('Positional SFX unavailable: Web Audio required');
    manager.setListenerPosition(0, 0);
    const listener = manager.context.listener;
    if (listener.positionX) {
      listener.positionX.value = 0; listener.positionY.value = 0; listener.positionZ.value = 0;
    } else listener.setPosition(0, 0, 0);
    this.initialized = true;
  }

  private loadSample(sample: number): Promise<void> {
    const existing = this.sampleLoads.get(sample);
    if (existing) return existing;
    let decoded = decodedSounds.get(sample);
    if (!decoded) {
      const context = (this.scene.sound as Phaser.Sound.WebAudioSoundManager).context;
      const name = SOUND_SAMPLES[sample]!;
      decoded = loadContentIndex().then(async manifest => {
        const asset = manifest.core.sfx[`sfx/${name}`];
        if (!asset) throw new Error('Missing original sound sample');
        const response = await fetch(contentUrl(asset.object));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Opus-in-Ogg is decoded by Web Audio, not an HTMLAudio fallback.
        return context.decodeAudioData(await response.arrayBuffer());
      }).catch(error => {
        throw new Error(`Sound ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      });
      decodedSounds.set(sample, decoded);
    }
    const loading = decoded.then(buffer => {
      if (this.destroyed) return;
      this.scene.cache.audio.add(`sfx/${SOUND_SAMPLES[sample]}`, buffer);
      this.readySamples.add(sample);
    });
    this.sampleLoads.set(sample, loading);
    return loading;
  }

  /** Invoke directly from the start/audio-enable gesture, not an update loop. */
  public async unlock(): Promise<void> {
    if (this.destroyed) return;
    // Phaser's sound plugin is a WebAudio/HTML5/NoAudio manager union. Only the
    // WebAudio manager owns context; HTML5 uses its own unlock gesture handler.
    const manager = this.scene.sound as unknown as {
      context?: AudioContext;
      unlock?: () => void;
    };
    manager.unlock?.();
    if (manager.context?.state === 'suspended') await manager.context.resume();
    await (this.loading ?? this.prepare());
    if (!this.destroyed) this.unlocked = true;
  }

  /** Master output gain; native per-source volume and attenuation stay intact. */
  public setVolume(volume: number): void {
    this.scene.sound.setVolume(volume);
  }

  /** Native radio is played at the listener position, gain 1, with a 3-second cooldown. */
  public radio(category: RadioChoice, direction: RadioChoice): void {
    const sample = radioSample(category, direction);
    if (!this.unlocked || this.destroyed || Date.now() < this.radioNextAt) return;
    let channel = 128;
    while (channel < this.voices.length && this.voices[channel]?.active &&
      (!this.voices[channel]?.sound || this.voices[channel]?.sound?.isPlaying)) channel++;
    if (channel === this.voices.length) return;
    this.radioNextAt = Date.now() + 3000;
    this.voices[channel]?.sound?.destroy();
    const voice: Voice = { sample, x: 0, y: 0, volume: 1, nonpositional: true, maxDistance: 750, loop: false, active: true, paused: false };
    this.voices[channel] = voice;
    if (this.readySamples.has(sample)) this.startVoice(channel, voice);
    else {
      this.pendingVoices.add(voice);
      void this.loadSample(sample).then(() => {
        this.pendingVoices.delete(voice);
        this.startVoice(channel, voice);
      }).catch(error => {
        this.pendingVoices.delete(voice);
        if (this.destroyed || this.voices[channel] !== voice) return;
        voice.active = false;
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this.onError(this.lastError);
      });
    }
  }

  /** Follow the player's particle position, not the aim-offset camera (Sound.pas:436-440). */
  public setListener(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
  }

  private updateVoice(voice: Voice): void {
    if (!voice.sound) return;
    const dx = voice.nonpositional ? 0 : voice.x - this.listenerX;
    const dy = voice.nonpositional ? 0 : voice.y - this.listenerY;
    voice.sound.setVolume(Math.max(0, voice.volume * attenuation(Math.hypot(dx, dy) * 750 / voice.maxDistance)));
    soundPosition(dx, dy, this.position);
    const node = voice.sound.spatialNode;
    if (node?.positionX) { node.positionX.value = this.position.x; node.positionY.value = this.position.y; node.positionZ.value = this.position.z; }
    else node?.setPosition(this.position.x, this.position.y, this.position.z);
  }

  private startVoice(channel: number, voice: Voice): void {
    if (this.destroyed || this.voices[channel] !== voice || !voice.active || voice.paused) return;
    voice.sound ??= this.scene.sound.add(`sfx/${SOUND_SAMPLES[voice.sample]}`, {
      source: { x: 0, y: 0, z: -0.5, rolloffFactor: 0, panningModel: 'equalpower' },
    }) as Phaser.Sound.WebAudioSound;
    voice.sound.setLoop(voice.loop);
    this.updateVoice(voice);
    if (!voice.sound.isPlaying) {
      voice.sound.play({ loop: voice.loop });
      this.updateVoice(voice);
      this.playedSounds++;
    }
  }

  private soundEvent(view: DataView, offset: number, length: number): void {
    if (length !== 32) throw new RangeError('Sound event must contain 32 bytes');
    this.soundEvents++;
    const sample = view.getInt32(offset, true), requestedChannel = view.getInt32(offset + 4, true);
    const operation = view.getInt32(offset + 8, true), flags = view.getUint32(offset + 12, true);
    let channel = requestedChannel;
    if (operation === 1) {
      const voice = this.voices[channel];
      if (voice) { voice.active = false; voice.paused = false; voice.sound?.stop(); }
      return;
    }
    if (operation === 2) {
      const volume = view.getFloat32(offset + 24, true);
      if (channel === -1) {
        for (const voice of this.voices) {
          if (voice) { voice.volume = volume; voice.sound?.setVolume(volume); }
        }
      } else {
        const voice = this.voices[channel];
        if (voice) { voice.volume = volume; voice.sound?.setVolume(volume); }
      }
      return;
    }
    if (operation === 3) {
      const voice = this.voices[channel];
      if (voice?.active && (!voice.sound || voice.sound.isPlaying)) { voice.paused = true; voice.sound?.pause(); }
      return;
    }
    if (operation === 4) {
      const voice = this.voices[channel];
      if (voice?.active && voice.paused) {
        voice.paused = false;
        if (voice.sound?.isPaused) voice.sound.resume();
        else if (this.readySamples.has(voice.sample)) this.startVoice(channel, voice);
      }
      return;
    }
    if (operation !== 0) throw new Error(`Unsupported sound operation ${operation}`);
    if (!SOUND_SAMPLES[sample]) throw new Error(`Unknown sound sample ID ${sample}`);
    if (!this.unlocked || this.destroyed) return;
    if (requestedChannel >= 128) return;
    // Pending default-channel requests reserve a voice until decode completes.
    if (channel === -1) {
      for (let candidate = 128; candidate < this.voices.length; candidate++) {
        const voice = this.voices[candidate];
        if (!voice || (voice.sound ? !voice.sound.isPlaying : !voice.active || voice.paused)) {
          channel = candidate;
          break;
        }
      }
    }
    if (channel < 0 || channel > 255) return;
    let voice = this.voices[channel];
    // Native playing sources keep their current buffer; a pending or stopped
    // source with a different sample is replaced, invalidating its continuation.
    if (voice && !voice.sound?.isPlaying && voice.sample !== sample) { voice.sound?.destroy(); voice = undefined; }
    if (!voice) {
      voice = { sample, x: 0, y: 0, volume: 1, nonpositional: false, maxDistance: 750, loop: false, active: true, paused: false };
      this.voices[channel] = voice;
    }
    voice.x = view.getFloat32(offset + 16, true); voice.y = view.getFloat32(offset + 20, true);
    voice.volume = view.getFloat32(offset + 24, true); voice.nonpositional = (flags & 2) !== 0; voice.maxDistance = view.getFloat32(offset + 28, true);
    voice.loop = (flags & 1) !== 0; voice.active = true; voice.paused = false;
    if (this.readySamples.has(voice.sample)) this.startVoice(channel, voice);
    else if (!voice.sound) {
      // Attach once per pending voice, not on every simulation tick of a loop.
      if (this.pendingVoices.has(voice)) return;
      this.pendingVoices.add(voice);
      const pending = voice;
      void this.loadSample(pending.sample).then(() => {
        this.pendingVoices.delete(pending);
        this.startVoice(channel, pending);
      }).catch(error => {
        this.pendingVoices.delete(pending);
        if (this.destroyed || this.voices[channel] !== pending || !pending.active) return;
        pending.active = false;
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this.onError(this.lastError);
      });
    }
  }
  /** Accepts a persistent capacity-sized view plus the actual sim_events byte count. */
  public drain(events: Uint8Array, length = events.byteLength): void {
    if (this.destroyed) return;
    if (!Number.isInteger(length) || length < 0 || length > events.byteLength) {
      throw new RangeError('Invalid simulation event byte count');
    }
    if (length === 0) return;
    if (!this.eventView || this.eventView.buffer !== events.buffer ||
      this.eventView.byteOffset !== events.byteOffset || this.eventView.byteLength !== events.byteLength) {
      this.eventView = new DataView(events.buffer, events.byteOffset, events.byteLength);
    }
    const view = this.eventView;
    let offset = 0;
    while (offset < length) {
      if (length - offset < EVENT_HEADER_BYTES) throw new RangeError('Truncated simulation event header');
      const kind = view.getUint32(offset, true);
      const tick = view.getUint32(offset + 4, true);
      const source = view.getUint32(offset + 8, true);
      const target = view.getUint32(offset + 12, true);
      const payloadBytes = view.getUint32(offset + 16, true);
      offset += EVENT_HEADER_BYTES;
      if (payloadBytes > length - offset) throw new RangeError('Truncated simulation event payload');
      this.lastTick = tick;
      this.lastSource = source;
      this.lastTarget = target;
      if (kind === 0x80000004) this.soundEvent(view, offset, payloadBytes);
      else if (kind === SIM_PRESENTATION_EVENTS.BINK) { /* Client cursor owns this known nonsound presentation event. */ }
      else if ((kind & PRESENTATION_BIT) !== 0) {
        this.unmappedPresentationEvents++;
        this.unmappedKinds.set(kind, (this.unmappedKinds.get(kind) ?? 0) + 1);
      } else {
        this.gameplayEvents++;
      }
      offset += payloadBytes;
    }
  }

  public destroy(): void {
    this.destroyed = true;
    for (const voice of this.voices) voice?.sound?.destroy();
    this.voices.fill(undefined);
    this.pendingVoices.clear();
    this.unmappedKinds.clear();
  }
}
