import { Worker } from "node:worker_threads";
import type { MatchConfiguration, WorkerRequest, WorkerResponse } from "./worker-messages.ts";

/** Exactly one worker and one WASM instance per controller/match. */
export class MatchController {
  private readonly worker: Worker;
  private stopping = false;
  private ready = false;
  onMessage: ((message: WorkerResponse) => void) | undefined;
  onFailure: ((error: Error) => void) | undefined;

  private constructor(config: MatchConfiguration) {
    this.worker = new Worker(new URL("./match-worker.ts", import.meta.url), { workerData: config });
  }

  static async start(config: MatchConfiguration): Promise<MatchController> {
    const controller = new MatchController(config);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Match start timed out"));
        void controller.stop();
      }, 30_000);
      const failure = (error: Error) => {
        clearTimeout(timeout);
        if (!controller.ready) reject(error);
        else if (!controller.stopping) controller.onFailure?.(error);
      };
      controller.worker.on("error", failure);
      controller.worker.on("exit", code => {
        if (!controller.stopping) failure(new Error(`Match worker exited unexpectedly (${code})`));
      });
      controller.worker.on("message", (message: WorkerResponse) => {
        if (message.type === "ready") {
          clearTimeout(timeout);
          controller.ready = true;
          resolve();
        } else if (message.type === "failure") {
          failure(new Error(message.reason));
          void controller.stop();
        } else controller.onMessage?.(message);
      });
    });
    return controller;
  }

  send(message: WorkerRequest): void {
    if (this.stopping) throw new Error("Match worker is stopped");
    this.worker.postMessage(message);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // Termination is bounded even if a WASM call fails to return.
    await this.worker.terminate();
  }
}
