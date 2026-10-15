import type Phaser from 'phaser';

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

export const SOUND_MAPPING_STATUS =
  'Unsupported by movement ABI: only console/log/idle presentation kinds exist; no sound kind, sample ID, emitter coordinates or sound manifest mapping is defined.';

/**
 * Event boundary for Phaser Sound. No SFX are inferred from movement or idle
 * events. The ABI currently defines NO sound records (SimEvents.pas); therefore
 * no assets are loaded and no sounds are fabricated. Once a real sound record
 * is specified, its sample mapping belongs here and assets can be lazily loaded
 * on that record, using the original attenuation()/soundPosition() above.
 */
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

  constructor(private readonly scene: Phaser.Scene) {}

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
  }

  /** Follow the player's particle position, not the aim-offset camera (Sound.pas:436-440). */
  public setListener(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
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
      if ((kind & PRESENTATION_BIT) !== 0) {
        this.unmappedPresentationEvents++;
        this.unmappedKinds.set(kind, (this.unmappedKinds.get(kind) ?? 0) + 1);
      } else {
        this.gameplayEvents++;
      }
      offset += payloadBytes;
    }
  }

  public destroy(): void {
    // No owned voices/loaders exist until the ABI supplies actual sound records.
    // Never destroy scene.sound: the manager belongs to the Phaser game.
    this.destroyed = true;
    this.unmappedKinds.clear();
  }
}
