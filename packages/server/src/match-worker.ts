import { parentPort, workerData } from "node:worker_threads";
import { PerformanceObserver } from "node:perf_hooks";
import { FixedStepAccumulator } from "./clock.ts";
import { AuthoritativeMatch } from "./match.ts";
import type { MatchConfiguration, WorkerRequest, WorkerResponse, TickWorkProfile } from "./worker-messages.ts";

const port = parentPort;
if (!port) throw new Error("Match entry must run inside a worker_thread");
let match: AuthoritativeMatch | undefined;
let timer: NodeJS.Timeout | undefined;
let stopped = false;
const profiling = process.env.NET_G4_PROFILE === "1";
let gc: { atMs: number; durationMs: number; kind: number }[] = [];
const observer = profiling ? new PerformanceObserver(list => {
  for (const entry of list.getEntries()) gc.push({ atMs: entry.startTime, durationMs: entry.duration, kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind });
}) : undefined;
observer?.observe({ entryTypes: ["gc"] });
function stop(): void {
  if (stopped) return;
  stopped = true;
  clearTimeout(timer);
  match?.dispose();
  observer?.disconnect();
  port!.close();
}
function fail(error: unknown): void {
  port!.postMessage({ type: "failure", reason: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
  stop();
}
try {
  match = await AuthoritativeMatch.start(workerData as MatchConfiguration, response => port.postMessage(response));
  const clock = new FixedStepAccumulator(process.hrtime.bigint());
  let nextMetrics = performance.now() + 1000;
  let simEncodeMs: number[] = [], tickLatenessMs: number[] = [];
  let inputWorkMs = 0;
  let workProfile: TickWorkProfile[] = [];
  const wake = () => {
    try {
      if (match!.paused) clock.reset(process.hrtime.bigint());
      else clock.advance(process.hrtime.bigint(), lateness => {
        const start = performance.now();
        tickLatenessMs.push(lateness);
        match!.step();
        // Historical replay runs on message receipt, between fixed steps.
        // Attribute that real work to the next tick rather than hiding it
        // outside sim+encode accounting.
        simEncodeMs.push(performance.now() - start + inputWorkMs);
        inputWorkMs = 0;
        if (profiling) workProfile.push(match!.takeWorkProfile()!);
      }, match!.tickScale);
      const metricsAt = performance.now();
      if (metricsAt >= nextMetrics) {
        port.postMessage({ type: "metrics", serverTick: match!.tick, overloads: clock.overloads, discardedSteps: clock.discardedSteps.toString(), simEncodeMs, tickLatenessMs, ...match!.takeLagMetrics(), ...(profiling ? { workProfile, gc } : {}) } satisfies WorkerResponse);
        simEncodeMs = []; tickLatenessMs = [];
        workProfile = []; gc = [];
        nextMetrics = metricsAt + 1000;
      }
      timer = setTimeout(wake, Math.max(1, clock.delayMilliseconds(process.hrtime.bigint(), match!.tickScale)));
    } catch (error) { fail(error); }
  };
  port.on("message", (message: WorkerRequest) => {
    if (stopped) return;
    if (message.type === "stop") { stop(); return; }
    const start = performance.now();
    try {
      match!.receive(message, process.hrtime.bigint());
      if (message.type === "pause") clock.reset(process.hrtime.bigint());
    }
    catch (error) { fail(error); }
    finally { if (message.type === "input") inputWorkMs += performance.now() - start; }
  });
  port.on("close", stop);
  port.postMessage({ type: "ready" } satisfies WorkerResponse);
  timer = setTimeout(wake, clock.delayMilliseconds(process.hrtime.bigint()));
} catch (error) { fail(new Error(`Match start failed: ${error instanceof Error ? error.message : String(error)}`)); }
