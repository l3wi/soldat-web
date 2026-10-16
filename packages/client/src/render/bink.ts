import { SIM_PRESENTATION_EVENTS } from "@soldat-web/sim-host";

/** FPC Round uses nearest, ties-to-even, unlike JavaScript Math.round. */
export function roundEven(value: number): number {
  const lower = Math.floor(value), fraction = value - lower;
  return fraction === 0.5 ? lower + (lower & 1) : Math.round(value);
}

/** Original Weapons.CalculateBink: Word result and diminishing returns. */
export function calculateBink(accumulated: number, amount: number): number {
  if (amount === 0) return accumulated;
  return (accumulated + amount - roundEven(accumulated * (accumulated / (10 * amount + accumulated)))) & 0xffff;
}

/** Client-only HitSprayCounter; never serialized into authoritative simulation.
 * Consume one complete live-step event batch. Reconciliation/REPLAY must not
 * reapply increments or decay a previously presented tick a second time. */
export class CursorBink {
  counter = 0;
  private lastTick = -1;
  clear(): void { this.counter = 0; this.lastTick = -1; }
  liveStep(tick: number, bytes: Uint8Array, slot: number): void {
    if (tick <= this.lastTick) return;
    if (this.lastTick >= 0) this.counter = Math.max(0, this.counter - Math.max(0, tick - this.lastTick - 1));
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.length;) {
      if (bytes.length - offset < 20) throw new Error("Truncated bink event header");
      const length = data.getUint32(offset + 16, true), end = offset + 20 + length;
      if (end > bytes.length) throw new Error("Truncated bink event payload");
      if (data.getUint32(offset, true) === SIM_PRESENTATION_EVENTS.BINK && data.getUint32(offset + 8, true) === slot) {
        if (length !== 4) throw new Error("Unsupported bink event payload");
        const amount = data.getInt32(offset + 20, true);
        if (amount < 0 || amount > 65535) throw new Error("Invalid bink increment");
        this.counter = amount === 0 ? 0 : calculateBink(this.counter, amount);
      }
      offset = end;
    }
    // UpdateFrame decrements after sprite/bullet updates (and their increments).
    if (this.counter > 0) this.counter--;
    this.lastTick = tick;
  }
}
