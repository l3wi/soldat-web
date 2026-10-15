import type { InputFrame } from "@soldat-web/protocol";

export type InputRejection = "rate" | "sequence" | "jump" | "stale" | "lead" | "occupied" | "invalid";
export interface BufferedInput { input: Uint8Array; seq: number; repeated: boolean }
const MAX_SEQUENCE_JUMP = 128;
const PACKETS_PER_SECOND = 90;
const BURST_PACKETS = 30;
const HELD_CONTROL_BITS = 0x003f; // Left/Right/Up/Down/Fire/Jetpack; all actions are cleared on repeats.

export class PlayerInputBuffer {
  private readonly frames = new Map<number, InputFrame>();
  private readonly held = new Uint8Array(12);
  private highestSequence = 0;
  private highestTick = -1;
  private consumedSequence = 0;
  private tokens = BURST_PACKETS;
  private lastArrival: bigint;
  readonly rejected: Record<InputRejection, number> = { rate: 0, sequence: 0, jump: 0, stale: 0, lead: 0, occupied: 0, invalid: 0 };

  constructor(now: bigint) { this.lastArrival = now; }

  /** Rate counts packets, including replay floods; redundant frames remain legal. */
  offer(frames: readonly InputFrame[], currentTick: number, now: bigint): InputRejection[] {
    if (now < this.lastArrival) throw new RangeError("Monotonic arrival time moved backwards");
    this.tokens = Math.min(BURST_PACKETS, this.tokens + Number(now - this.lastArrival) / 1e9 * PACKETS_PER_SECOND);
    this.lastArrival = now;
    if (this.tokens < 1) { this.rejected.rate++; return ["rate"]; }
    this.tokens--;
    for (const tick of this.frames.keys()) if (tick < currentTick) this.frames.delete(tick);
    if (frames.length < 1 || frames.length > 3) { this.rejected.invalid++; return ["invalid"]; }
    const failures: InputRejection[] = [];
    // Wire redundancy is newest-first; validate ordering before admitting any frame.
    for (let i = 1; i < frames.length; i++) {
      if (frames[i]!.seq >= frames[i - 1]!.seq || frames[i]!.tick >= frames[i - 1]!.tick) {
        this.rejected.invalid++; return ["invalid"];
      }
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i]!;
      let failure: InputRejection | undefined;
      if (!Number.isInteger(frame.seq) || frame.seq < 1 || frame.seq > 0xffffffff || !Number.isInteger(frame.tick) || frame.tick < 0 || frame.tick > 0xffffffff || frame.input.length !== 12) failure = "invalid";
      else if (frame.seq <= this.highestSequence) failure = "sequence";
      else if (frame.seq - this.highestSequence > MAX_SEQUENCE_JUMP) failure = "jump";
      else if (frame.tick < currentTick) failure = "stale";
      else if (frame.tick > currentTick + 2) failure = "lead";
      else if (this.frames.has(frame.tick)) failure = "occupied";
      else if (frame.tick <= this.highestTick) failure = "sequence";
      if (failure) { failures.push(failure); this.rejected[failure]++; continue; }
      this.highestSequence = frame.seq;
      this.highestTick = frame.tick;
      this.frames.set(frame.tick, { seq: frame.seq, tick: frame.tick, input: frame.input.slice() });
    }
    return failures;
  }

  /** Borrowed input bytes are consumed synchronously by the sim, never retained. */
  consume(tick: number): BufferedInput {
    for (const bufferedTick of this.frames.keys()) if (bufferedTick < tick) this.frames.delete(bufferedTick);
    const frame = this.frames.get(tick);
    if (frame) {
      this.frames.delete(tick);
      this.consumedSequence = frame.seq;
      this.held.set(frame.input);
      return { input: frame.input, seq: this.consumedSequence, repeated: false };
    }
    const view = new DataView(this.held.buffer);
    view.setUint16(0, view.getUint16(0, true) & HELD_CONTROL_BITS, true);
    return { input: this.held, seq: this.consumedSequence, repeated: true };
  }

  get size(): number { return this.frames.size; }
  get lastConsumedSequence(): number { return this.consumedSequence; }
}
