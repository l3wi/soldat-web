import { EVENT_HEADER_BYTES, INPUT_BYTES, LIMITS, MAX_PACKET_BYTES, MAX_STATE_BYTES, PROTOCOL_VERSION, ProtocolError, type LobbyState, type Message, type ReliableEvent, type SlotInput, type TickRecord, type WeaponSelection } from "./messages.ts";
import type { TransportChannel } from "./transport/types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const TYPES = ["hello", "welcome", "input", "ticks", "state", "events", "eventAck", "chat", "ping", "pong", "resync", "disconnect", "weapon-choice", "lobby-join", "lobby-update", "lobby-ready", "lobby-start", "lobby-leave", "lobby-state", "lobby-error", "lobby-kick"] as const;
const MAX_PAYLOAD = [0, 42 + LIMITS.nickname, 21 + LIMITS.map + LIMITS.rules, 1 + LIMITS.frames * (12 + INPUT_BYTES), LIMITS.tickBatch, MAX_STATE_BYTES + 20, LIMITS.eventBatch, 4, LIMITS.chat + 2, 8, 8, 0, LIMITS.reason + 4, 3, 4 + LIMITS.nickname + LIMITS.hostToken, 5 + LIMITS.map, 1, 0, 0, 8192, LIMITS.reason + 2, LIMITS.lobbyId + 2];
const HEADER_BYTES = 8;
/** Client-originated packets only; state/tick/event decoder limits remain unchanged. */
export const MAX_CLIENT_PACKET_BYTES = Math.ceil((HEADER_BYTES + Math.max(
  ...(["hello", "input", "eventAck", "chat", "ping", "pong", "resync", "disconnect", "weapon-choice", "lobby-join", "lobby-update", "lobby-ready", "lobby-start", "lobby-leave", "lobby-kick"] as const).map(type => MAX_PAYLOAD[TYPES.indexOf(type) + 1]!),
)) / 1024) * 1024;
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
function validateCommand(bytes: Uint8Array, offset = 0): void {
  check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= LIMITS.commandBytes, "Command must be 1..4096 bytes", offset);
  let text: string;
  try { text = decoder.decode(bytes); }
  catch (cause) { throw new ProtocolError("UTF8", "Invalid command UTF-8", offset, { cause }); }
  try { JSON.parse(text); }
  catch (cause) { throw new ProtocolError("VALUE", "Invalid command JSON", offset, { cause }); }
}
function equalInput(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  for (let i = 0; i < INPUT_BYTES; i++) if (a[i] !== b[i]) return false;
  return true;
}
function writeTickRecords(w: Writer, records: TickRecord[]): void {
  const start = w.offset;
  integer(records.length, LIMITS.tickRecords, 1); w.u16(records.length);
  let previous: (Uint8Array | undefined)[] = [];
  for (const record of records) {
    integer(record.tick, 0xffffffff);
    switch (record.type) {
      case "step": {
        w.u8(1); w.u32(record.tick);
        integer(record.commands.length, LIMITS.commands); w.u8(record.commands.length);
        for (const command of record.commands) { validateCommand(command); w.u16(command.length); w.bytes(command); }
        integer(record.inputs.length, 32);
        const current: (Uint8Array | undefined)[] = [];
        let mask = 0, count = 0, previousSlot = 0;
        for (const entry of record.inputs) {
          integer(entry.slot, 32, previousSlot + 1); validateInput(entry.input);
          current[entry.slot] = entry.input; mask += 2 ** (entry.slot - 1); previousSlot = entry.slot;
          if (!equalInput(previous[entry.slot], entry.input)) count++;
        }
        w.u32(mask); w.u8(count);
        for (const entry of record.inputs) if (!equalInput(previous[entry.slot], entry.input)) { w.u8(entry.slot); w.bytes(entry.input); }
        previous = current;
        break;
      }
      case "correct":
        integer(record.slot, 32, 1); validateInput(record.input);
        w.u8(2); w.u32(record.tick); w.u8(record.slot); w.bytes(record.input); break;
      case "hash": w.u8(3); w.u32(record.tick); w.u64(record.hash); break;
      default: throw new ProtocolError("TYPE", "Unknown tick record type");
    }
    if (w.offset - start > LIMITS.tickBatch - 4) throw new ProtocolError("OVERSIZED", "Tick records exceed batch limit");
  }
}
function readTickRecords(r: Reader): TickRecord[] {
  const count = r.u16(); integer(count, LIMITS.tickRecords, 1);
  const records: TickRecord[] = [];
  let previous: (Uint8Array | undefined)[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8(), tick = r.u32();
    switch (type) {
      case 1: {
        const commandCount = r.u8(); integer(commandCount, LIMITS.commands);
        const commands: Uint8Array[] = [];
        for (let c = 0; c < commandCount; c++) {
          const length = r.u16();
          if (length > LIMITS.commandBytes) throw new ProtocolError("OVERSIZED", "Command exceeds limit", r.offset - 2);
          const command = r.take(length); validateCommand(command, r.offset - length); commands.push(command);
        }
        const mask = r.u32(), changedCount = r.u8(); integer(changedCount, 32);
        const current: (Uint8Array | undefined)[] = [];
        let previousSlot = 0;
        for (let c = 0; c < changedCount; c++) {
          const slot = r.u8(); integer(slot, 32, previousSlot + 1);
          check((mask & 2 ** (slot - 1)) !== 0, "Changed slot absent from roster", r.offset - 1);
          const input = r.take(INPUT_BYTES); validateInput(input); current[slot] = input; previousSlot = slot;
        }
        const inputs: SlotInput[] = [];
        for (let slot = 1; slot <= 32; slot++) if ((mask & 2 ** (slot - 1)) !== 0) {
          const input = current[slot] ?? previous[slot];
          check(input !== undefined, "New human slot lacks input", r.offset);
          current[slot] = input; inputs.push({ slot, input });
        }
        previous = current; records.push({ type: "step", tick, commands, inputs }); break;
      }
      case 2: {
        const slot = r.u8(); integer(slot, 32, 1); const input = r.take(INPUT_BYTES); validateInput(input);
        records.push({ type: "correct", tick, slot, input }); break;
      }
      case 3: records.push({ type: "hash", tick, hash: r.u64() }); break;
      default: throw new ProtocolError("TYPE", "Unknown tick record type", r.offset - 5);
    }
  }
  return records;
}
/** Encodes a self-contained record batch once, for reuse across recipients. */
export function encodeTickRecords(records: TickRecord[]): Uint8Array {
  return typed(() => {
    const measure = new Writer(); writeTickRecords(measure, records);
    const bytes = new Uint8Array(measure.offset); writeTickRecords(new Writer(bytes), records); return bytes;
  });
}
/**
 * Frames already validated encodeTickRecords output without re-encoding records.
 * Treat recordBytes as immutable; payload validation happens when decoding.
 */
export function encodeTicksMessage(lastConsumedInputSeq: number, recordBytes: Uint8Array): Uint8Array {
  return typed(() => {
    integer(lastConsumedInputSeq, 0xffffffff);
    check(recordBytes instanceof Uint8Array && recordBytes.length >= 2, "Expected encoded tick records");
    if (recordBytes.length > LIMITS.tickBatch - 4) throw new ProtocolError("OVERSIZED", "Tick records exceed batch limit");
    integer(new DataView(recordBytes.buffer, recordBytes.byteOffset, recordBytes.byteLength).getUint16(0, true), LIMITS.tickRecords, 1);
    const bytes = new Uint8Array(HEADER_BYTES + 4 + recordBytes.length), w = new Writer(bytes);
    w.u16(PROTOCOL_VERSION); w.u8(4); w.u8(1); w.u32(4 + recordBytes.length);
    w.u32(lastConsumedInputSeq); w.bytes(recordBytes); return bytes;
  });
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
function writeLobbyState(w: Writer, s: LobbyState): void {
  check(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(s.code), "Invalid lobby code");
  w.text(s.code, LIMITS.lobbyCode, true); w.u8(modeId(s.mode)); w.text(s.map, LIMITS.map, true);
  integer(s.targetPlayers, 32, 1); w.u8(s.targetPlayers); integer(s.players.length, 32); w.u8(s.players.length);
  for (const p of s.players) { w.text(p.id, LIMITS.lobbyId, true); w.text(p.nickname, LIMITS.nickname, true); check(typeof p.ready === "boolean" && typeof p.host === "boolean", "Invalid roster flags"); w.u8(p.ready ? 1 : 0); w.u8(p.host ? 1 : 0); }
  check(typeof s.started === "boolean", "Invalid started"); w.u8(s.started ? 1 : 0);
  if (s.started) w.text(s.matchId!, LIMITS.matchId, true);
}

/** Encode common state once per broadcast; the leading started flag is helper metadata, not wire data. */
export function encodeLobbyStateShared(state: LobbyState): Uint8Array {
  return typed(() => {
    const measure = new Writer(); writeLobbyState(measure, state);
    const bytes = new Uint8Array(1 + measure.offset), w = new Writer(bytes);
    w.u8(state.started ? 1 : 0); writeLobbyState(w, state);
    return bytes;
  });
}

/** stateBytes must come from encodeLobbyStateShared for this broadcast. */
export function encodeLobbyStateMessage(selfId: string, stateBytes: Uint8Array, matchWsUrl?: string): Uint8Array {
  return typed(() => {
    check(stateBytes.length > 1 && (stateBytes[0] === 0 || stateBytes[0] === 1), "Invalid shared lobby state");
    check((stateBytes[0] === 1) === (matchWsUrl !== undefined), "Started lobby requires a match URL");
    const personalized = new Writer(); personalized.text(selfId, LIMITS.lobbyId, true);
    if (matchWsUrl !== undefined) personalized.text(matchWsUrl, LIMITS.matchWsUrl, true);
    const payloadBytes = personalized.offset + stateBytes.length - 1;
    const id = TYPES.indexOf("lobby-state") + 1;
    if (payloadBytes > MAX_PAYLOAD[id]!) throw new ProtocolError("OVERSIZED", "Payload exceeds message type limit");
    const bytes = new Uint8Array(HEADER_BYTES + payloadBytes), w = new Writer(bytes);
    w.u16(PROTOCOL_VERSION); w.u8(id); w.u8(0); w.u32(payloadBytes);
    w.text(selfId, LIMITS.lobbyId, true); w.bytes(stateBytes.subarray(1));
    if (matchWsUrl !== undefined) w.text(matchWsUrl, LIMITS.matchWsUrl, true);
    return bytes;
  });
}

function writePayload(w: Writer, m: Message): void {
  switch (m.type) {
    case "lobby-join": w.text(m.nickname, LIMITS.nickname, true); w.text(m.hostToken ?? "", LIMITS.hostToken); break;
    case "lobby-update": {
      const flags = (m.mode !== undefined ? 1 : 0) | (m.map !== undefined ? 2 : 0) | (m.targetPlayers !== undefined ? 4 : 0);
      integer(flags, 7, 1); w.u8(flags);
      if (m.mode !== undefined) w.u8(modeId(m.mode));
      if (m.map !== undefined) w.text(m.map, LIMITS.map, true);
      if (m.targetPlayers !== undefined) { integer(m.targetPlayers, 32, 1); w.u8(m.targetPlayers); }
      break;
    }
    case "lobby-ready": check(typeof m.ready === "boolean", "Invalid ready"); w.u8(m.ready ? 1 : 0); break;
    case "lobby-kick": w.text(m.id, LIMITS.lobbyId, true); break;
    case "lobby-start": case "lobby-leave": break;
    case "lobby-error": w.text(m.reason, LIMITS.reason, true); break;
    case "lobby-state": {
      w.text(m.selfId, LIMITS.lobbyId, true); writeLobbyState(w, m.state);
      if (m.state.started) w.text(m.state.matchWsUrl!, LIMITS.matchWsUrl, true);
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
    case "ticks": w.u32(m.lastConsumedInputSeq); writeTickRecords(w, m.records); break;
    case "state": w.u32(m.tick); w.u64(m.hash); w.u32(m.lastConsumedInputSeq); w.blob(m.bytes, MAX_STATE_BYTES); break;
    case "events":
      integer(m.events.length, LIMITS.events, 1); w.u16(m.events.length);
      for (const event of m.events) { validateEvent(event); w.u32(event.id); w.u32(event.tick); w.bytes(event.header); w.bytes(event.payload); }
      break;
    case "eventAck": integer(m.eventId, 0xffffffff, 1); w.u32(m.eventId); break;
    case "chat": w.text(m.text, LIMITS.chat, true); break;
    case "ping": case "pong": w.u64(m.timestamp); break;
    case "resync": break;
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
  const channelId = type === "state" || type === "ticks" ? 1 : 0;
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
    if (message.type === "ticks") return encodeTicksMessage(message.lastConsumedInputSeq, encodeTickRecords(message.records));
    const id = TYPES.indexOf(message.type) + 1;
    if (!id) throw new ProtocolError("TYPE", "Unknown message type");
    const measure = new Writer(); writePayload(measure, message);
    if (measure.offset > MAX_PAYLOAD[id]!) throw new ProtocolError("OVERSIZED", "Payload exceeds message type limit");
    const result = new Uint8Array(measure.offset + HEADER_BYTES), w = new Writer(result);
    w.u16(PROTOCOL_VERSION); w.u8(id); w.u8(message.type === "state" ? 1 : 0); w.u32(measure.offset); writePayload(w, message);
    return result;
  });
}
/** Byte fields borrow packet memory. Retain/copy the packet until consumers finish. */
export function decodeMessage(bytes: Uint8Array): Message {
  return typed(() => {
    const { type } = header(bytes), r = new Reader(bytes);
    let message: Message;
    switch (type) {
      case "lobby-join": { const nickname = r.text(LIMITS.nickname, true), hostToken = r.text(LIMITS.hostToken); message = { type, nickname, ...(hostToken ? { hostToken } : {}) }; break; }
      case "lobby-update": {
        const flags = r.u8(); integer(flags, 7, 1);
        const mode = flags & 1 ? readMode(r) : undefined, map = flags & 2 ? r.text(LIMITS.map, true) : undefined;
        const targetPlayers = flags & 4 ? r.u8() : undefined;
        if (targetPlayers !== undefined) integer(targetPlayers, 32, 1);
        message = { type, ...(mode !== undefined ? { mode } : {}), ...(map !== undefined ? { map } : {}), ...(targetPlayers !== undefined ? { targetPlayers } : {}) }; break;
      }
      case "lobby-ready": message = { type, ready: readBool(r) }; break;
      case "lobby-kick": message = { type, id: r.text(LIMITS.lobbyId, true) }; break;
      case "lobby-start": case "lobby-leave": message = { type }; break;
      case "lobby-error": message = { type, reason: r.text(LIMITS.reason, true) }; break;
      case "lobby-state": {
        const selfId = r.text(LIMITS.lobbyId, true), code = r.text(LIMITS.lobbyCode, true), mode = readMode(r), map = r.text(LIMITS.map, true), targetPlayers = r.u8(), count = r.u8();
        check(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code), "Invalid lobby code"); integer(targetPlayers, 32, 1); integer(count, 32);
        const players = [];
        for (let i = 0; i < count; i++) players.push({ id: r.text(LIMITS.lobbyId, true), nickname: r.text(LIMITS.nickname, true), ready: readBool(r), host: readBool(r) });
        const started = readBool(r);
        message = { type, selfId, state: { code, mode, map, targetPlayers, players, started, ...(started ? { matchId: r.text(LIMITS.matchId, true), matchWsUrl: r.text(LIMITS.matchWsUrl, true) } : {}) } }; break;
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
      case "ticks": message = { type, lastConsumedInputSeq: r.u32(), records: readTickRecords(r) }; break;
      case "state": message = { type, tick: r.u32(), hash: r.u64(), lastConsumedInputSeq: r.u32(), bytes: r.blob(MAX_STATE_BYTES) }; break;
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
      case "resync": message = { type }; break;
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
