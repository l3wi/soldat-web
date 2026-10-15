/** Acknowledging a snapshot promises its bytes remain available until the
 * ordered server stream proves a newer baseline is in use. Receipt age alone
 * cannot discharge that promise: ACK RTT and TCP HOL can exceed any short ring. */
export class SnapshotBaselines {
  private readonly states = new Map<number, Uint8Array>();
  private retainedBytes = 0;
  private lastServerBaseline = 0;
  private readonly maxBytes: number;
  private readonly capacity: number;
  constructor(maxBytes = 64 * 1024 * 1024, capacity = 128) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Invalid baseline retention bounds");
    this.maxBytes = maxBytes; this.capacity = capacity;
  }
  get bytes(): number { return this.retainedBytes; }
  get size(): number { return this.states.size; }
  get(id: number): Uint8Array | undefined { return this.states.get(id); }
  /** Returns whether it is safe to send snapshotAck for this state. At capacity
   * the snapshot can still be rendered/reconciled, but must not be acknowledged.
   * Never evict an ACK candidate the server might select in a later packet. */
  retain(id: number, confirmedBaselineId: number, state: Uint8Array): boolean {
    // A fullstate after the server has used a nonzero baseline proves a reset.
    // Initial fullstate bursts do not: their earlier ACKs can still be in flight.
    if (confirmedBaselineId === 0 && this.lastServerBaseline !== 0) this.clear();
    this.lastServerBaseline = confirmedBaselineId;
    for (const [previous, bytes] of this.states) {
      if (previous >= confirmedBaselineId) break;
      this.retainedBytes -= bytes.byteLength; this.states.delete(previous);
    }
    if (this.states.has(id)) return true;
    if (this.states.size >= this.capacity || this.retainedBytes + state.byteLength > this.maxBytes) return false;
    this.states.set(id, state); this.retainedBytes += state.byteLength;
    return true;
  }
  clear(): void { this.states.clear(); this.retainedBytes = 0; this.lastServerBaseline = 0; }
}
