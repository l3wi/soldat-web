import { expect, test } from "bun:test";
import { decodeMessage, encodeMessage, ProtocolError, PROTOCOL_VERSION, readChannel } from "../src/index.ts";
import type { Message } from "../src/index.ts";

const messages: Message[] = [
  { type: "lobby-join", nickname: "Sarge" },
  { type: "lobby-join", nickname: "Sarge", hostToken: "a".repeat(64) },
  { type: "lobby-update", mode: "ctf", map: "ctf_Ash", targetPlayers: 32 },
  { type: "lobby-update", map: "Arena" },
  { type: "lobby-ready", ready: false }, { type: "lobby-start" }, { type: "lobby-leave" },
  { type: "lobby-error", reason: "Only host may start" },
  { type: "lobby-state", selfId: "one", state: { code: "A1B2C3", mode: "dm", map: "Arena", targetPlayers: 8, players: [{ id: "one", nickname: "Sarge", ready: true, host: true }], started: false } },
  { type: "lobby-state", selfId: "one", state: { code: "A1B2C3", mode: "ctf", map: "ctf_Ash", targetPlayers: 32, players: Array.from({ length: 32 }, (_, i) => ({ id: String(i), nickname: "é".repeat(24), ready: true, host: i === 0 })), started: true, matchId: "match", matchWsUrl: "wss://localhost/matches/match?ticket=secret" } },
];
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
