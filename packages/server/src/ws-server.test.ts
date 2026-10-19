import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { encodeMessage } from "@soldat-web/protocol";
import { BackpressureError } from "@soldat-web/protocol/transport";
import { createNodeTransport } from "./transport/ws-server.ts";
import { TransportMetrics } from "./transport-metrics.ts";
import type { NodeTransportObserver } from "./transport/ws-server.ts";

/** Deterministic socket test double: a held write callback models a stalled peer. */
class StalledSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  binaryType = "nodebuffer";
  terminated = false;
  writes = 0;
  readonly packets: Uint8Array[] = [];
  readonly callbacks: ((error?: Error) => void)[] = [];
  send(packet: Uint8Array, _options: unknown, callback: (error?: Error) => void): void {
    this.writes++;
    this.packets.push(packet);
    this.callbacks.push(callback);
  }
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

test("queue residence and stalled ages preserve a single cross-channel FIFO and owned bytes", () => {
  const socket = new StalledSocket(), metrics = new TransportMetrics();
  let now = 0;
  const transport = createNodeTransport(socket as unknown as WebSocket, 1024, { observer: metrics, nowMs: () => now });
  const first = encodeMessage({ type: "ping", timestamp: 1n });
  const second = encodeMessage({ type: "ticks", lastConsumedInputSeq: 0, records: [{ type: "hash", tick: 1, hash: 1n }] });
  const third = encodeMessage({ type: "ping", timestamp: 3n });
  const expected = [first.slice(), second.slice(), third.slice()];
  transport.send("reliableControl", first);
  now = 10; transport.send("latestState", second);
  now = 20; transport.send("reliableControl", third);
  first.fill(0); second.fill(0); third.fill(0);
  now = 1000; transport.sampleQueue();
  const stalled = metrics.take();
  assert.equal(stalled.residenceMs.count, 1);
  assert.equal(stalled.oldestQueuedAgeMs.max, 990);
  assert.equal(stalled.inFlightAgeMs.max, 1000);
  assert.equal(stalled.queuedPackets.max, 2);
  assert.equal(stalled.queuedBytes.max, expected[1]!.length + expected[2]!.length);
  assert.equal(socket.callbacks.length, 1, "one socket write remains in flight");
  now = 1100; socket.callbacks.shift()!();
  assert.equal(socket.callbacks.length, 1);
  now = 1200; socket.callbacks.shift()!();
  assert.equal(socket.callbacks.length, 1);
  now = 1300; socket.callbacks.shift()!();
  assert.deepEqual(socket.packets, expected);
  const drained = metrics.take();
  assert.equal(drained.residenceMs.count, 2);
  assert.equal(drained.residenceMs.min, 1090);
  assert.equal(drained.residenceMs.max, 1180);
  transport.close();
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
});

test("socket buffering stalls queues without inventing completed residence samples", () => {
  const socket = new StalledSocket(), metrics = new TransportMetrics();
  let now = 0;
  const transport = createNodeTransport(socket as unknown as WebSocket, 1024, { observer: metrics, nowMs: () => now });
  socket.bufferedAmount = 32;
  transport.send("reliableControl", encodeMessage({ type: "ping", timestamp: 0n }));
  now = 400; transport.sampleQueue();
  const stalled = metrics.take();
  assert.equal(socket.writes, 0);
  assert.equal(stalled.residenceMs.count, 0);
  assert.equal(stalled.oldestQueuedAgeMs.max, 400);
  assert.equal(stalled.inFlightAgeMs.max, 0);
  assert.equal(stalled.socketBufferedBytes.max, 32);
  transport.close();
  now = 800; transport.sampleQueue();
  const closed = metrics.take();
  assert.equal(closed.queuedPackets.max, 0);
  assert.equal(closed.queuedBytes.max, 0);
  assert.equal(closed.oldestQueuedAgeMs.max, 0);
  assert.equal(socket.writes, 0);
  assert.throws(() => transport.send("reliableControl", encodeMessage({ type: "ping", timestamp: 1n })), /closed/);
});

test("send callback errors clear queued observations and late callbacks never resume delivery", () => {
  const socket = new StalledSocket(), metrics = new TransportMetrics();
  let now = 0, errors = 0;
  const transport = createNodeTransport(socket as unknown as WebSocket, 1024, { observer: metrics, nowMs: () => now });
  transport.onError = () => { errors++; };
  const packet = encodeMessage({ type: "ping", timestamp: 0n });
  transport.send("reliableControl", packet);
  transport.send("reliableControl", packet);
  const callback = socket.callbacks.shift()!;
  now = 100; callback(new Error("write failed"));
  now = 200; callback();
  metrics.take();
  transport.sampleQueue();
  const closed = metrics.take();
  assert.equal(errors, 1);
  assert.equal(socket.writes, 1);
  assert.equal(closed.queuedPackets.max, 0);
  assert.equal(closed.inFlightBytes.max, 0);
  assert.equal(closed.oldestQueuedAgeMs.max, 0);
  assert.equal(closed.inFlightAgeMs.max, 0);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
});

test("diagnostic observer failures cannot reorder or abort accepted socket writes", () => {
  const socket = new StalledSocket();
  const observer: NodeTransportObserver = {
    handoff() { throw new Error("diagnostics unavailable"); },
    queueState() { throw new Error("diagnostics unavailable"); },
  };
  const transport = createNodeTransport(socket as unknown as WebSocket, 1024, { observer });
  const first = encodeMessage({ type: "ping", timestamp: 1n }), second = encodeMessage({ type: "ping", timestamp: 2n });
  transport.send("reliableControl", first);
  transport.send("reliableControl", second);
  socket.callbacks.shift()!();
  socket.callbacks.shift()!();
  assert.deepEqual(socket.packets, [first, second]);
  assert.equal(socket.readyState, WebSocket.OPEN);
  transport.close();
});
