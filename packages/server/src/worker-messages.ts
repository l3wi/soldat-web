import type { InputFrame, Message, WeaponSelection, PlayerAppearance, MatchRules } from "@soldat-web/protocol";

export interface MatchConfiguration {
  wasmPath: string;
  contentRoot: string;
  contentSetHash: string;
  map: string;
  /** Server-selected maps compatible with the configured mode, in rotation order. */
  mapRotation?: string[];
  /** Trusted compatible catalog for explicit admin/vote choices, independent of rotation order. */
  allowedMaps?: string[];
  rules: Partial<MatchRules> | Record<string, unknown>;
  matchSeed: string;
  /** Legacy fixed opponents when targetPlayers is absent. */
  botCount?: number;
  /** Dynamic total population; humans replace bots, 1..32. */
  targetPlayers?: number;
  afkMs?: number;
  replayTicksPerSecond?: number;
}
export type WorkerRequest =
  | { type: "gesture"; slot: number; gesture: "smoke" | "tabac" | "takeoff" | "victory" }
  | { type: "player-kill"; slot: number }
  | { type: "force-team"; slot: number; team: number }
  | { type: "server-mute"; slot: number; muted: boolean }
  | { type: "radio"; slot: number; category: 1 | 2 | 3; direction: 1 | 2 | 3 }
  | { type: "map-control"; map?: string; next?: boolean; restart?: boolean }
  | { type: "pause"; paused: boolean }
  | { type: "join"; slot: number; weapon: number; secondaryWeapon: number; name?: string; nickname?: string; appearance?: PlayerAppearance }
  | { type: "leave"; slot: number }
  | { type: "input"; slot: number; frames: InputFrame[] }
  | { type: "weapon-choice"; slot: number; primary: number; secondary: number; selection: WeaponSelection }
  | { type: "team-change"; slot: number; team: number }
  | { type: "appearance"; slot: number; appearance: PlayerAppearance }
  | { type: "chat"; slot: number; channel: "public" | "team"; text: string }
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
/** First matching admission gate, counted per Fire/grenade input frame, not projectile. */
export const FIRE_ADMISSION_REASONS = [
  "fallbackAge", "fallbackView", "fallbackHistory", "fallbackAnchor", "fallbackBudget",
  "rejectAge", "rejectHistory", "rejectIntent", "rejectAction", "rejectWeapon",
  "rejectMatchCooldown", "rejectPlayerCooldown", "rejectExistingFire", "rejectView",
] as const;
export type FireAdmissionReason = typeof FIRE_ADMISSION_REASONS[number];
export type FireAdmissionReasons = Record<FireAdmissionReason, number>;
/** Live player-consume outcomes; fresh neutral is scheduled, never a missing frame. */
export interface InputConsumption {
  scheduled: number;
  repeatedHeld: number;
  timeoutNeutral: number;
  /** Largest contiguous missing-frame run observed, including runs spanning reports. */
  maxMissingRunTicks: number;
}
export type WorkerResponse =
  | { type: "roster"; players: { slot: number; team: number }[] }
  | { type: "paused"; paused: boolean }
  | { type: "ready" }
  | { type: "joined"; slot: number; serverTick: number; map: string; roundEpoch: number }
  | { type: "round"; serverTick: number; map: string; roundEpoch: number }
  | { type: "send"; slot: number; serverTick: number; message: Message }
  | { type: "ticks"; serverTick: number; records: Uint8Array; recipients: { slot: number; lastConsumedInputSeq: number }[] }
  | { type: "reject"; slot: number; reason: string }
  | { type: "left"; slot: number }
  | {
    type: "metrics"; serverTick: number; overloads: number; discardedSteps: string;
    /** Legacy per-step sim/encode CPU plus input-request work attributed to the next step. Nested in cycle/message work. */
    simEncodeMs: number[];
    /** Complete prior wakes, from callback entry through observations, report publication and timer setup. */
    workerCycleMs: number[];
    /** Actual callback start and completion relative to that tick's fixed-step deadline. */
    tickLatenessMs: number[]; tickCompletionLatenessMs: number[];
    /** Sum of synchronous elapsed handler durations for every handled request; overlaps legacy input attribution. */
    messageWorkMs: number;
    inputConsumption: InputConsumption;
    replayMs: number[]; replayTicks: number; rejectedShots: number; uncompensatedShots: number; replayBudgetFallbacks: number;
    fireAdmissionReasons: FireAdmissionReasons; inputBufferOccupancy: number[]; inputBufferLeadTicks: number[];
    workProfile?: TickWorkProfile[]; gc?: { atMs: number; durationMs: number; kind: number }[];
  }
  | { type: "failure"; reason: string };

/** Worker-thread publication boundary, immediately before postMessage's synchronous clone. */
export interface WorkerPublication {
  message: WorkerResponse;
  publishedAtNs: bigint;
}
