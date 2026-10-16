import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, decodeMessage, encodeMessage, type Message } from "@soldat-web/protocol";
import { SIM_ABI_VERSION, type SimManifest } from "@soldat-web/sim-host";
import { createGameServer, type GameServer } from "../src/server.ts";
import type { MatchConfiguration, WorkerResponse } from "../src/worker-messages.ts";

export const FROZEN_WASM_SHA256 = "e8c4fbe214eca1559e2a407e4ac8a973a09c592ff443bd6b3862f6a9b9679dd1";
export const exec = promisify(execFile);
export const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
export const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

export class Evidence {
  readonly stream: WriteStream;
  constructor(path: string) { this.stream = createWriteStream(path); }
  record(value: unknown): void { this.stream.write(`${json({ monotonicMs: performance.now(), ...value as object })}\n`); }
  async close(): Promise<void> { this.stream.end(); await once(this.stream, "finish"); }
}

export interface QualificationConfig {
  match: MatchConfiguration;
  wasm: Uint8Array<ArrayBuffer>;
  manifest: SimManifest;
  tls: { key: Buffer; cert: Buffer };
}
export interface EnqueuedEvent { at: number; slot: number; id: number; tick: number; kind: number }
export interface QualificationServer extends QualificationConfig {
  server: GameServer;
  evidence: Evidence;
  metrics: Extract<WorkerResponse, { type: "metrics" }>[];
  errors: string[];
  enqueuedEvents: EnqueuedEvent[];
  url: string;
  close(): Promise<void>;
}

export async function qualificationConfig(out: string): Promise<QualificationConfig> {
  await mkdir(out, { recursive: true });
  const wasmPath = resolve(process.env.NET_G4_WASM ?? fileURLToPath(new URL("../../../build-out/sim/sim.wasm", import.meta.url)));
  const contentRoot = resolve(process.env.NET_G4_CONTENT ?? fileURLToPath(new URL("../../../dist/content", import.meta.url)));
  const wasm = new Uint8Array(await readFile(wasmPath));
  const hash = createHash("sha256").update(wasm).digest("hex");
  if (hash !== FROZEN_WASM_SHA256) throw new Error(`Frozen WASM mismatch: ${hash}`);
  const manifest = JSON.parse(await readFile(resolve(contentRoot, "sim/manifest.json"), "utf8")) as SimManifest;
  const keyPath = resolve(out, "localhost-key.pem"), certPath = resolve(out, "localhost-cert.pem");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1", "-keyout", keyPath, "-out", certPath]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  return { wasm, manifest, tls: { key, cert }, match: { wasmPath, contentRoot, contentSetHash: manifest.sha256, map: "Arena", rules: { rng: "keyed", ai: false, world: "fixture" }, matchSeed: "123456789" } };
}

export async function qualificationServer(out: string, port = 0): Promise<QualificationServer> {
  const config = await qualificationConfig(out);
  const evidence = new Evidence(resolve(out, "server.jsonl"));
  const metrics: Extract<WorkerResponse, { type: "metrics" }>[] = [];
  const errors: string[] = [];
  const enqueuedEvents: EnqueuedEvent[] = [];
  const server = await createGameServer({ match: config.match, tls: config.tls, port, host: "0.0.0.0",
    onMetrics: sample => { metrics.push(sample); evidence.record({ ...sample, type: "server-metrics" }); },
    onReliableEvent: (slot, event) => {
      const record = { at: performance.now(), slot, id: event.id, tick: event.tick, kind: new DataView(event.header.buffer, event.header.byteOffset).getUint32(0, true) };
      enqueuedEvents.push(record); evidence.record({ type: "server-enqueued-event", ...record });
    },
    onDisconnect: (slot, code, reason) => evidence.record({ type: "server-policy-disconnect", slot, code, reason }),
    onError: error => { errors.push(error.stack ?? error.message); evidence.record({ type: "server-error", error: error.stack ?? error.message }); },
  });
  const address = server.httpsServer.address();
  if (!address || typeof address === "string") throw new Error("WSS listener missing TCP address");
  return { ...config, server, evidence, metrics, enqueuedEvents, errors, url: `wss://127.0.0.1:${address.port}`, async close() { await server.close(); await evidence.close(); } };
}

/** Real binary WSS peer for adversarial tests. It never synthesizes server packets. */
export class RawPeer {
  readonly socket: WebSocket;
  readonly messages: Message[] = [];
  readonly packets: Buffer[] = [];
  closed: { code: number; reason: string } | undefined;
  error: Error | undefined;
  constructor(url: string, readonly acknowledgeSnapshots = true) {
    this.socket = new WebSocket(url, { rejectUnauthorized: false, perMessageDeflate: false });
    this.socket.on("error", error => { this.error = error; });
    this.socket.on("close", (code, reason) => { this.closed = { code, reason: reason.toString() }; });
    this.socket.on("message", bytes => {
      const packet = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer);
      this.packets.push(packet);
      const message = decodeMessage(packet); this.messages.push(message);
      if (message.type === "ping") this.send({ type: "pong", timestamp: message.timestamp });
      if (message.type === "snapshot" && this.acknowledgeSnapshots) this.send({ type: "snapshotAck", snapshotId: message.snapshotId });
      if (message.type === "events") this.send({ type: "eventAck", eventId: message.events.at(-1)!.id });
    });
  }
  async connect(hash: string, nickname = "Security", weapon = 4): Promise<Extract<Message, { type: "welcome" }>> {
    await once(this.socket, "open");
    this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, contentSetHash: Buffer.from(hash, "hex"), simAbiVersion: SIM_ABI_VERSION, nickname, weapon, secondaryWeapon: 0 });
    return this.waitFor((message): message is Extract<Message, { type: "welcome" }> => message.type === "welcome");
  }
  send(message: Message): void { this.socket.send(encodeMessage(message)); }
  async waitFor<T extends Message>(predicate: (message: Message) => message is T, start = 0, timeout = 5000): Promise<T> {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const message = this.messages.slice(start).find(predicate);
      if (message) return message;
      if (this.closed) throw new Error(`WSS closed ${this.closed.code}: ${this.closed.reason}`);
      if (this.error) throw this.error;
      await delay(5);
    }
    throw new Error("Timed out waiting for real WSS message");
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close"); this.socket.close(); await closed;
  }
}
