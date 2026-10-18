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
  | { type: "metrics"; serverTick: number; overloads: number; discardedSteps: string; simEncodeMs: number[]; tickLatenessMs: number[]; replayMs: number[]; replayTicks: number; rejectedShots: number; uncompensatedShots: number; replayBudgetFallbacks: number; inputBufferOccupancy: number[]; inputBufferLeadTicks: number[]; workProfile?: TickWorkProfile[]; gc?: { atMs: number; durationMs: number; kind: number }[] }
  | { type: "failure"; reason: string };
