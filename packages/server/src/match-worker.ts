import { parentPort, workerData } from "node:worker_threads";
import { PerformanceObserver } from "node:perf_hooks";
import { FixedStepAccumulator, type FixedStepTiming } from "./clock.ts";
import { AuthoritativeMatch } from "./match.ts";
import type { MatchConfiguration, WorkerRequest, WorkerResponse, WorkerPublication, TickWorkProfile } from "./worker-messages.ts";

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
function publish(message: WorkerResponse): void {
  port!.postMessage({ message, publishedAtNs: process.hrtime.bigint() } satisfies WorkerPublication);
}
function fail(error: unknown): void {
  publish({ type: "failure", reason: error instanceof Error ? error.message : String(error) });
  stop();
}
try {
  match = await AuthoritativeMatch.start(workerData as MatchConfiguration, publish);
  const clock = new FixedStepAccumulator(process.hrtime.bigint());
  let nextMetrics = performance.now() + 1000;
  let simEncodeMs: number[] = [], tickLatenessMs: number[] = [], tickCompletionLatenessMs: number[] = [], workerCycleMs: number[] = [];
  let inputWorkMs = 0, messageWorkMs = 0;
  let workProfile: TickWorkProfile[] = [];
  const timing: FixedStepTiming = {
    now: process.hrtime.bigint,
    completed: lateness => { tickCompletionLatenessMs.push(lateness); },
  };
  const wake = () => {
    const cycleStart = performance.now();
    try {
      match!.advance(clock, timing, (lateness, workMs) => {
        tickLatenessMs.push(lateness);
        // Legacy per-step accounting includes input-request work attributed to
        // the next tick. It overlaps messageWorkMs and is not elapsed latency.
        simEncodeMs.push(workMs + inputWorkMs);
        inputWorkMs = 0;
        if (profiling) workProfile.push(match!.takeWorkProfile()!);
      });
      const metricsAt = performance.now();
      if (metricsAt >= nextMetrics) {
        // The current wake is not complete yet. Its full cost (including this
        // report's synchronous clone and timer setup) enters the NEXT report.
        publish({ type: "metrics", serverTick: match!.tick, overloads: clock.overloads, discardedSteps: clock.discardedSteps.toString(), simEncodeMs, workerCycleMs, tickLatenessMs, tickCompletionLatenessMs, messageWorkMs, ...match!.takeLagMetrics(), ...(profiling ? { workProfile, gc } : {}) });
        simEncodeMs = []; workerCycleMs = []; tickLatenessMs = []; tickCompletionLatenessMs = [];
        messageWorkMs = 0; workProfile = []; gc = [];
        nextMetrics = metricsAt + 1000;
      }
      // Preserve the post-step native observation: entering/leaving bullet
      // time changes the next sleep. Observe BEFORE sampling scheduling time.
      const tickScale = match!.tickScale;
      timer = setTimeout(wake, Math.max(1, clock.delayMilliseconds(process.hrtime.bigint(), tickScale)));
    } catch (error) { fail(error); }
    finally { workerCycleMs.push(performance.now() - cycleStart); }
  };
  port.on("message", (message: WorkerRequest) => {
    if (stopped) return;
    const start = performance.now();
    try {
      if (message.type === "stop") { stop(); return; }
      match!.receive(message, process.hrtime.bigint());
      if (message.type === "pause") clock.reset(process.hrtime.bigint());
    }
    catch (error) { fail(error); }
    finally {
      const workMs = performance.now() - start;
      messageWorkMs += workMs;
      if (message.type === "input") inputWorkMs += workMs;
    }
  });
  port.on("close", stop);
  publish({ type: "ready" });
  timer = setTimeout(wake, clock.delayMilliseconds(process.hrtime.bigint()));
} catch (error) { fail(new Error(`Match start failed: ${error instanceof Error ? error.message : String(error)}`)); }
