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

  advance(now: bigint, step: () => void): number {
    if (now < this.previous) throw new RangeError("Monotonic clock moved backwards");
    this.pending += (now - this.previous) * BigInt(TICK_RATE);
    this.previous = now;
    let count = 0;
    while (this.pending >= SECOND && count < MAX_CATCH_UP) {
      step();
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

  get delayMilliseconds(): number {
    return Number(SECOND - this.pending) / TICK_RATE / 1_000_000;
  }
}
