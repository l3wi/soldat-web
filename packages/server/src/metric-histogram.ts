const NONNEGATIVE_BOUNDS = [0, ...Array.from({ length: 401 }, (_, index) => 2 ** ((index - 80) / 8))];
const INTEGER_BOUNDS = Array.from({ length: 257 }, (_, index) => index - 128);
export const MAX_METRIC_REPORT_SAMPLES = 8192;

export interface MetricHistogramSnapshot {
  count: number;
  min: number | null;
  max: number | null;
  invalidSamples: number;
  buckets: Float64Array;
}

export interface MetricSummary {
  count: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  invalidSamples: number;
  rejectedReports: number;
  rejectedSamples: number;
}

/** Full-window counts/extrema; quantiles are bucket upper-bound estimates.
 * Nonnegative metrics use eight buckets/octave from 2^-10 through 2^40 in
 * their native units (milliseconds or bytes), plus overflow.
 * Integer gauges use exact integer bounds -128..128 (plus overflow).
 * No raw values are retained. Oversized reports are rejected whole, not prefix-sampled.
 */
export class MetricHistogram {
  private readonly bounds: readonly number[];
  private readonly buckets: Float64Array;
  private count = 0;
  private min: number | null = null;
  private max: number | null = null;
  private readonly integer: boolean;
  private invalidSamples = 0;
  private rejectedReports = 0;
  private rejectedSamples = 0;

  constructor(integer = false) {
    this.integer = integer;
    this.bounds = integer ? INTEGER_BOUNDS : NONNEGATIVE_BOUNDS;
    this.buckets = new Float64Array(this.bounds.length + 1);
  }

  add(value: number): void {
    if (!Number.isFinite(value) || (!this.integer && value < 0)) { this.invalidSamples++; return; }
    let low = 0, high = this.bounds.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (value <= this.bounds[mid]!) high = mid;
      else low = mid + 1;
    }
    this.buckets[low] = this.buckets[low]! + 1;
    this.count++;
    this.min = this.min === null ? value : Math.min(this.min, value);
    this.max = this.max === null ? value : Math.max(this.max, value);
  }

  addReport(values: readonly number[]): void {
    if (!Array.isArray(values)) { this.rejectedReports++; return; }
    if (values.length > MAX_METRIC_REPORT_SAMPLES) {
      this.rejectedReports++;
      this.rejectedSamples = Math.min(Number.MAX_SAFE_INTEGER, this.rejectedSamples + values.length);
      return;
    }
    for (const value of values) this.add(value);
  }

  merge(snapshot: MetricHistogramSnapshot): void {
    // Validate fixed-size snapshots before touching the accumulator; malformed
    // reports cannot trigger an unbounded scan or partially alter statistics.
    if (!snapshot || snapshot.buckets?.length !== this.buckets.length || !Number.isSafeInteger(snapshot.count) || snapshot.count < 0
      || !Number.isSafeInteger(snapshot.invalidSamples) || snapshot.invalidSamples < 0
      || (snapshot.count === 0 ? snapshot.min !== null || snapshot.max !== null
        : !Number.isFinite(snapshot.min) || !Number.isFinite(snapshot.max) || snapshot.min! > snapshot.max! || (!this.integer && snapshot.min! < 0))) {
      this.rejectedReports++; return;
    }
    let count = 0;
    for (const value of snapshot.buckets) {
      if (!Number.isSafeInteger(value) || value < 0) { this.rejectedReports++; return; }
      count += value;
    }
    if (!Number.isSafeInteger(count) || count !== snapshot.count || !Number.isSafeInteger(this.count + count)
      || !Number.isSafeInteger(this.invalidSamples + snapshot.invalidSamples)) { this.rejectedReports++; return; }
    for (let index = 0; index < this.buckets.length; index++) this.buckets[index] = this.buckets[index]! + snapshot.buckets[index]!;
    this.count += count;
    this.invalidSamples += snapshot.invalidSamples;
    if (count) {
      this.min = this.min === null ? snapshot.min : Math.min(this.min, snapshot.min!);
      this.max = this.max === null ? snapshot.max : Math.max(this.max, snapshot.max!);
    }
  }

  take(): MetricHistogramSnapshot {
    const result = { count: this.count, min: this.min, max: this.max, invalidSamples: this.invalidSamples, buckets: this.buckets.slice() };
    this.buckets.fill(0);
    this.count = this.invalidSamples = this.rejectedReports = this.rejectedSamples = 0;
    this.min = this.max = null;
    return result;
  }

  summary(): MetricSummary {
    const percentile = (fraction: number): number | null => {
      if (!this.count) return null;
      const rank = Math.ceil(this.count * fraction);
      let count = 0;
      for (let index = 0; index < this.buckets.length; index++) {
        count += this.buckets[index]!;
        if (count >= rank) return Math.max(this.min!, Math.min(this.max!, this.bounds[index] ?? this.max!));
      }
      return this.max;
    };
    return { count: this.count, min: this.min, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: this.max,
      invalidSamples: this.invalidSamples, rejectedReports: this.rejectedReports, rejectedSamples: this.rejectedSamples };
  }
}
