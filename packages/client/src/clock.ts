export const TICK_MS = 1000 / 60;
/** Monotonic clock with bounded catch-up. Hidden time and overload debt are
 * discarded, never replayed as a burst on resume. Shared by live and replay. */
export class ClientClock {
  fraction = 0;
  droppedTicks = 0;
  private previous = Number.NaN;
  private accumulator = 0;
  reset(): void { this.previous = Number.NaN; this.accumulator = 0; this.fraction = 0; }
  advance(now: number, step: () => void): number {
    if (!Number.isFinite(now)) throw new Error("Client clock requires monotonic milliseconds");
    if (Number.isNaN(this.previous)) { this.previous = now; return 0; }
    this.accumulator += Math.max(0, now - this.previous);
    this.previous = now;
    let count = 0;
    while (this.accumulator + 1e-8 >= TICK_MS && count < 4) {
      step(); this.accumulator -= TICK_MS; count++;
    }
    if (this.accumulator >= TICK_MS) {
      const dropped = Math.floor(this.accumulator / TICK_MS);
      this.droppedTicks += dropped; this.accumulator -= dropped * TICK_MS;
    }
    this.fraction = Math.max(0, Math.min(1, this.accumulator / TICK_MS));
    return count;
  }
}
