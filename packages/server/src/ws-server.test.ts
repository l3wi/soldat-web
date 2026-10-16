import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { encodeMessage } from "@soldat-web/protocol";
import { BackpressureError } from "@soldat-web/protocol/transport";
import { createNodeTransport } from "./transport/ws-server.ts";

/** Deterministic socket test double: a held write callback models a stalled peer. */
class StalledSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  binaryType = "nodebuffer";
  terminated = false;
  writes = 0;
  send(): void { this.writes++; }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit("close", 1000, Buffer.alloc(0)); }
  terminate(): void { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit("close", 1006, Buffer.alloc(0)); }
}

test("F-04 socket bufferedAmount counts against the outbound budget and terminates immediately", () => {
  const socket = new StalledSocket();
  const transport = createNodeTransport(socket as unknown as WebSocket, 32);
  let error: Error | undefined; transport.onError = value => { error = value; };
  socket.bufferedAmount = 33;
  transport.send("reliableControl", encodeMessage({ type: "ping", timestamp: 0n }));
  assert.equal(socket.terminated, true); assert.equal(socket.writes, 0); assert.ok(error instanceof BackpressureError);
});
test("F-04 combined queue and in-flight write stays inside the configured outbound ceiling", () => {
  const socket = new StalledSocket();
  const transport = createNodeTransport(socket as unknown as WebSocket, 32);
  let error: Error | undefined; transport.onError = value => { error = value; };
  const packet = encodeMessage({ type: "ping", timestamp: 0n }); assert.equal(packet.length, 16);
  transport.send("reliableControl", packet);
  transport.send("reliableControl", packet);
  assert.equal(socket.terminated, false);
  transport.send("reliableControl", packet);
  assert.equal(socket.terminated, true); assert.equal(socket.writes, 1); assert.ok(error instanceof BackpressureError);
});
