import type { InputFrame, Message } from "@soldat-web/protocol";

export interface MatchConfiguration {
  wasmPath: string;
  contentRoot: string;
  contentSetHash: string;
  map: string;
  rules: Record<string, unknown>;
  matchSeed: string;
}
export type WorkerRequest =
  | { type: "join"; slot: number }
  | { type: "leave"; slot: number }
  | { type: "input"; slot: number; frames: InputFrame[] }
  | { type: "snapshotAck"; slot: number; snapshotId: number }
  | { type: "eventAck"; slot: number; eventId: number }
  | { type: "resync"; slot: number; baselineId: number }
  | { type: "stop" };
export type WorkerResponse =
  | { type: "ready" }
  | { type: "joined"; slot: number; serverTick: number }
  | { type: "send"; slot: number; message: Message }
  | { type: "reject"; slot: number; reason: string }
  | { type: "left"; slot: number }
  | { type: "metrics"; serverTick: number; overloads: number; discardedSteps: string }
  | { type: "failure"; reason: string };
