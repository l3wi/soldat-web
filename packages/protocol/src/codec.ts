import { EVENT_HEADER_BYTES, INPUT_BYTES, LIMITS, MAX_PACKET_BYTES, PROTOCOL_VERSION, ProtocolError, type Message, type ReliableEvent, type WeaponSelection } from "./messages.ts";
import { validateDelta } from "./delta.ts";
import type { TransportChannel } from "./transport/types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const TYPES = ["hello", "welcome", "input", "snapshot", "snapshotAck", "events", "eventAck", "chat", "ping", "pong", "resync", "disconnect", "weapon-choice", "lobby-join", "lobby-update", "lobby-ready", "lobby-start", "lobby-leave", "lobby-state", "lobby-error"] as const;
const MAX_PAYLOAD = [0, 90, 4245, 73, LIMITS.delta + 445, 4, LIMITS.eventBatch, 4, LIMITS.chat + 2, 8, 8, 4, LIMITS.reason + 4, 3, 116, 133, 1, 0, 0, 8192, 258];
const HEADER_BYTES = 8;
function check(value: boolean, message: string, offset = 0): asserts value {
  if (!value) throw new ProtocolError("VALUE", message, offset);
}
function integer(n: number, max: number, min = 0): void { check(Number.isInteger(n) && n >= min && n <= max, `Integer outside ${min}..${max}`); }
function bigint(n: bigint): void { check(typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn, "Expected u64 bigint"); }
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

class Writer {
  offset = 0;
  readonly view?: DataView;
  readonly target: Uint8Array | undefined;
  constructor(target?: Uint8Array) {
    this.target = target;
    if (target) this.view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  }
  u8(n: number) { integer(n, 255); this.view?.setUint8(this.offset, n); this.offset++; }
  u16(n: number) { integer(n, 65535); this.view?.setUint16(this.offset, n, true); this.offset += 2; }
  u32(n: number) { integer(n, 0xffffffff); this.view?.setUint32(this.offset, n, true); this.offset += 4; }
  u64(n: bigint) { bigint(n); this.view?.setBigUint64(this.offset, n, true); this.offset += 8; }
  bytes(bytes: Uint8Array) { this.target?.set(bytes, this.offset); this.offset += bytes.length; }
  text(text: string, max: number, nonempty = false) {
    check(typeof text === "string" && wellFormed(text), "Expected well-formed Unicode text");
    const bytes = encoder.encode(text);
    check(bytes.length <= max && (!nonempty || bytes.length > 0), `Text exceeds 1..${max} UTF-8 bytes`);
    this.u16(bytes.length); this.bytes(bytes);
  }
  blob(bytes: Uint8Array, max: number) { check(bytes.length <= max, "Blob exceeds message limit"); this.u32(bytes.length); this.bytes(bytes); }
}
class Reader {
  offset = HEADER_BYTES;
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  require(size: number) { if (size > this.bytes.length - this.offset) throw new ProtocolError("TRUNCATED", "Truncated field", this.offset); }
  u8(): number { this.require(1); return this.view.getUint8(this.offset++); }
  u16(): number { this.require(2); const n = this.view.getUint16(this.offset, true); this.offset += 2; return n; }
  u32(): number { this.require(4); const n = this.view.getUint32(this.offset, true); this.offset += 4; return n; }
  u64(): bigint { this.require(8); const n = this.view.getBigUint64(this.offset, true); this.offset += 8; return n; }
  take(size: number): Uint8Array { this.require(size); const result = this.bytes.subarray(this.offset, this.offset + size); this.offset += size; return result; }
  text(max: number, nonempty = false): string {
    const length = this.u16();
    if (length > max) throw new ProtocolError("OVERSIZED", "Text exceeds message limit", this.offset - 2);
    check(!nonempty || length > 0, "Empty text", this.offset);
    const bytes = this.take(length);
    try { return decoder.decode(bytes); }
    catch (cause) { throw new ProtocolError("UTF8", "Invalid UTF-8", this.offset - length, { cause }); }
  }
  blob(max: number): Uint8Array {
    const length = this.u32();
    if (length > max) throw new ProtocolError("OVERSIZED", "Blob exceeds message limit", this.offset - 4);
    return this.take(length);
  }
}
export function validateInput(input: Uint8Array): void {
  check(input.length === INPUT_BYTES, "Input must be 12 bytes");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  check((view.getUint16(0, true) & 0xf000) === 0 && view.getUint16(10, true) === 0, "Reserved input bits must be zero");
  const order = view.getUint16(8, true);
  check((order & 0xfff0) === 0 && (order & 3) !== 3 && (order & 12) !== 12, "Invalid press-order bits");
}
/** Original selectable weapon numbers, shared by admission and reliable changes. */
export function validateWeaponChoice(primary: number, secondary: number): void {
  integer(primary, 10, 1);
  check(Number.isInteger(secondary) && (secondary === 0 || secondary === 11 || secondary === 12 || secondary === 13), "Invalid secondary weapon");
}
export function validateWeaponSelection(selection: unknown): asserts selection is WeaponSelection {
  check(selection === "primary" || selection === "secondary", "Invalid weapon selection");
}
function validateEvent(event: ReliableEvent): void {
  integer(event.id, 0xffffffff, 1); integer(event.tick, 0xffffffff);
  check(event.header.length === EVENT_HEADER_BYTES, "Event header must be 20 bytes");
  check(event.payload.length <= LIMITS.eventPayload, "Event payload exceeds limit");
  const view = new DataView(event.header.buffer, event.header.byteOffset, event.header.byteLength);
  check(view.getUint32(16, true) === event.payload.length && view.getUint32(4, true) === event.tick, "Event header/envelope mismatch");
}
function modeId(mode: unknown): number { check(mode === "dm" || mode === "ctf", "Invalid mode"); return mode === "dm" ? 0 : 1; }
function readMode(r: Reader): "dm" | "ctf" { const id = r.u8(); integer(id, 1); return id === 0 ? "dm" : "ctf"; }
function readBool(r: Reader): boolean { const value = r.u8(); integer(value, 1); return value === 1; }
function writePayload(w: Writer, m: Message): void {
  switch (m.type) {
    case "lobby-join": w.text(m.nickname, 48, true); w.text(m.hostToken ?? "", 64); break;
    case "lobby-update": {
      const flags = (m.mode !== undefined ? 1 : 0) | (m.map !== undefined ? 2 : 0) | (m.targetPlayers !== undefined ? 4 : 0);
      integer(flags, 7, 1); w.u8(flags);
      if (m.mode !== undefined) w.u8(modeId(m.mode));
      if (m.map !== undefined) w.text(m.map, 128, true);
      if (m.targetPlayers !== undefined) { integer(m.targetPlayers, 32, 1); w.u8(m.targetPlayers); }
      break;
    }
    case "lobby-ready": check(typeof m.ready === "boolean", "Invalid ready"); w.u8(m.ready ? 1 : 0); break;
    case "lobby-start": case "lobby-leave": break;
    case "lobby-error": w.text(m.reason, 256, true); break;
    case "lobby-state": {
      const s = m.state;
      check(/^[A-Z0-9]{6}$/.test(s.code), "Invalid lobby code");
      w.text(m.selfId, 32, true); w.text(s.code, 6, true); w.u8(modeId(s.mode)); w.text(s.map, 128, true);
      integer(s.targetPlayers, 32, 1); w.u8(s.targetPlayers); integer(s.players.length, 32); w.u8(s.players.length);
      for (const p of s.players) { w.text(p.id, 32, true); w.text(p.nickname, 48, true); check(typeof p.ready === "boolean" && typeof p.host === "boolean", "Invalid roster flags"); w.u8(p.ready ? 1 : 0); w.u8(p.host ? 1 : 0); }
      check(typeof s.started === "boolean", "Invalid started"); w.u8(s.started ? 1 : 0);
      if (s.started) { w.text(s.matchId!, 64, true); w.text(s.matchWsUrl!, 1024, true); }
      break;
    }
    case "hello":
      w.u16(m.protocolVersion); check(m.contentSetHash.length === 32, "Content hash must be 32 bytes"); w.bytes(m.contentSetHash);
      w.u32(m.simAbiVersion); w.text(m.nickname, LIMITS.nickname, true); w.u8(m.weapon); w.u8(m.secondaryWeapon); break;
    case "welcome":
      integer(m.slot, 32, 1); check(m.tickRate === 60, "Tick rate must be 60");
      w.u8(m.slot); w.u32(m.serverTick); w.u16(m.tickRate); w.u64(m.matchSeed); w.text(m.map, LIMITS.map, true); w.blob(m.rules, LIMITS.rules); break;
    case "input":
      integer(m.frames.length, LIMITS.frames, 1); w.u8(m.frames.length);
      for (const frame of m.frames) { integer(frame.seq, 0xffffffff, 1); validateInput(frame.input); w.u32(frame.seq); w.u32(frame.tick); w.u32(frame.viewTick); w.bytes(frame.input); }
      break;
    case "snapshot":
      integer(m.snapshotId, 0xffffffff, 1); validateDelta(m.state);
      w.u32(m.serverTick); w.u32(m.lastConsumedInputSeq); w.u32(m.snapshotId); w.u32(m.baselineId); w.u64(m.stateHash);
      integer(m.inputs.length, 32); w.u8(m.inputs.length);
      let previousSlot = 0;
      for (const entry of m.inputs) { integer(entry.slot, 32, previousSlot + 1); validateInput(entry.input); w.u8(entry.slot); w.bytes(entry.input); previousSlot = entry.slot; }
      w.blob(m.state, LIMITS.delta); break;
    case "snapshotAck": integer(m.snapshotId, 0xffffffff, 1); w.u32(m.snapshotId); break;
    case "events":
      integer(m.events.length, LIMITS.events, 1); w.u16(m.events.length);
      for (const event of m.events) { validateEvent(event); w.u32(event.id); w.u32(event.tick); w.bytes(event.header); w.bytes(event.payload); }
      break;
    case "eventAck": integer(m.eventId, 0xffffffff, 1); w.u32(m.eventId); break;
    case "chat": w.text(m.text, LIMITS.chat, true); break;
    case "ping": case "pong": w.u64(m.timestamp); break;
    case "resync": w.u32(m.baselineId); break;
    case "weapon-choice":
      validateWeaponChoice(m.primary, m.secondary); validateWeaponSelection(m.selection);
      w.u8(m.primary); w.u8(m.secondary); w.u8(m.selection === "primary" ? 0 : 1); break;
    case "disconnect": w.u16(m.code); w.text(m.reason, LIMITS.reason); break;
  }
}
function header(bytes: Uint8Array): { type: Message["type"]; channel: TransportChannel } {
  if (bytes.byteLength > MAX_PACKET_BYTES) throw new ProtocolError("OVERSIZED", "Packet exceeds wire maximum");
  if (bytes.byteLength < HEADER_BYTES) throw new ProtocolError("TRUNCATED", "Truncated packet header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== PROTOCOL_VERSION) throw new ProtocolError("VERSION", "Unsupported wire version");
  const id = view.getUint8(2), type = TYPES[id - 1];
  if (!type) throw new ProtocolError("TYPE", "Unknown message type", 2);
  const channelId = type === "snapshot" ? 1 : 0;
  if (view.getUint8(3) !== channelId) throw new ProtocolError("CHANNEL", "Message uses wrong channel", 3);
  const length = view.getUint32(4, true);
  if (length > MAX_PAYLOAD[id]!) throw new ProtocolError("OVERSIZED", "Payload exceeds message type limit", 4);
  if (length > bytes.length - HEADER_BYTES) throw new ProtocolError("TRUNCATED", "Truncated payload", 4);
  if (length < bytes.length - HEADER_BYTES) throw new ProtocolError("TRAILING", "Trailing packet bytes", HEADER_BYTES + length);
  return { type, channel: channelId ? "latestState" : "reliableControl" };
}
function typed<T>(fn: () => T): T {
  try { return fn(); }
  catch (cause) { if (cause instanceof ProtocolError) throw cause; throw new ProtocolError("VALUE", "Malformed binary message", 0, { cause }); }
}
/** Validates framing only; decodeMessage validates all payload fields. */
export function readChannel(bytes: Uint8Array): TransportChannel { return typed(() => header(bytes).channel); }
export function encodeMessage(message: Message): Uint8Array {
  return typed(() => {
    const id = TYPES.indexOf(message.type) + 1;
    if (!id) throw new ProtocolError("TYPE", "Unknown message type");
    const measure = new Writer(); writePayload(measure, message);
    if (measure.offset > MAX_PAYLOAD[id]!) throw new ProtocolError("OVERSIZED", "Payload exceeds message type limit");
    const result = new Uint8Array(measure.offset + HEADER_BYTES), w = new Writer(result);
    w.u16(PROTOCOL_VERSION); w.u8(id); w.u8(message.type === "snapshot" ? 1 : 0); w.u32(measure.offset); writePayload(w, message);
    return result;
  });
}
/** Byte fields borrow packet memory. Retain/copy the packet until consumers finish. */
export function decodeMessage(bytes: Uint8Array): Message {
  return typed(() => {
    const { type } = header(bytes), r = new Reader(bytes);
    let message: Message;
    switch (type) {
      case "lobby-join": { const nickname = r.text(48, true), hostToken = r.text(64); message = { type, nickname, ...(hostToken ? { hostToken } : {}) }; break; }
      case "lobby-update": {
        const flags = r.u8(); integer(flags, 7, 1);
        const mode = flags & 1 ? readMode(r) : undefined, map = flags & 2 ? r.text(128, true) : undefined;
        const targetPlayers = flags & 4 ? r.u8() : undefined;
        if (targetPlayers !== undefined) integer(targetPlayers, 32, 1);
        message = { type, ...(mode !== undefined ? { mode } : {}), ...(map !== undefined ? { map } : {}), ...(targetPlayers !== undefined ? { targetPlayers } : {}) }; break;
      }
      case "lobby-ready": message = { type, ready: readBool(r) }; break;
      case "lobby-start": case "lobby-leave": message = { type }; break;
      case "lobby-error": message = { type, reason: r.text(256, true) }; break;
      case "lobby-state": {
        const selfId = r.text(32, true), code = r.text(6, true), mode = readMode(r), map = r.text(128, true), targetPlayers = r.u8(), count = r.u8();
        check(/^[A-Z0-9]{6}$/.test(code), "Invalid lobby code"); integer(targetPlayers, 32, 1); integer(count, 32);
        const players = [];
        for (let i = 0; i < count; i++) players.push({ id: r.text(32, true), nickname: r.text(48, true), ready: readBool(r), host: readBool(r) });
        const started = readBool(r);
        message = { type, selfId, state: { code, mode, map, targetPlayers, players, started, ...(started ? { matchId: r.text(64, true), matchWsUrl: r.text(1024, true) } : {}) } }; break;
      }
      case "hello": message = { type, protocolVersion: r.u16(), contentSetHash: r.take(32), simAbiVersion: r.u32(), nickname: r.text(LIMITS.nickname, true), weapon: r.u8(), secondaryWeapon: r.u8() }; break;
      case "welcome": {
        const slot = r.u8(), serverTick = r.u32(), tickRate = r.u16(), matchSeed = r.u64(), map = r.text(LIMITS.map, true), rules = r.blob(LIMITS.rules);
        integer(slot, 32, 1); check(tickRate === 60, "Tick rate must be 60");
        message = { type, slot, serverTick, tickRate, matchSeed, map, rules }; break;
      }
      case "input": {
        const count = r.u8(); integer(count, LIMITS.frames, 1);
        const frames = [];
        for (let i = 0; i < count; i++) { const seq = r.u32(), tick = r.u32(), viewTick = r.u32(), input = r.take(INPUT_BYTES); integer(seq, 0xffffffff, 1); validateInput(input); frames.push({ seq, tick, viewTick, input }); }
        message = { type, frames }; break;
      }
      case "snapshot": {
        const serverTick = r.u32(), lastConsumedInputSeq = r.u32(), snapshotId = r.u32(), baselineId = r.u32(), stateHash = r.u64();
        const count = r.u8(); integer(count, 32);
        const inputs = [];
        let previousSlot = 0;
        for (let i = 0; i < count; i++) { const slot = r.u8(); integer(slot, 32, previousSlot + 1); const input = r.take(INPUT_BYTES); validateInput(input); inputs.push({ slot, input }); previousSlot = slot; }
        const state = r.blob(LIMITS.delta);
        integer(snapshotId, 0xffffffff, 1); validateDelta(state);
        message = { type, serverTick, lastConsumedInputSeq, snapshotId, baselineId, stateHash, inputs, state }; break;
      }
      case "snapshotAck": { const snapshotId = r.u32(); integer(snapshotId, 0xffffffff, 1); message = { type, snapshotId }; break; }
      case "events": {
        const count = r.u16(); integer(count, LIMITS.events, 1); const events = [];
        for (let i = 0; i < count; i++) {
          const id = r.u32(), tick = r.u32(), eventHeader = r.take(EVENT_HEADER_BYTES);
          const length = new DataView(eventHeader.buffer, eventHeader.byteOffset, eventHeader.byteLength).getUint32(16, true);
          if (length > LIMITS.eventPayload) throw new ProtocolError("OVERSIZED", "Event payload exceeds limit", r.offset - 4);
          const event = { id, tick, header: eventHeader, payload: r.take(length) }; validateEvent(event); events.push(event);
        }
        message = { type, events }; break;
      }
      case "eventAck": { const eventId = r.u32(); integer(eventId, 0xffffffff, 1); message = { type, eventId }; break; }
      case "chat": message = { type, text: r.text(LIMITS.chat, true) }; break;
      case "ping": case "pong": message = { type, timestamp: r.u64() }; break;
      case "resync": message = { type, baselineId: r.u32() }; break;
      case "weapon-choice": {
        const primary = r.u8(), secondary = r.u8(), selectionId = r.u8();
        validateWeaponChoice(primary, secondary); integer(selectionId, 1);
        message = { type, primary, secondary, selection: selectionId === 0 ? "primary" : "secondary" }; break;
      }
      case "disconnect": message = { type, code: r.u16(), reason: r.text(LIMITS.reason) }; break;
    }
    if (r.offset !== bytes.length) throw new ProtocolError("TRAILING", "Trailing payload fields", r.offset);
    return message;
  });
}
