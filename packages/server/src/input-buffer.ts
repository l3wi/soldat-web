import type { InputFrame } from "@soldat-web/protocol";
import { validateInput } from "@soldat-web/protocol";

export type InputRejection = "rate" | "sequence" | "jump" | "stale" | "lead" | "occupied" | "invalid";
export interface BufferedInput { input: Uint8Array; seq: number; repeated: boolean }
const MAX_SEQUENCE_JUMP = 128;
export const INPUT_PACKETS_PER_SECOND = 90;
export const INPUT_PACKET_BURST = 128;
const HELD_CONTROL_BITS = 0x003f; // Left/Right/Up/Down/Fire/Jetpack; all actions are cleared on repeats.
export const MAX_INPUT_LEAD = 2;
const STALE_HELD_TICKS = 15;

export class PlayerInputBuffer {
  private readonly frames = new Map<number, InputFrame>();
  private readonly held = new Uint8Array(12);
  private highestSequence = 0;
  private highestTick = -1;
  private consumedSequence = 0;
  private tokens = INPUT_PACKET_BURST;
  private lastArrival: bigint;
  private lastConsumedTick = -1;
  private rebasing = false;
  readonly rejected: Record<InputRejection, number> = { rate: 0, sequence: 0, jump: 0, stale: 0, lead: 0, occupied: 0, invalid: 0 };

  constructor(now: bigint) { this.lastArrival = now; }

  /** Rate counts packets, including replay floods; redundant frames remain legal. */
  offer(frames: readonly InputFrame[], currentTick: number, now: bigint, lateFire?: (frame: InputFrame) => boolean): InputRejection[] {
    if (now < this.lastArrival) throw new RangeError("Monotonic arrival time moved backwards");
    this.tokens = Math.min(INPUT_PACKET_BURST, this.tokens + Number(now - this.lastArrival) / 1e9 * INPUT_PACKETS_PER_SECOND);
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
      if (!Number.isInteger(frame.seq) || frame.seq < 1 || frame.seq > 0xffffffff || !Number.isInteger(frame.tick) || frame.tick < 0 || frame.tick > 0xffffffff || !Number.isInteger(frame.viewTick) || frame.viewTick < 0 || frame.viewTick > frame.tick || frame.viewTick < frame.tick - 18 || frame.viewTick > currentTick + 2 || frame.input.length !== 12) failure = "invalid";
      else if (frame.seq <= this.highestSequence) failure = "sequence";
      else if (!this.rebasing && frame.seq - this.highestSequence > MAX_SEQUENCE_JUMP) failure = "jump";
      else if (frame.tick < currentTick && (!lateFire || this.rebasing)) failure = "stale";
      else if (frame.tick > currentTick + MAX_INPUT_LEAD) failure = "lead";
      else if (this.frames.has(frame.tick)) failure = "occupied";
      else if (frame.tick <= this.highestTick) failure = "sequence";
      if (failure) { failures.push(failure); this.rejected[failure]++; continue; }
      try { validateInput(frame.input); } catch { failures.push("invalid"); this.rejected.invalid++; continue; }
      if (frame.tick < currentTick) {
        if (!lateFire!(frame)) { failures.push("stale"); this.rejected.stale++; continue; }
        this.highestSequence = frame.seq;
        this.highestTick = frame.tick;
        this.consumedSequence = frame.seq;
        continue;
      }
      this.highestSequence = frame.seq;
      this.rebasing = false;
      this.highestTick = frame.tick;
      this.frames.set(frame.tick, { seq: frame.seq, tick: frame.tick, viewTick: frame.viewTick, input: frame.input.slice() });
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
      this.lastConsumedTick = tick;
      this.held.set(frame.input);
      return { input: frame.input, seq: this.consumedSequence, repeated: false };
    }
    const view = new DataView(this.held.buffer);
    view.setUint16(0, view.getUint16(0, true) & HELD_CONTROL_BITS, true);
    if (tick - this.lastConsumedTick > STALE_HELD_TICKS) this.held.fill(0);
    return { input: this.held, seq: this.consumedSequence, repeated: true };
  }

  /** Explicit state resync discards unsimulated intent, never grants game time. */
  resync(currentTick: number): void {
    this.frames.clear(); this.held.fill(0);
    this.highestTick = currentTick - 1;
    this.rebasing = true;
  }

  get size(): number { return this.frames.size; }
  get lastConsumedSequence(): number { return this.consumedSequence; }
}
