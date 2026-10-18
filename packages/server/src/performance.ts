import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isGameMode } from "@soldat-web/protocol";
import type { GameServerOptions } from "./server.ts";

type Metrics = Parameters<NonNullable<GameServerOptions["onMetrics"]>>[0];
interface MatchInfo { id: string; map: string; mode: string; targetPlayers: number; humans: number }
const MAX_SAMPLES = 2048;
const MAX_MATCHES = 64;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024;
const metricNames = ["simEncodeMs", "workerSimEncodeMs", "wireEncodeMs", "tickLatenessMs", "replayMs", "inputBufferOccupancy", "inputBufferLeadTicks", "rttMs"] as const;
const counterNames = ["inboundBytes", "outboundBytes", "resyncRequests", "disconnects", "replayTicks", "rejectedShots", "uncompensatedShots", "replayBudgetFallbacks"] as const;
type MetricName = typeof metricNames[number];
type CounterName = typeof counterNames[number];

interface Summary {
  count: number; min: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null;
  truncatedSamples: number; invalidSamples: number;
}

class Samples {
  readonly values: number[] = [];
  truncatedSamples = 0;
  invalidSamples = 0;

  add(values: readonly number[]): void {
    // Bound processing as well as retention. Unexamined values count as truncated,
    // not valid samples; invalidSamples only describes inspected values.
    const inspected = Math.min(values.length, MAX_SAMPLES - this.values.length);
    for (let i = 0; i < inspected; i++) {
      const value = values[i]!;
      if (Number.isFinite(value)) this.values.push(value);
      else this.invalidSamples++;
    }
    this.truncatedSamples = sum(this.truncatedSamples, values.length - inspected);
  }

  summary(): Summary {
    this.values.sort((a, b) => a - b);
    const n = this.values.length;
    const percentile = (fraction: number) => n ? this.values[Math.ceil(n * fraction) - 1]! : null;
    return { count: n, min: this.values[0] ?? null, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: this.values[n - 1] ?? null, truncatedSamples: this.truncatedSamples, invalidSamples: this.invalidSamples };
  }
}

function sum(a: number, b: number): number { return Math.min(Number.MAX_SAFE_INTEGER, a + b); }
function finite(value: number): number | null { return Number.isFinite(value) ? value : null; }
function validCounter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function validInfo(info: MatchInfo): boolean {
  return typeof info.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(info.id)
    && typeof info.map === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,95}$/.test(info.map)
    && isGameMode(info.mode)
    && Number.isInteger(info.targetPlayers) && info.targetPlayers >= 1 && info.targetPlayers <= 32
    && Number.isInteger(info.humans) && info.humans >= 0 && info.humans <= 32;
}

class MatchWindow {
  info: MatchInfo;
  readonly samples = Object.fromEntries(metricNames.map(name => [name, new Samples()])) as Record<MetricName, Samples>;
  readonly counters = Object.fromEntries(counterNames.map(name => [name, 0])) as Record<CounterName, number>;
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
      this.samples[name].add(sample[name]);
    }
    for (const name of counterNames) {
      if (validCounter(sample[name])) this.counters[name] = sum(this.counters[name], sample[name]);
      else this.invalidCounterSamples = sum(this.invalidCounterSamples, 1);
    }
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

  recordObject(): object {
    const { outboundBytes, ...interval } = this.counters;
    return {
      match: this.info,
      ticks: { first: this.firstTick, last: this.lastTick, progressed: this.progressed, observedMs: this.observedMs, progressionPerSecond: this.observedMs > 0 ? this.progressed * 1000 / this.observedMs : null, resets: this.resets },
      samplePolicy: "first_2048_per_metric_per_window",
      summaries: Object.fromEntries(metricNames.map(name => [name, this.samples[name].summary()])),
      interval: { ...interval, outboundOfferedBytes: outboundBytes },
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
  let droppedMatches = 0, droppedRecords = 0, invalidMetadata = 0, writeErrors = 0;

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
    const common = { schemaVersion: 1, timestamp: environment.timestamp(), windowMs: Math.max(0, now - startedAt) };
    for (const match of matches.values()) emit({ ...common, type: "match_performance", ...match.recordObject() });
    matches.clear();
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
      logging: { droppedMatches, droppedRecords, invalidMetadata, writeErrors },
      ...(droppedMatches || droppedRecords || invalidMetadata || writeErrors ? { warning: "performance_logging_dropped_data" } : {}),
    });
    if (written) droppedMatches = droppedRecords = invalidMetadata = writeErrors = 0;
    startedAt = now;
  }

  const stopTimer = environment.schedule(flush);
  return {
    recordMatch(info, sample) {
      if (closed) return;
      if (!validInfo(info)) { invalidMetadata = sum(invalidMetadata, 1); return; }
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
      finally { closed = true; environment.stopObservation(); }
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
