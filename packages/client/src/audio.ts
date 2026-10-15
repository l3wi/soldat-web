import type Phaser from 'phaser';
import { SOUND_SAMPLES } from './sound-samples';

let decodedSounds: Promise<Record<string, AudioBuffer>> | undefined;

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

interface Voice { sound: Phaser.Sound.WebAudioSound; sample: number; x: number; y: number; volume: number; nonpositional: boolean; maxDistance: number }

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
  soundEvents = 0;
  playedSounds = 0;
  private unlocked = false;
  private readonly voices: (Voice | undefined)[] = new Array(256);
  private readonly position = { x: 0, y: 0, z: 0 };

  constructor(private readonly scene: Phaser.Scene) {}

  prepare(): Promise<void> { return this.loading ??= this.load(); }

  private async load(): Promise<void> {
    const manager = this.scene.sound as Phaser.Sound.WebAudioSoundManager;
    if (!manager.context) throw new Error('Positional SFX unavailable: Web Audio required');
    manager.setListenerPosition(0, 0);
    const listener = manager.context.listener;
    if (listener.positionX) {
      listener.positionX.value = 0; listener.positionY.value = 0; listener.positionZ.value = 0;
    } else listener.setPosition(0, 0, 0);
    decodedSounds ??= fetch('/content/manifest.json').then(response => {
      if (!response.ok) throw new Error(`Audio manifest HTTP ${response.status}`);
      return response.json();
    }).then(async manifest => {
      const decoded: Record<string, AudioBuffer> = {};
      await Promise.all(SOUND_SAMPLES.filter(Boolean).map(async sample => {
        const asset = manifest.core.sfx[`sfx/${sample}`];
        if (!asset) throw new Error(`Missing original sound sample: ${sample}`);
        const response = await fetch(`/content/${asset.object}`);
        if (!response.ok) throw new Error(`Sound ${sample}: HTTP ${response.status}`);
        decoded[sample] = await manager.context.decodeAudioData(await response.arrayBuffer());
      }));
      return decoded;
    });
    const decoded = await decodedSounds;
    if (this.destroyed) return;
    for (const [sample, buffer] of Object.entries(decoded)) this.scene.cache.audio.add(`sfx/${sample}`, buffer);
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
    await this.prepare();
    this.unlocked = true;
  }

  /** Follow the player's particle position, not the aim-offset camera (Sound.pas:436-440). */
  public setListener(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
  }

  private updateVoice(voice: Voice): void {
    const dx = voice.nonpositional ? 0 : voice.x - this.listenerX;
    const dy = voice.nonpositional ? 0 : voice.y - this.listenerY;
    voice.sound.setVolume(Math.max(0, voice.volume * attenuation(Math.hypot(dx, dy) * 750 / voice.maxDistance)));
    soundPosition(dx, dy, this.position);
    const node = voice.sound.spatialNode;
    if (node?.positionX) { node.positionX.value = this.position.x; node.positionY.value = this.position.y; node.positionZ.value = this.position.z; }
    else node?.setPosition(this.position.x, this.position.y, this.position.z);
  }

  private soundEvent(view: DataView, offset: number, length: number): void {
    if (length !== 32) throw new RangeError('Sound event must contain 32 bytes');
    this.soundEvents++;
    const sample = view.getInt32(offset, true), requestedChannel = view.getInt32(offset + 4, true);
    const operation = view.getInt32(offset + 8, true), flags = view.getUint32(offset + 12, true);
    let channel = requestedChannel;
    if (operation === 1) { this.voices[channel]?.sound.stop(); return; }
    if (operation === 2) {
      const volume = view.getFloat32(offset + 24, true);
      if (channel === -1) { for (const voice of this.voices) voice?.sound.setVolume(volume); }
      else this.voices[channel]?.sound.setVolume(volume);
      return;
    }
    if (operation === 3) { if (this.voices[channel]?.sound.isPlaying) this.voices[channel]!.sound.pause(); return; }
    if (operation === 4) { if (this.voices[channel]?.sound.isPaused) this.voices[channel]!.sound.resume(); return; }
    if (operation !== 0) throw new Error(`Unsupported sound operation ${operation}`);
    if (!SOUND_SAMPLES[sample]) throw new Error(`Unknown sound sample ID ${sample}`);
    if (!this.unlocked || this.destroyed) return;
    if (requestedChannel >= 128) return;
    if (channel === -1) channel = this.voices.findIndex((voice, index) => index >= 128 && !voice?.sound.isPlaying);
    if (channel < 0 || channel > 255) return;
    let voice = this.voices[channel];
    if (voice && !voice.sound.isPlaying && voice.sample !== sample) { voice.sound.destroy(); voice = undefined; }
    if (!voice) {
      const sound = this.scene.sound.add(`sfx/${SOUND_SAMPLES[sample]}`, { source: { x: 0, y: 0, z: -0.5, rolloffFactor: 0, panningModel: 'equalpower' } }) as Phaser.Sound.WebAudioSound;
      voice = { sound, sample, x: 0, y: 0, volume: 1, nonpositional: false, maxDistance: 750 }; this.voices[channel] = voice;
    }
    voice.x = view.getFloat32(offset + 16, true); voice.y = view.getFloat32(offset + 20, true);
    voice.volume = view.getFloat32(offset + 24, true); voice.nonpositional = (flags & 2) !== 0; voice.maxDistance = view.getFloat32(offset + 28, true);
    voice.sound.setLoop((flags & 1) !== 0); this.updateVoice(voice);
    if (!voice.sound.isPlaying) { voice.sound.play({ loop: (flags & 1) !== 0 }); this.updateVoice(voice); this.playedSounds++; }
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
    for (const voice of this.voices) voice?.sound.destroy();
    this.destroyed = true;
    this.unmappedKinds.clear();
  }
}
