import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isGameMode } from "@soldat-web/protocol";
import type { GameServerOptions } from "./server.ts";
import { FIRE_ADMISSION_REASONS, type FireAdmissionReasons } from "./worker-messages.ts";
import { MAX_METRIC_REPORT_SAMPLES, MetricHistogram } from "./metric-histogram.ts";
import { TRANSPORT_METRICS, type TransportMetricName, type TransportQueueMetrics } from "./transport-metrics.ts";

type Metrics = Parameters<NonNullable<GameServerOptions["onMetrics"]>>[0];
interface MatchInfo { id: string; map: string; mode: string; targetPlayers: number; humans: number }
const MAX_MATCHES = 64;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024;
const metricNames = ["simEncodeMs", "workerSimEncodeMs", "wireEncodeMs", "workerCycleMs", "tickLatenessMs", "tickCompletionLatenessMs", "workerPublicationDelayMs", "replayMs", "inputBufferOccupancy", "inputBufferLeadTicks", "rttMs"] as const;
const counterNames = ["inboundBytes", "outboundBytes", "resyncRequests", "disconnects", "replayTicks", "rejectedShots", "uncompensatedShots", "replayBudgetFallbacks"] as const;
type MetricName = typeof metricNames[number];
type CounterName = typeof counterNames[number];


function sum(a: number, b: number): number { return Math.min(Number.MAX_SAFE_INTEGER, a + b); }
function finite(value: number): number | null { return Number.isFinite(value) ? value : null; }
function validCounter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function validInfo(info: MatchInfo): boolean {
  return Boolean(info) && typeof info === "object"
    && typeof info.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(info.id)
    && typeof info.map === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,95}$/.test(info.map)
    && isGameMode(info.mode)
    && Number.isInteger(info.targetPlayers) && info.targetPlayers >= 1 && info.targetPlayers <= 32
    && Number.isInteger(info.humans) && info.humans >= 0 && info.humans <= 32;
}

class MatchWindow {
  info: MatchInfo;
  readonly samples = Object.fromEntries(metricNames.map(name => [name, new MetricHistogram(name === "inputBufferOccupancy" || name === "inputBufferLeadTicks")])) as Record<MetricName, MetricHistogram>;
  readonly transport = Object.fromEntries(TRANSPORT_METRICS.map(name => [name, new MetricHistogram(name === "queuedPackets")])) as Record<TransportMetricName, MetricHistogram>;
  queueSampler: Metrics["sampleTransportQueue"] | undefined;
  readonly inputConsumption = { scheduled: 0, repeatedHeld: 0, timeoutNeutral: 0, maxMissingRunTicks: 0 };
  readonly serverMetricOverflow = { wireEncodeMs: 0, rttMs: 0, workerPublicationDelayMs: 0 };
  messageWorkMs = 0;
  readonly counters = Object.fromEntries(counterNames.map(name => [name, 0])) as Record<CounterName, number>;
  readonly fireAdmissionReasons = Object.fromEntries(FIRE_ADMISSION_REASONS.map(reason => [reason, 0])) as FireAdmissionReasons;
  invalidCounterSamples = 0;
  firstTick: number | null = null;
  lastTick: number | null = null;
  lastAt = 0;
  progressed = 0;
  observedMs = 0;
  resets = 0;
  overloads: number | null = null;
  discardedSteps: string | null = null;

  constructor(info: MatchInfo) { this.info = { id: info.id, map: info.map, mode: info.mode, targetPlayers: info.targetPlayers, humans: info.humans }; }

  record(info: MatchInfo, sample: Metrics, now: number): void {
    this.info.map = info.map; this.info.mode = info.mode; this.info.targetPlayers = info.targetPlayers; this.info.humans = info.humans;
    for (const name of metricNames) {
      this.samples[name].addReport(sample[name]);
    }
    for (const name of counterNames) {
      if (validCounter(sample[name])) this.counters[name] = sum(this.counters[name], sample[name]);
      else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
    }
    for (const reason of FIRE_ADMISSION_REASONS) {
      const value = sample.fireAdmissionReasons?.[reason];
      if (validCounter(value)) this.fireAdmissionReasons[reason] = sum(this.fireAdmissionReasons[reason], value);
      else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
    }
    for (const name of ["scheduled", "repeatedHeld", "timeoutNeutral", "maxMissingRunTicks"] as const) {
      const value = sample.inputConsumption?.[name];
      if (validCounter(value)) this.inputConsumption[name] = name === "maxMissingRunTicks" ? Math.max(this.inputConsumption[name], value) : sum(this.inputConsumption[name], value);
      else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
    }
    for (const name of ["wireEncodeMs", "rttMs", "workerPublicationDelayMs"] as const) {
      const value = sample.serverMetricOverflow?.[name];
      if (validCounter(value)) this.serverMetricOverflow[name] = sum(this.serverMetricOverflow[name], value);
      else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
      this.samples[name].merge(sample.serverMetricOverflowHistograms?.[name]);
    }
    if (Number.isFinite(sample.messageWorkMs) && sample.messageWorkMs >= 0) this.messageWorkMs = sum(this.messageWorkMs, sample.messageWorkMs);
    else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
    this.mergeTransport(sample.transportQueue);
    if (typeof sample.sampleTransportQueue === "function") this.queueSampler = sample.sampleTransportQueue;
    else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
    if (validCounter(sample.overloads)) this.overloads = sample.overloads;
    else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
    if (typeof sample.discardedSteps === "string" && sample.discardedSteps.length <= 128 && /^\d+$/.test(sample.discardedSteps)) this.discardedSteps = sample.discardedSteps;
    else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
    if (validCounter(sample.serverTick)) {
      if (this.lastTick !== null) {
        if (sample.serverTick < this.lastTick) this.resets = sum(this.resets, 1);
        else if (now >= this.lastAt) {
          this.progressed = sum(this.progressed, sample.serverTick - this.lastTick);
          this.observedMs += now - this.lastAt;
        }
      }
      this.firstTick ??= sample.serverTick;
      this.lastTick = sample.serverTick;
      this.lastAt = now;
    } else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
  }

  private mergeTransport(metrics: TransportQueueMetrics): void {
    for (const name of TRANSPORT_METRICS) this.transport[name].merge(metrics?.[name]);
  }

  recordObject(): object {
    if (this.queueSampler) {
      try {
        const metrics = this.queueSampler();
        if (metrics) this.mergeTransport(metrics);
        else this.queueSampler = undefined;
      } catch { this.invalidCounterSamples = sum(this.invalidCounterSamples, 1); this.queueSampler = undefined; }
    }
    const { outboundBytes, ...interval } = this.counters;
    return {
      match: this.info,
      ticks: { first: this.firstTick, last: this.lastTick, progressed: this.progressed, observedMs: this.observedMs, progressionPerSecond: this.observedMs > 0 ? this.progressed * 1000 / this.observedMs : null, resets: this.resets },
      samplePolicy: "full_window_fixed_histograms",
      accounting: { simEncodeMs: "legacy_nested_worker_work_plus_main_wire_encode_not_end_to_end_latency", workerSimEncodeMs: "legacy_nested_worker_work_not_end_to_end_latency" },
      quantilePolicy: { nonnegative: "upper_bound_8_buckets_per_octave_2^-10_to_2^40_clamped_to_extrema", integer: "upper_bound_integer_-128_to_128_clamped_to_extrema", maxSamplesPerMetricReport: MAX_METRIC_REPORT_SAMPLES, oversized: "reject_whole_metric_report" },
      summaries: Object.fromEntries(metricNames.map(name => [name, this.samples[name].summary()])),
      transportQueue: Object.fromEntries(TRANSPORT_METRICS.map(name => [name, this.transport[name].summary()])),
      interval: { ...interval, outboundOfferedBytes: outboundBytes, messageWorkMs: this.messageWorkMs,
        inputConsumption: { ...this.inputConsumption }, serverMetricOverflow: { ...this.serverMetricOverflow }, fireAdmissionReasons: { ...this.fireAdmissionReasons } },
      cumulative: { overloads: this.overloads, discardedSteps: this.discardedSteps },
      invalidCounterSamples: this.invalidCounterSamples,
    };
  }
}

export interface PerformanceRuntimeSample {
  memoryBytes: { rss: number; mainHeapUsed: number; mainHeapTotal: number; external: number };
  cpu: { userMs: number; systemMs: number; percentOfOneCore: number };
  eventLoopDelayMs: { count: number; min: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null };
  eventLoop: { activeMs: number; idleMs: number; utilization: number };
  uptimeSeconds: number;
}

/** Dependency boundary for deterministic tests; production uses startPerformanceLogging. */
export interface PerformanceEnvironment {
  nowMs(): number;
  timestamp(): string;
  sink: { readonly writableLength: number; readonly writableNeedDrain: boolean; readonly destroyed?: boolean; write(line: string): boolean };
  runtime(): PerformanceRuntimeSample;
  schedule(flush: () => void): () => void;
  stopObservation(): void;
}

export interface PerformanceLogging {
  recordMatch(info: MatchInfo, sample: Metrics): void;
  close(): void;
}

export function createPerformanceLogging(environment: PerformanceEnvironment): PerformanceLogging {
  const matches = new Map<string, MatchWindow>();
  let startedAt = environment.nowMs();
  let closed = false;
  let droppedMatches = 0, droppedRecords = 0, invalidMetadata = 0, invalidReports = 0, writeErrors = 0;

  function emit(record: object): boolean {
    // No private queue or drain listeners: when stdout is backed up, discard
    // this window and report the counted loss in the next writable window.
    try {
      const sink = environment.sink;
      if (sink.destroyed || sink.writableNeedDrain || sink.writableLength >= MAX_QUEUED_BYTES) {
        droppedRecords = sum(droppedRecords, 1); return false;
      }
      const line = JSON.stringify(record) + "\n";
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_RECORD_BYTES || sink.writableLength + bytes > MAX_QUEUED_BYTES) {
        droppedRecords = sum(droppedRecords, 1); return false;
      }
      // A false return still accepts this record. writableNeedDrain prevents
      // submitting the next one until the stream is writable again.
      sink.write(line);
      return true;
    } catch {
      writeErrors = sum(writeErrors, 1);
      droppedRecords = sum(droppedRecords, 1);
      return false;
    }
  }

  function flush(): void {
    if (closed) return;
    const now = environment.nowMs();
    const common = { schemaVersion: 2, timestamp: environment.timestamp(), windowMs: Math.max(0, now - startedAt) };
    for (const [id, match] of matches) {
      emit({ ...common, type: "match_performance", ...match.recordObject() });
      // Keep only live samplers, not raw metrics, so a queue stalled across
      // multiple windows remains visible even if its worker publishes nothing.
      if (match.queueSampler) {
        const next = new MatchWindow(match.info);
        next.queueSampler = match.queueSampler;
        matches.set(id, next);
      } else matches.delete(id);
    }
    const runtime = environment.runtime();
    // Copy the runtime schema explicitly too: no future diagnostics fields
    // can accidentally turn production logs into a raw profiling dump.
    const memory = runtime.memoryBytes, cpu = runtime.cpu, delay = runtime.eventLoopDelayMs, loop = runtime.eventLoop;
    const written = emit({
      ...common, type: "server_performance",
      runtime: {
        memoryBytes: { rss: finite(memory.rss), mainHeapUsed: finite(memory.mainHeapUsed), mainHeapTotal: finite(memory.mainHeapTotal), external: finite(memory.external) },
        cpu: { userMs: finite(cpu.userMs), systemMs: finite(cpu.systemMs), percentOfOneCore: finite(cpu.percentOfOneCore) },
        eventLoopDelayMs: { count: finite(delay.count), min: delay.min === null ? null : finite(delay.min), p50: delay.p50 === null ? null : finite(delay.p50), p95: delay.p95 === null ? null : finite(delay.p95), p99: delay.p99 === null ? null : finite(delay.p99), max: delay.max === null ? null : finite(delay.max) },
        eventLoop: { activeMs: finite(loop.activeMs), idleMs: finite(loop.idleMs), utilization: finite(loop.utilization) },
        uptimeSeconds: finite(runtime.uptimeSeconds),
      },
      logging: { droppedMatches, droppedRecords, invalidMetadata, invalidReports, writeErrors },
      ...(droppedMatches || droppedRecords || invalidMetadata || invalidReports || writeErrors ? { warning: "performance_logging_dropped_data" } : {}),
    });
    if (written) droppedMatches = droppedRecords = invalidMetadata = invalidReports = writeErrors = 0;
    startedAt = now;
  }

  const stopTimer = environment.schedule(flush);
  return {
    recordMatch(info, sample) {
      if (closed) return;
      if (!validInfo(info)) { invalidMetadata = sum(invalidMetadata, 1); return; }
      if (!sample || typeof sample !== "object" || sample.type !== "metrics") { invalidReports = sum(invalidReports, 1); return; }
      let match = matches.get(info.id);
      if (!match) {
        if (matches.size >= MAX_MATCHES) { droppedMatches = sum(droppedMatches, 1); return; }
        match = new MatchWindow(info); matches.set(info.id, match);
      }
      match.record(info, sample, environment.nowMs());
    },
    close() {
      if (closed) return;
      stopTimer();
      try { flush(); }
      finally { closed = true; matches.clear(); environment.stopObservation(); }
    },
  };
}

export function startPerformanceLogging(): PerformanceLogging {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let previousCpu = process.cpuUsage();
  let previousAt = performance.now();
  let previousLoop = performance.eventLoopUtilization();
  return createPerformanceLogging({
    nowMs: () => performance.now(),
    timestamp: () => new Date().toISOString(),
    sink: process.stdout,
    schedule: flush => { const timer = setInterval(flush, 10_000); timer.unref(); return () => clearInterval(timer); },
    stopObservation: () => { histogram.disable(); },
    runtime: () => {
      const memory = process.memoryUsage();
      const at = performance.now(), cpu = process.cpuUsage(), loop = performance.eventLoopUtilization();
      const cpuUserMs = (cpu.user - previousCpu.user) / 1000, cpuSystemMs = (cpu.system - previousCpu.system) / 1000;
      const elapsedMs = at - previousAt;
      const loopDelta = performance.eventLoopUtilization(loop, previousLoop);
      previousCpu = cpu; previousAt = at; previousLoop = loop;
      const delay = (percentile: number) => histogram.count ? histogram.percentile(percentile) / 1_000_000 : null;
      const result: PerformanceRuntimeSample = {
        memoryBytes: { rss: memory.rss, mainHeapUsed: memory.heapUsed, mainHeapTotal: memory.heapTotal, external: memory.external },
        cpu: { userMs: cpuUserMs, systemMs: cpuSystemMs, percentOfOneCore: elapsedMs > 0 ? (cpuUserMs + cpuSystemMs) * 100 / elapsedMs : 0 },
        eventLoopDelayMs: { count: histogram.count, min: histogram.count ? histogram.min / 1_000_000 : null, p50: delay(50), p95: delay(95), p99: delay(99), max: histogram.count ? histogram.max / 1_000_000 : null },
        eventLoop: { activeMs: loopDelta.active, idleMs: loopDelta.idle, utilization: loopDelta.utilization },
        uptimeSeconds: process.uptime(),
      };
      histogram.reset();
      return result;
    },
  });
}
