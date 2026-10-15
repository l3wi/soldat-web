import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import test from "node:test";
import { PROTOCOL_VERSION, ProtocolError, decodeMessage, encodeMessage } from "@soldat-web/protocol";
import type { Message } from "@soldat-web/protocol";
import { SIM_ABI_VERSION } from "@soldat-web/sim-host";
import { MatchController } from "./match-controller.ts";
import { createGameServer, validateHello } from "./server.ts";
import type { MatchConfiguration } from "./worker-messages.ts";

const hash = "ab".repeat(32);
const match: MatchConfiguration = { wasmPath: "missing-sim.wasm", contentRoot: "missing-server-test-content", contentSetHash: hash, map: "Arena", rules: {}, matchSeed: "1" };
const hello: Extract<Message, { type: "hello" }> = { type: "hello", protocolVersion: PROTOCOL_VERSION, contentSetHash: new Uint8Array(Buffer.from(hash, "hex")), simAbiVersion: SIM_ABI_VERSION, nickname: "Player" };

test("admission validates a codec-decoded hello against protocol, content and ABI", () => {
  assert.doesNotThrow(() => validateHello(decodeMessage(encodeMessage(hello)), hash));
  assert.throws(() => validateHello({ ...hello, protocolVersion: PROTOCOL_VERSION + 1 }, hash), ProtocolError);
  assert.throws(() => validateHello({ ...hello, simAbiVersion: SIM_ABI_VERSION + 1 }, hash), ProtocolError);
  assert.throws(() => validateHello({ ...hello, contentSetHash: new Uint8Array(32) }, hash), ProtocolError);
  assert.throws(() => validateHello({ type: "ping", timestamp: 0n }, hash), ProtocolError);
});

test("nicknames reject whitespace-only, leading/trailing and control/invisible text", () => {
  for (const nickname of ["", " ", " Player", "Player ", "bad\u0000name", "hidden\u200bname", "é".repeat(25)]) {
    assert.throws(() => validateHello({ ...hello, nickname }, hash), ProtocolError);
  }
  assert.doesNotThrow(() => validateHello({ ...hello, nickname: "Zoë Player" }, hash));
});

test("listener has no insecure fallback and rejects attached HTTP before starting a match", async () => {
  await assert.rejects(createGameServer({ match }), /TLS/);
  await assert.rejects(createGameServer({ match, tls: {} }), /TLS/);
  const insecure = createHttpServer();
  await assert.rejects(createGameServer({ match, httpsServer: insecure as unknown as HttpsServer }), /HTTPS/);
});

test("unavailable simulation/content explicitly fails worker match start", async () => {
  await assert.rejects(MatchController.start(match), /Match start failed/);
});
