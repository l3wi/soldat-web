const SECOND = 1_000_000_000n;
export const TICK_RATE = 60;
export const MAX_CATCH_UP = 4;

/** Optional observations use the caller's monotonic epoch, never a hidden real clock. */
export interface FixedStepTiming {
  now(): bigint;
  completed(latenessMs: number): void;
}

/** Scaled integer nanoseconds avoid rounding the 1/60-second tick duration. */
export class FixedStepAccumulator {
  private previous: bigint;
  private pending = 0n;
  overloads = 0;
  discardedSteps = 0n;

  constructor(start: bigint) { this.previous = start; }
  reset(now: bigint): void { this.previous = now; this.pending = 0n; }

  advance(now: bigint, step: (latenessMs: number) => void, tickScale = 1, timing?: FixedStepTiming): number {
    if (now < this.previous) throw new RangeError("Monotonic clock moved backwards");
    const rate = tickScale < 1 ? TICK_RATE / 3 : TICK_RATE, scaledRate = BigInt(rate);
    this.pending += (now - this.previous) * scaledRate;
    this.previous = now;
    let count = 0;
    while (this.pending >= SECOND && count < MAX_CATCH_UP) {
      // Only the original wake sample grants steps. Observation clocks include
      // earlier catch-up callback cost without changing catch-up/drop policy.
      const startedAt = timing?.now() ?? now;
      if (startedAt < now) throw new RangeError("Monotonic callback clock moved backwards");
      const due = this.pending - SECOND;
      step(Number(due + (startedAt - now) * scaledRate) / rate / 1_000_000);
      if (timing) {
        const completedAt = timing.now();
        if (completedAt < startedAt) throw new RangeError("Monotonic callback clock moved backwards");
        timing.completed(Number(due + (completedAt - now) * scaledRate) / rate / 1_000_000);
      }
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

  delayMilliseconds(now: bigint, tickScale = 1): number {
    if (now < this.previous) throw new RangeError("Monotonic clock moved backwards");
    // Work performed after advance() consumes the remaining tick interval too.
    // Sleeping the old remainder would add the previous tick's CPU cost to
    // every deadline even when the worker has ample time to run at 60 Hz.
    const rate = tickScale < 1 ? TICK_RATE / 3 : TICK_RATE;
    const remaining = SECOND - this.pending - (now - this.previous) * BigInt(rate);
    return Math.max(0, Number(remaining) / rate / 1_000_000);
  }
}
