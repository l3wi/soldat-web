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
/** Opt-in relative-cost diagnostics; never an isolated timing receipt. */
export interface TickWorkProfile {
  tick: number; stepMs: number; saveMs: number; hashMs: number;
  deltaMs: number; postMs: number; deltaEncodes: number; recipients: number;
  controls?: { slot: number; seq: number; repeated: boolean; bits: number; rejected: Record<string, number> }[];
}
export type WorkerResponse =
  | { type: "ready" }
  | { type: "joined"; slot: number; serverTick: number }
  | { type: "baseline"; slot: number; snapshotId: number }
  | { type: "send"; slot: number; serverTick: number; message: Message }
  | { type: "reject"; slot: number; reason: string }
  | { type: "left"; slot: number }
  | { type: "metrics"; serverTick: number; overloads: number; discardedSteps: string; simEncodeMs: number[]; tickLatenessMs: number[]; replayMs: number[]; replayTicks: number; rejectedShots: number; uncompensatedShots: number; workProfile?: TickWorkProfile[]; gc?: { atMs: number; durationMs: number; kind: number }[] }
  | { type: "failure"; reason: string };
