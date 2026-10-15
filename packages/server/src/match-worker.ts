import { parentPort, workerData } from "node:worker_threads";
import { FixedStepAccumulator } from "./clock.ts";
import { AuthoritativeMatch } from "./match.ts";
import type { MatchConfiguration, WorkerRequest, WorkerResponse } from "./worker-messages.ts";

const port = parentPort;
if (!port) throw new Error("Match entry must run inside a worker_thread");
let match: AuthoritativeMatch | undefined;
let timer: NodeJS.Timeout | undefined;
let stopped = false;
function stop(): void {
  if (stopped) return;
  stopped = true;
  clearTimeout(timer);
  match?.dispose();
  port!.close();
}
function fail(error: unknown): void {
  port!.postMessage({ type: "failure", reason: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
  stop();
}
try {
  match = await AuthoritativeMatch.start(workerData as MatchConfiguration, response => port.postMessage(response));
  const clock = new FixedStepAccumulator(process.hrtime.bigint());
  let nextMetrics = 60;
  let simEncodeMs: number[] = [], tickLatenessMs: number[] = [];
  const wake = () => {
    try {
      clock.advance(process.hrtime.bigint(), lateness => {
        const start = performance.now();
        tickLatenessMs.push(lateness);
        match!.step();
        simEncodeMs.push(performance.now() - start);
      });
      if (match!.tick >= nextMetrics) {
        port.postMessage({ type: "metrics", serverTick: match!.tick, overloads: clock.overloads, discardedSteps: clock.discardedSteps.toString(), simEncodeMs, tickLatenessMs, ...match!.takeLagMetrics() } satisfies WorkerResponse);
        simEncodeMs = []; tickLatenessMs = [];
        nextMetrics = match!.tick + 60;
      }
      timer = setTimeout(wake, Math.max(1, clock.delayMilliseconds));
    } catch (error) { fail(error); }
  };
  port.on("message", (message: WorkerRequest) => {
    if (stopped) return;
    if (message.type === "stop") { stop(); return; }
    try { match!.receive(message, process.hrtime.bigint()); }
    catch (error) { fail(error); }
  });
  port.on("close", stop);
  port.postMessage({ type: "ready" } satisfies WorkerResponse);
  timer = setTimeout(wake, clock.delayMilliseconds);
} catch (error) { fail(new Error(`Match start failed: ${error instanceof Error ? error.message : String(error)}`)); }
