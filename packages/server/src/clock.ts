const SECOND = 1_000_000_000n;
export const TICK_RATE = 60;
export const MAX_CATCH_UP = 4;

/** Scaled integer nanoseconds avoid rounding the 1/60-second tick duration. */
export class FixedStepAccumulator {
  private previous: bigint;
  private pending = 0n;
  overloads = 0;
  discardedSteps = 0n;

  constructor(start: bigint) { this.previous = start; }

  advance(now: bigint, step: (latenessMs: number) => void): number {
    if (now < this.previous) throw new RangeError("Monotonic clock moved backwards");
    this.pending += (now - this.previous) * BigInt(TICK_RATE);
    this.previous = now;
    let count = 0;
    while (this.pending >= SECOND && count < MAX_CATCH_UP) {
      step(Number(this.pending - SECOND) / TICK_RATE / 1_000_000);
      this.pending -= SECOND;
      count++;
    }
    if (this.pending >= SECOND) {
      this.overloads++;
      this.discardedSteps += this.pending / SECOND;
      this.pending %= SECOND;
    }
    return count;
  }

  delayMilliseconds(now: bigint): number {
    if (now < this.previous) throw new RangeError("Monotonic clock moved backwards");
    // Work performed after advance() consumes the remaining tick interval too.
    // Sleeping the old remainder would add the previous tick's CPU cost to
    // every deadline even when the worker has ample time to run at 60 Hz.
    const remaining = SECOND - this.pending - (now - this.previous) * BigInt(TICK_RATE);
    return Math.max(0, Number(remaining) / TICK_RATE / 1_000_000);
  }
}
