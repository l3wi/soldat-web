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
  | { type: "join"; slot: number; weapon: number; secondaryWeapon: number }
  | { type: "leave"; slot: number }
  | { type: "input"; slot: number; frames: InputFrame[] }
  | { type: "rtt"; slot: number; milliseconds: number }
  | { type: "snapshotAck"; slot: number; snapshotId: number }
  | { type: "eventAck"; slot: number; eventId: number }
  | { type: "resync"; slot: number; baselineId: number }
  | { type: "stop" };
export type WorkerResponse =
  | { type: "ready" }
  | { type: "joined"; slot: number; serverTick: number }
  | { type: "baseline"; slot: number; snapshotId: number }
  | { type: "send"; slot: number; serverTick: number; message: Message }
  | { type: "reject"; slot: number; reason: string }
  | { type: "left"; slot: number }
  | { type: "metrics"; serverTick: number; overloads: number; discardedSteps: string; simEncodeMs: number[]; tickLatenessMs: number[]; replayMs: number[]; replayTicks: number; rejectedShots: number }
  | { type: "failure"; reason: string };
