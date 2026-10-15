/** Bounded, allocation-free recording; sorting happens only on explicit reads. */
export class FrameStats {
  private readonly cpu = new Float64Array(20000);
  private readonly interval = new Float64Array(20000);
  private start = 0;
  private last = 0;
  private size = 0;
  count = 0;
  record(cpuMs: number, now: number) {
    if (!this.start) this.start = now;
    const index = this.count % this.cpu.length;
    this.cpu[index] = cpuMs;
    this.interval[index] = this.last ? now - this.last : 0;
    this.last = now;
    this.count++;
    this.size = Math.min(this.count, this.cpu.length);
  }
  reset() {
    this.start = this.last = this.size = this.count = 0;
  }
  summary() {
    const cpu = Array.from(this.cpu.subarray(0, this.size)).sort(
        (a, b) => a - b,
      ),
      interval = Array.from(this.interval.subarray(0, this.size)).sort(
        (a, b) => a - b,
      );
    const p50 = Math.floor(this.size * 0.5),
      p99 = Math.min(this.size - 1, Math.floor(this.size * 0.99)),
      duration = this.last - this.start;
    return {
      frames: this.count,
      retainedSamples: this.size,
      durationMs: duration,
      averageFps: duration > 0 ? ((this.count - 1) * 1000) / duration : 0,
      cpuP50: cpu[p50] ?? 0,
      cpuP99: cpu[p99] ?? 0,
      intervalP50: interval[p50] ?? 0,
      intervalP99: interval[p99] ?? 0,
    };
  }
}
