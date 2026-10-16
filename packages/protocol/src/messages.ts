export const PROTOCOL_VERSION = 4;
export const INPUT_BYTES = 12;
export const EVENT_HEADER_BYTES = 20;
export const MAX_STATE_BYTES = 32 * 1024 * 1024;
export const MAX_PACKET_BYTES = MAX_STATE_BYTES + 512;
export const LIMITS = {
  nickname: 48, map: 128, rules: 4096, chat: 1024, reason: 256,
  frames: 3, events: 64, eventPayload: 65535, eventBatch: 1024 * 1024,
  tickRecords: 128, commands: 64, commandBytes: 4096, tickBatch: 1024 * 1024,
  lobbyId: 32, hostToken: 64, lobbyCode: 8, matchId: 64, matchWsUrl: 1024,
} as const;

export interface InputFrame { seq: number; tick: number; viewTick: number; input: Uint8Array }
export interface ReliableEvent { id: number; tick: number; header: Uint8Array; payload: Uint8Array }
export interface SlotInput { slot: number; input: Uint8Array }
export type TickRecord =
  | { type: "step"; tick: number; commands: Uint8Array[]; inputs: SlotInput[] }
  | { type: "correct"; tick: number; slot: number; input: Uint8Array }
  | { type: "hash"; tick: number; hash: bigint };
export type WeaponSelection = "primary" | "secondary";
export type GameMode = "dm" | "ctf";
export interface Region { id: string; name: string; url: string }
export interface LobbyPlayer { id: string; nickname: string; ready: boolean; host: boolean }
export interface LobbyState {
  code: string; mode: GameMode; map: string; targetPlayers: number;
  players: LobbyPlayer[]; started: boolean; matchId?: string; matchWsUrl?: string;
}
export interface LobbyLookup extends LobbyState { wsUrl: string }
export type LobbyMessage =
  | { type: "lobby-join"; nickname: string; hostToken?: string }
  | { type: "lobby-update"; mode?: GameMode; map?: string; targetPlayers?: number }
  | { type: "lobby-ready"; ready: boolean }
  | { type: "lobby-kick"; id: string }
  | { type: "lobby-start" | "lobby-leave" }
  | { type: "lobby-state"; selfId: string; state: LobbyState }
  | { type: "lobby-error"; reason: string };
export type Message =
  | LobbyMessage
  | { type: "hello"; protocolVersion: number; contentSetHash: Uint8Array; simAbiVersion: number; nickname: string; weapon: number; secondaryWeapon: number }
  | { type: "welcome"; slot: number; serverTick: number; tickRate: number; matchSeed: bigint; map: string; rules: Uint8Array }
  | { type: "input"; frames: InputFrame[] }
  | { type: "ticks"; lastConsumedInputSeq: number; records: TickRecord[] }
  | { type: "state"; tick: number; hash: bigint; lastConsumedInputSeq: number; bytes: Uint8Array }
  | { type: "events"; events: ReliableEvent[] }
  | { type: "eventAck"; eventId: number }
  | { type: "chat"; text: string }
  | { type: "ping" | "pong"; timestamp: bigint }
  | { type: "resync" }
  | { type: "weapon-choice"; primary: number; secondary: number; selection: WeaponSelection }
  | { type: "disconnect"; code: number; reason: string };

export type ProtocolErrorCode = "TRUNCATED" | "OVERSIZED" | "VERSION" | "TYPE" | "CHANNEL" | "TRAILING" | "VALUE" | "UTF8" | "TRANSPORT";
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly offset: number;
  constructor(code: ProtocolErrorCode, message: string, offset = 0, options?: ErrorOptions) {
    super(message, options); this.name = "ProtocolError"; this.code = code; this.offset = offset;
  }
}
