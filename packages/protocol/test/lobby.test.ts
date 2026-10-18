import { expect, test } from "bun:test";
import { decodeMessage, encodeLobbyStateMessage, encodeLobbyStateShared, encodeMessage, LIMITS, ProtocolError, PROTOCOL_VERSION, readChannel, normalizeMatchRules, GAME_MODES } from "../src/index.ts";
import type { Message } from "../src/index.ts";

const messages: Message[] = [
  { type: "lobby-join", nickname: "Sarge" },
  { type: "lobby-join", nickname: "Sarge", hostToken: "a".repeat(64) },
  { type: "lobby-update", mode: "ctf", map: "ctf_Ash", targetPlayers: 32 },
  { type: "lobby-update", map: "Arena" },
  { type: "lobby-ready", ready: false }, { type: "lobby-start" }, { type: "lobby-leave" },
  { type: "lobby-kick", id: "guest" }, { type: "lobby-kick", id: "é".repeat(LIMITS.lobbyId / 2) },
  { type: "lobby-error", reason: "Only host may start" },
  { type: "lobby-state", selfId: "one", state: { code: "A1B2C3D4", mode: "dm", map: "Arena", rules: normalizeMatchRules({ mode: "dm" }), mapRotation: ["Arena"], targetPlayers: 8, players: [{ id: "one", nickname: "Sarge", ready: true, host: true }], started: false } },
  { type: "lobby-state", selfId: "one", state: { code: "A1B2C3D4", mode: "ctf", map: "ctf_Ash", rules: normalizeMatchRules({ mode: "ctf" }), mapRotation: ["ctf_Ash"], targetPlayers: 32, players: Array.from({ length: 32 }, (_, i) => ({ id: String(i), nickname: "é".repeat(24), ready: true, host: i === 0 })), started: true, matchId: "match", matchWsUrl: "wss://localhost/matches/match?ticket=secret" } },
];
for (const mode of GAME_MODES) messages.push({ type: "lobby-update", mode, rules: normalizeMatchRules({ mode }), mapRotation: ["Arena"] });
for (const [index, message] of messages.entries()) test(`lobby codec ${message.type} ${index}`, () => {
  const packet = encodeMessage(message);
  expect(packet[0]).toBe(PROTOCOL_VERSION);
  expect(readChannel(packet)).toBe("reliableControl");
  expect(decodeMessage(packet)).toEqual(message);
  for (let n = 0; n < packet.length; n++) expect(() => decodeMessage(packet.subarray(0, n))).toThrow(ProtocolError);
  const old = packet.slice(); old[0] = 2;
  expect(() => decodeMessage(old)).toThrow(ProtocolError);
});
test("lobby codec rejects malformed flags, booleans and capacity", () => {
  for (const targetPlayers of [0, 33, NaN, 1.5]) expect(() => encodeMessage({ type: "lobby-update", targetPlayers })).toThrow(ProtocolError);
  expect(() => encodeMessage({ type: "lobby-update" })).toThrow(ProtocolError);
  const ready = encodeMessage({ type: "lobby-ready", ready: true }); ready[8] = 2;
  expect(() => decodeMessage(ready)).toThrow(ProtocolError);
  const update = encodeMessage({ type: "lobby-update", mode: "dm" }); update[8] = 8;
  expect(() => decodeMessage(update)).toThrow(ProtocolError);
});

test("lobby kick rejects empty, oversized and malformed UTF-8 ids", () => {
  for (const id of ["", "a".repeat(LIMITS.lobbyId + 1), "é".repeat(LIMITS.lobbyId)]) expect(() => encodeMessage({ type: "lobby-kick", id })).toThrow(ProtocolError);
  const packet = encodeMessage({ type: "lobby-kick", id: "ab" });
  expect(packet[2]).toBe(21);
  packet[10] = 0xc0; packet[11] = 0xaf;
  expect(() => decodeMessage(packet)).toThrow(ProtocolError);
  const oversized = encodeMessage({ type: "lobby-kick", id: "a".repeat(LIMITS.lobbyId) });
  new DataView(oversized.buffer).setUint16(8, LIMITS.lobbyId + 1, true);
  expect(() => decodeMessage(oversized)).toThrow(ProtocolError);
});

test("lobby state requires eight Crockford characters and rejects old codes", () => {
  const state = messages.find(message => message.type === "lobby-state")!;
  if (state.type !== "lobby-state") throw new Error("Missing lobby fixture");
  for (const code of ["A1B2C3", "A1B2C3I4", "A1B2C3L4", "A1B2C3O4", "A1B2C3U4", "a1b2c3d4"]) {
    expect(() => encodeMessage({ ...state, state: { ...state.state, code } })).toThrow(ProtocolError);
  }
  const packet = encodeMessage(state);
  packet[8 + 2 + state.selfId.length + 2] = "I".charCodeAt(0);
  expect(() => decodeMessage(packet)).toThrow(ProtocolError);
});

test("shared lobby encoding preserves wire bytes and personalizes only recipient fields", () => {
  for (const message of messages) {
    if (message.type !== "lobby-state") continue;
    const shared = encodeLobbyStateShared(message.state), original = shared.slice();
    const packet = encodeLobbyStateMessage(message.selfId, shared, message.state.matchWsUrl);
    expect(packet).toEqual(encodeMessage(message));
    expect(decodeMessage(packet)).toEqual(message);
    const matchWsUrl = message.state.started ? "wss://localhost/matches/match?ticket=other" : undefined;
    expect(decodeMessage(encodeLobbyStateMessage("two", shared, matchWsUrl))).toEqual({
      ...message, selfId: "two", state: { ...message.state, ...(matchWsUrl ? { matchWsUrl } : {}) },
    });
    expect(shared).toEqual(original);
    expect(() => encodeLobbyStateMessage("one", shared, message.state.started ? undefined : "wss://unexpected")).toThrow(ProtocolError);
  }
});
