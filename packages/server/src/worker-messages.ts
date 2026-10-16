import type { InputFrame, Message, WeaponSelection } from "@soldat-web/protocol";

export interface MatchConfiguration {
  wasmPath: string;
  contentRoot: string;
  contentSetHash: string;
  map: string;
  rules: Record<string, unknown>;
  matchSeed: string;
  /** Legacy fixed opponents when targetPlayers is absent. */
  botCount?: number;
  /** Dynamic total population; humans replace bots, 1..32. */
  targetPlayers?: number;
  afkMs?: number;
  replayTicksPerSecond?: number;
}
export type WorkerRequest =
  | { type: "join"; slot: number; weapon: number; secondaryWeapon: number; name?: string }
  | { type: "leave"; slot: number }
  | { type: "input"; slot: number; frames: InputFrame[] }
  | { type: "weapon-choice"; slot: number; primary: number; secondary: number; selection: WeaponSelection }
  | { type: "rtt"; slot: number; milliseconds: number }
  | { type: "eventAck"; slot: number; eventId: number }
  | { type: "resync"; slot: number }
  | { type: "stop" };
/** Opt-in relative-cost diagnostics; never an isolated timing receipt. */
export interface TickWorkProfile {
  tick: number; stepMs: number; saveMs: number; hashMs: number;
  recordsMs: number; postMs: number; recordEncodes: number; recipients: number;
  controls?: { slot: number; seq: number; repeated: boolean; bits: number; rejected: Record<string, number> }[];
}
export type WorkerResponse =
  | { type: "ready" }
  | { type: "joined"; slot: number; serverTick: number }
  | { type: "send"; slot: number; serverTick: number; message: Message }
  | { type: "ticks"; serverTick: number; records: Uint8Array; recipients: { slot: number; lastConsumedInputSeq: number }[] }
  | { type: "reject"; slot: number; reason: string }
  | { type: "left"; slot: number }
  | { type: "metrics"; serverTick: number; overloads: number; discardedSteps: string; simEncodeMs: number[]; tickLatenessMs: number[]; replayMs: number[]; replayTicks: number; rejectedShots: number; uncompensatedShots: number; replayBudgetFallbacks: number; inputBufferOccupancy: number[]; inputBufferLeadTicks: number[]; workProfile?: TickWorkProfile[]; gc?: { atMs: number; durationMs: number; kind: number }[] }
  | { type: "failure"; reason: string };
