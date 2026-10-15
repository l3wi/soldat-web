export const PROTOCOL_VERSION = 2;
export const INPUT_BYTES = 12;
export const EVENT_HEADER_BYTES = 20;
export const MAX_STATE_BYTES = 32 * 1024 * 1024;
export const MAX_PACKET_BYTES = MAX_STATE_BYTES + 512;
export const LIMITS = {
  nickname: 48, map: 128, rules: 4096, chat: 1024, reason: 256,
  frames: 3, events: 64, eventPayload: 65535, eventBatch: 1024 * 1024,
  delta: MAX_STATE_BYTES + 5,
} as const;

export interface InputFrame { seq: number; tick: number; viewTick: number; input: Uint8Array }
export interface ReliableEvent { id: number; tick: number; header: Uint8Array; payload: Uint8Array }
export type Message =
  | { type: "hello"; protocolVersion: number; contentSetHash: Uint8Array; simAbiVersion: number; nickname: string; weapon: number; secondaryWeapon: number }
  | { type: "welcome"; slot: number; serverTick: number; tickRate: number; matchSeed: bigint; map: string; rules: Uint8Array }
  | { type: "input"; frames: InputFrame[] }
  | { type: "snapshot"; serverTick: number; lastConsumedInputSeq: number; snapshotId: number; baselineId: number; stateHash: bigint; inputs: { slot: number; input: Uint8Array }[]; state: Uint8Array }
  | { type: "snapshotAck"; snapshotId: number }
  | { type: "events"; events: ReliableEvent[] }
  | { type: "eventAck"; eventId: number }
  | { type: "chat"; text: string }
  | { type: "ping" | "pong"; timestamp: bigint }
  | { type: "resync"; baselineId: number }
  | { type: "disconnect"; code: number; reason: string };

export type ProtocolErrorCode = "TRUNCATED" | "OVERSIZED" | "VERSION" | "TYPE" | "CHANNEL" | "TRAILING" | "VALUE" | "UTF8" | "DELTA" | "BASELINE" | "TRANSPORT";
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly offset: number;
  constructor(code: ProtocolErrorCode, message: string, offset = 0, options?: ErrorOptions) {
    super(message, options); this.name = "ProtocolError"; this.code = code; this.offset = offset;
  }
}
