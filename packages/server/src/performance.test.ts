import assert from "node:assert/strict";
import test from "node:test";
import type { GameServerOptions } from "./server.ts";
import { createPerformanceLogging, type PerformanceRuntimeSample } from "./performance.ts";
import { FIRE_ADMISSION_REASONS } from "./worker-messages.ts";

type Metrics = Parameters<NonNullable<GameServerOptions["onMetrics"]>>[0];
const info = { id: "12345678-1234-4234-8234-123456789abc", map: "Arena", mode: "dm", targetPlayers: 8, humans: 2 };
function sample(overrides: Partial<Metrics> = {}): Metrics {
  return {
    type: "metrics", serverTick: 60, overloads: 3, discardedSteps: "17", simEncodeMs: [1, 2, 3], workerSimEncodeMs: [0.5, 1, 2], wireEncodeMs: [0.1],
    tickLatenessMs: [0, 2], replayMs: [1], replayTicks: 2, rejectedShots: 1, uncompensatedShots: 2, replayBudgetFallbacks: 1,
    fireAdmissionReasons: Object.fromEntries(FIRE_ADMISSION_REASONS.map(reason => [reason, 0])) as Metrics["fireAdmissionReasons"],
    inputBufferOccupancy: [0, 3], inputBufferLeadTicks: [-1, 2], rttMs: [20, 40], inboundBytes: 100, outboundBytes: 200, resyncRequests: 1, disconnects: 1,
    ...overrides,
  };
}

function harness() {
  let now = 0, scheduled: (() => void) | undefined, stopped = 0, disabled = 0;
  const lines: string[] = [];
  const sink = {
    writableLength: 0,
    writableNeedDrain: false,
    destroyed: false,
    fail: false,
    backpressure: false,
    write(line: string) {
      if (this.fail) throw new Error("secret sink credentials must not be logged");
      lines.push(line);
      if (this.backpressure) { this.writableNeedDrain = true; return false; }
      return true;
    },
  };
  const runtime: PerformanceRuntimeSample = {
    memoryBytes: { rss: 1000, mainHeapUsed: 100, mainHeapTotal: 200, external: 50 },
    cpu: { userMs: 40, systemMs: 10, percentOfOneCore: 0.5 },
    eventLoopDelayMs: { count: 2, min: 1, p50: 1, p95: 2, p99: 2, max: 2 },
    eventLoop: { activeMs: 25, idleMs: 9975, utilization: 0.0025 },
    uptimeSeconds: 10,
  };
  const logging = createPerformanceLogging({
    nowMs: () => now,
    timestamp: () => "2026-10-18T00:00:00.000Z",
    sink,
    runtime: () => runtime,
    schedule: flush => { scheduled = flush; return () => { stopped++; }; },
    stopObservation: () => { disabled++; },
  });
  return {
    logging, sink, lines, runtime,
    at(value: number) { now = value; },
    flush(value = now + 10_000) { now = value; scheduled!(); },
    records() { return lines.map(line => JSON.parse(line)); },
    shutdownCounts() { return { stopped, disabled }; },
  };
}

test("nearest-rank percentiles summarize known costs, signed buffer lead and fresh RTT measurements", () => {
  const h = harness();
  h.logging.recordMatch(info, sample({ simEncodeMs: Array.from({ length: 100 }, (_, i) => 100 - i), rttMs: [500] }));
  h.at(1000);
  h.logging.recordMatch(info, sample({ simEncodeMs: [], rttMs: [20, 40] }));
  h.flush(10_000);
  const [match, server] = h.records();
  assert.deepEqual(match.summaries.simEncodeMs, { count: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100, truncatedSamples: 0, invalidSamples: 0 });
  assert.equal(match.summaries.inputBufferLeadTicks.min, -1);
  assert.equal(match.summaries.rttMs.count, 3);
  assert.equal(match.summaries.rttMs.max, 500);
  assert.equal(match.summaries.rttMs.p50, 40);
  h.logging.close();
});

test("window counters sum interval deltas, retain clearly cumulative latest values and reset on flush", () => {
  const h = harness();
  h.logging.recordMatch(info, sample());
  h.at(1000);
  h.logging.recordMatch({ ...info, humans: 3 }, sample({ serverTick: 120, overloads: 4, discardedSteps: "20" }));
  h.flush(10_000);
  const first = h.records()[0];
  assert.deepEqual(first.interval, { inboundBytes: 200, resyncRequests: 2, disconnects: 2, replayTicks: 4, rejectedShots: 2, uncompensatedShots: 4, replayBudgetFallbacks: 2, outboundOfferedBytes: 400, fireAdmissionReasons: sample().fireAdmissionReasons });
  assert.deepEqual(first.cumulative, { overloads: 4, discardedSteps: "20" });
  assert.equal(first.match.humans, 3);
  assert.equal(first.ticks.progressionPerSecond, 60);
  h.logging.recordMatch(info, sample({ serverTick: 180, overloads: 5, discardedSteps: "25" }));
  h.flush(20_000);
  const second = h.records()[2];
  assert.equal(second.windowMs, 10_000);
  assert.equal(second.interval.inboundBytes, 100);
  assert.equal(second.summaries.simEncodeMs.count, 3);
  assert.deepEqual(second.cumulative, { overloads: 5, discardedSteps: "25" });
  assert.equal(second.ticks.progressionPerSecond, null, "one observation cannot establish a rate");
  h.logging.close();
});

test("fire admission reasons sum only fixed keys, bound invalid counters and reset each window", () => {
  const h = harness();
  const first = sample();
  Object.assign(first.fireAdmissionReasons, { fallbackAge: 2, fallbackBudget: 1, rejectWeapon: 3, rejectAction: -1, fallbackView: Infinity, "player-secret-token": 9 });
  h.logging.recordMatch(info, first);
  const second = sample();
  Object.assign(second.fireAdmissionReasons, { fallbackAge: 4, rejectWeapon: 1, fallbackBudget: Number.MAX_SAFE_INTEGER });
  h.logging.recordMatch(info, second);
  h.flush();
  const record = h.records()[0];
  assert.equal(record.interval.fireAdmissionReasons.fallbackAge, 6);
  assert.equal(record.interval.fireAdmissionReasons.rejectWeapon, 4);
  assert.equal(record.interval.fireAdmissionReasons.fallbackBudget, Number.MAX_SAFE_INTEGER);
  assert.equal(record.interval.fireAdmissionReasons.rejectAction, 0);
  assert.equal(record.interval.fireAdmissionReasons.fallbackView, 0);
  assert.deepEqual(Object.keys(record.interval.fireAdmissionReasons), [...FIRE_ADMISSION_REASONS]);
  assert.equal(record.invalidCounterSamples, 2);
  assert.equal(h.lines.join("").includes("player-secret-token"), false);
  h.logging.recordMatch(info, sample());
  h.flush();
  assert.deepEqual(h.records()[2].interval.fireAdmissionReasons, sample().fireAdmissionReasons);
  h.logging.close();
});

test("paused and reset ticks are observed progression, never an inferred dropped-tick rate", () => {
  const h = harness();
  h.logging.recordMatch(info, sample({ serverTick: 100 }));
  h.at(1000); h.logging.recordMatch(info, sample({ serverTick: 100, simEncodeMs: [] }));
  h.at(2000); h.logging.recordMatch(info, sample({ serverTick: 10 }));
  h.at(3000); h.logging.recordMatch(info, sample({ serverTick: 30 }));
  h.flush(10_000);
  assert.deepEqual(h.records()[0].ticks, { first: 100, last: 30, progressed: 20, observedMs: 2000, progressionPerSecond: 10, resets: 1 });
  h.flush(20_000);
  assert.equal(h.records().at(-1).type, "server_performance", "runtime continues without match observations");
  assert.equal(h.records().length, 3);
  h.logging.close();
});

test("each metric retains at most 2048 values and reports ignored nonfinite and truncated samples", () => {
  const h = harness();
  h.logging.recordMatch(info, sample({ simEncodeMs: [NaN, Infinity, -Infinity, 4], replayMs: [], inputBufferOccupancy: Array(10_000).fill(3), rttMs: Array(3000).fill(20), inboundBytes: NaN }));
  h.logging.recordMatch(info, sample({ simEncodeMs: Array(5000).fill(7), inputBufferOccupancy: Array(4000).fill(4), rttMs: [Infinity, 30], inboundBytes: Infinity }));
  h.flush();
  const match = h.records()[0];
  assert.equal(match.summaries.simEncodeMs.count, 2048);
  assert.equal(match.summaries.simEncodeMs.invalidSamples, 3);
  assert.equal(match.summaries.simEncodeMs.truncatedSamples, 2953);
  assert.equal(match.summaries.inputBufferOccupancy.count, 2048);
  assert.equal(match.summaries.inputBufferOccupancy.truncatedSamples, 11_952);
  assert.equal(match.summaries.rttMs.count, 2048);
  assert.equal(match.summaries.rttMs.invalidSamples, 0);
  assert.equal(match.summaries.rttMs.truncatedSamples, 954, "uninspected excess values are truncated, not classified as invalid");
  assert.equal(match.interval.inboundBytes, 0);
  assert.equal(match.invalidCounterSamples, 2);
  assert.equal(match.summaries.replayMs.count, 1);
  assert.ok(h.lines.every(line => Buffer.byteLength(line) <= 16 * 1024));
  h.logging.close();
});

test("only 64 matches are pending per window and dropped match samples are reported", () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.logging.recordMatch({ ...info, id: `12345678-1234-4234-8234-${i.toString(16).padStart(12, "0")}` }, sample());
  h.flush();
  assert.equal(h.records().filter(record => record.type === "match_performance").length, 64);
  assert.equal(h.records().at(-1).logging.droppedMatches, 36);
  h.logging.recordMatch(info, sample());
  h.flush();
  assert.equal(h.records().at(-1).logging.droppedMatches, 0);
  assert.equal(h.records().at(-2).match.id, info.id);
  h.logging.close();
});

test("allowlisted metadata and summaries never include raw profile or arbitrary credentials", () => {
  const h = harness();
  const secret = "operator-token-and-player-name-and-chat";
  const contaminatedInfo = { ...info, nickname: secret, token: secret, ip: "192.0.2.10", chat: secret };
  const contaminatedSample = { ...sample(), authorization: secret, workProfile: [{ tick: 1, stepMs: 1, saveMs: 1, hashMs: 1, recordsMs: 1, postMs: 1, recordEncodes: 1, recipients: 1, controls: [{ slot: 7, seq: 10, repeated: false, bits: 0, rejected: { [secret]: 1 } }] }], gc: [{ atMs: 0, durationMs: 1, kind: 1 }] };
  Object.assign(h.runtime, { token: secret });
  Object.assign(h.runtime.memoryBytes, { playerName: secret });
  h.logging.recordMatch(contaminatedInfo, contaminatedSample);
  h.logging.recordMatch({ ...info, id: secret }, sample());
  h.logging.recordMatch({ ...info, map: "Arena\nsecret=credential" }, sample());
  h.flush();
  const output = h.lines.join("");
  for (const forbidden of [secret, "192.0.2.10", "workProfile", "controls", "playerName", '"gc"']) assert.equal(output.includes(forbidden), false);
  assert.deepEqual(h.records()[0].match, info);
  assert.equal(h.records().at(-1).logging.invalidMetadata, 2);
  assert.ok(h.lines.every(line => line.endsWith("\n") && line.split("\n").length === 2));
  h.logging.close();
});

test("stdout queue budget skips without retry queues and reports drops in a later writable window", () => {
  const h = harness();
  h.sink.writableLength = 64 * 1024 - 1;
  h.logging.recordMatch(info, sample());
  h.flush();
  assert.equal(h.lines.length, 0);
  h.sink.writableLength = 0;
  h.flush();
  assert.equal(h.records()[0].logging.droppedRecords, 2);
  assert.equal(h.records()[0].logging.writeErrors, 0);
  h.flush();
  assert.equal(h.records()[1].logging.droppedRecords, 0);
  h.logging.close();
});

test("write false accepts one record but prevents subsequent backpressured writes", () => {
  const h = harness();
  h.sink.backpressure = true;
  h.logging.recordMatch(info, sample());
  h.flush();
  assert.equal(h.records().length, 1);
  assert.equal(h.records()[0].type, "match_performance");
  h.sink.backpressure = false; h.sink.writableNeedDrain = false;
  h.flush();
  assert.equal(h.records()[1].logging.droppedRecords, 1);
  h.logging.close();
});

test("sink exceptions are contained and counted without logging exception messages", () => {
  const h = harness();
  h.sink.fail = true;
  assert.doesNotThrow(() => h.logging.recordMatch(info, sample()));
  assert.doesNotThrow(() => h.flush());
  h.sink.fail = false;
  h.flush();
  assert.deepEqual(h.records()[0].logging, { droppedMatches: 0, droppedRecords: 2, invalidMetadata: 0, writeErrors: 2 });
  assert.equal(h.records()[0].warning, "performance_logging_dropped_data");
  assert.equal(h.lines.join("").includes("secret"), false);
  h.logging.close();
});

test("shutdown flushes once, stops timer and observation, and ignores future observations", () => {
  const h = harness();
  h.at(2500); h.logging.recordMatch(info, sample());
  h.logging.close();
  assert.equal(h.records().length, 2);
  assert.equal(h.records()[0].windowMs, 2500);
  assert.deepEqual(h.shutdownCounts(), { stopped: 1, disabled: 1 });
  h.logging.close(); h.logging.recordMatch(info, sample()); h.flush();
  assert.equal(h.records().length, 2);
  assert.deepEqual(h.shutdownCounts(), { stopped: 1, disabled: 1 });
});

test("empty histograms and nonfinite runtime values remain parseable with explicit nulls", () => {
  const h = harness();
  h.runtime.eventLoopDelayMs = { count: 0, min: null, p50: null, p95: null, p99: null, max: null };
  h.runtime.cpu.userMs = NaN;
  h.runtime.eventLoop.utilization = Infinity;
  h.flush();
  const runtime = h.records()[0].runtime;
  assert.equal(runtime.eventLoopDelayMs.count, 0);
  assert.equal(runtime.eventLoopDelayMs.p99, null);
  assert.equal(runtime.cpu.userMs, null);
  assert.equal(runtime.eventLoop.utilization, null);
  h.logging.close();
});

test("a whole flush cannot enqueue more than 64 KiB even before stdout signals backpressure", () => {
  const h = harness();
  h.sink.write = line => {
    h.sink.writableLength += Buffer.byteLength(line);
    h.lines.push(line);
    return true;
  };
  for (let i = 0; i < 64; i++) h.logging.recordMatch({ ...info, id: `12345678-1234-4234-8234-${i.toString(16).padStart(12, "0")}` }, sample());
  h.flush();
  assert.ok(h.sink.writableLength <= 64 * 1024);
  const writtenMatches = h.records().filter(record => record.type === "match_performance").length;
  assert.ok(writtenMatches > 0 && writtenMatches < 64);
  const firstRuntime = h.records().find(record => record.type === "server_performance");
  h.sink.writableLength = 0;
  h.flush();
  const recovered = h.records().at(-1);
  assert.equal(recovered.type, "server_performance");
  assert.equal(firstRuntime ? firstRuntime.logging.droppedRecords : recovered.logging.droppedRecords, 64 - writtenMatches + (firstRuntime ? 0 : 1));
  h.logging.close();
});

test("oversized metadata is discarded before serialization and huge cumulative strings never leak", () => {
  const h = harness();
  h.logging.recordMatch({ ...info, map: "x".repeat(100_000) }, sample());
  h.logging.recordMatch(info, sample({ discardedSteps: "9".repeat(100_000), simEncodeMs: [], replayMs: [], rttMs: [] }));
  h.flush();
  const match = h.records()[0];
  assert.equal(match.cumulative.discardedSteps, null);
  assert.equal(match.invalidCounterSamples, 1);
  assert.deepEqual(match.summaries.simEncodeMs, { count: 0, min: null, p50: null, p95: null, p99: null, max: null, truncatedSamples: 0, invalidSamples: 0 });
  assert.equal(h.records().at(-1).logging.invalidMetadata, 1);
  assert.ok(h.lines.every(line => Buffer.byteLength(line) <= 16 * 1024));
  h.logging.close();
});
