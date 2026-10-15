import { Server as HttpsServer, createServer } from "node:https";
import type { ServerOptions } from "node:https";
import { WebSocketServer } from "ws";
import { MAX_PACKET_BYTES, PROTOCOL_VERSION, ProtocolError, decodeMessage, encodeMessage } from "@soldat-web/protocol";
import type { Message, ReliableEvent } from "@soldat-web/protocol";
import type { MessageTransport } from "@soldat-web/protocol/transport";
import { SIM_ABI_VERSION } from "@soldat-web/sim-host";
import { MatchController } from "./match-controller.ts";
import { createNodeTransport } from "./transport/ws-server.ts";
import type { MatchConfiguration } from "./worker-messages.ts";
import type { WorkerResponse } from "./worker-messages.ts";
import { INPUT_PACKET_BURST, INPUT_PACKETS_PER_SECOND } from "./input-buffer.ts";
export interface GameServerOptions {
  match: MatchConfiguration;
  httpsServer?: HttpsServer;
  tls?: ServerOptions;
  host?: string;
  port?: number;
  onError?: (error: Error) => void;
  onMetrics?: (metrics: Extract<WorkerResponse, { type: "metrics" }> & { wireEncodeMs: number[]; workerSimEncodeMs: number[] }) => void;
  onReliableEvent?: (slot: number, event: ReliableEvent) => void;
  onDisconnect?: (slot: number, code: number, reason: string) => void;
}
export interface GameServer {
  httpsServer: HttpsServer;
  close(): Promise<void>;
}
interface Session {
  transport: MessageTransport;
  state: "hello" | "joining" | "active" | "closed";
  timer: NodeJS.Timeout;
  inputTokens: number;
  lastInput: bigint;
  probe?: bigint;
  probeTimer?: NodeJS.Timeout;
  awaitingBaseline: boolean;
  expectedFullSnapshot?: number;
  probeDeadline?: bigint;
}

export function validateHello(message: Message, contentSetHash: string): void {
  if (message.type !== "hello") throw new ProtocolError("TYPE", "First packet must be hello");
  if (message.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError("VERSION", "Protocol version mismatch");
  if (message.simAbiVersion !== SIM_ABI_VERSION) throw new ProtocolError("VERSION", "Simulation ABI mismatch");
  if (Buffer.from(message.contentSetHash).toString("hex") !== contentSetHash) throw new ProtocolError("VALUE", "Content-set hash mismatch");
  if (!message.nickname.length || message.nickname !== message.nickname.trim() || /[\p{Cc}\p{Cf}]/u.test(message.nickname) || new TextEncoder().encode(message.nickname).length > 48) throw new ProtocolError("VALUE", "Invalid nickname");
  if (!Number.isInteger(message.weapon) || message.weapon < 1 || message.weapon > 10 || ![0, 11, 12, 13].includes(message.secondaryWeapon)) throw new ProtocolError("VALUE", "Invalid loadout");
}

export async function createGameServer(options: GameServerOptions): Promise<GameServer> {
  if (Boolean(options.httpsServer) === Boolean(options.tls)) throw new Error("Supply exactly one TLS configuration or attached HTTPS server; insecure WebSockets are unsupported");
  if (options.httpsServer && !(options.httpsServer instanceof HttpsServer)) throw new Error("Attached server must be an HTTPS server");
  if (options.tls && !((options.tls.key && options.tls.cert) || options.tls.pfx)) throw new Error("TLS requires a certificate and private key (or PFX)");
  if (!/^[a-f0-9]{64}$/.test(options.match.contentSetHash)) throw new Error("Content-set hash must be lowercase SHA-256 hex");
  const rules = new TextEncoder().encode(JSON.stringify(options.match.rules));
  if (rules.length > 4096) throw new Error("Rules exceed protocol limit");
  const matchSeed = BigInt(options.match.matchSeed);
  if (matchSeed < 0n || matchSeed > 0xffffffffffffffffn) throw new Error("Match seed must be u64");
  const controller = await MatchController.start(options.match);
  let server: HttpsServer;
  let sockets: WebSocketServer;
  try {
    server = options.httpsServer ?? createServer(options.tls!, (_request, response) => {
      response.writeHead(404); response.end();
    });
    sockets = new WebSocketServer({ server, maxPayload: MAX_PACKET_BYTES, perMessageDeflate: false });
  } catch (error) {
    await controller.stop();
    throw error;
  }
  const sessions = new Map<number, Session>();
  // A disconnected slot is not reusable until the worker confirms leave.
  const occupiedSlots = new Set<number>();
  let closing = false;
  let wireEncodeMs: number[] = [];
  const wireByTick = new Map<number, number>();
  const report = options.onError ?? ((error: Error) => console.error(error));
  const serverError = (error: Error) => { report(error); void close(); };
  const disconnect = (slot: number, code: number, reason: string) => {
    const session = sessions.get(slot);
    if (!session || session.state === "closed") return;
    session.state = "closed";
    clearTimeout(session.timer);
    clearInterval(session.probeTimer);
    sessions.delete(slot);
    options.onDisconnect?.(slot, code, reason);
    if (!closing) {
      try { controller.send({ type: "leave", slot }); } catch (error) { report(error instanceof Error ? error : new Error(String(error))); }
    }
    session.transport.close(code, reason);
  };
  const awaitBaseline = (slot: number, session: Session) => {
    if (session.awaitingBaseline) return;
    session.awaitingBaseline = true;
    delete session.expectedFullSnapshot;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => disconnect(slot, 1008, "Full snapshot acknowledgement timed out"), 60_000);
    session.timer.unref();
  };
  const baselineReady = (slot: number, session: Session, snapshotId: number) => {
    if (!session.awaitingBaseline || snapshotId !== session.expectedFullSnapshot) return;
    session.awaitingBaseline = false;
    clearTimeout(session.timer);
    if (session.probe !== undefined) session.probeDeadline = process.hrtime.bigint() + 10_000_000_000n;
    if (session.probeTimer) return;
    session.probeTimer = setInterval(() => {
      if (session.awaitingBaseline) return;
      const now = process.hrtime.bigint();
      if (session.probe !== undefined) {
        if (session.probeDeadline !== undefined && now > session.probeDeadline) disconnect(slot, 1008, "Timing probe timed out");
        return;
      }
      session.probe = now;
      session.probeDeadline = now + 10_000_000_000n;
      try { session.transport.send("reliableControl", encodeMessage({ type: "ping", timestamp: now / 1000n })); }
      catch (error) { report(error instanceof Error ? error : new Error(String(error))); disconnect(slot, 1011, "Timing probe failed"); }
    }, 1000);
    session.probeTimer.unref();
  };
  controller.onFailure = error => {
    report(error);
    void close();
  };
  controller.onMessage = response => {
    if (response.type === "metrics") {
      const firstTick = response.serverTick - response.simEncodeMs.length + 1;
      const simEncodeMs = response.simEncodeMs.map((ms, index) => ms + (wireByTick.get(firstTick + index) ?? 0));
      options.onMetrics?.({ ...response, workerSimEncodeMs: response.simEncodeMs, simEncodeMs, wireEncodeMs });
      wireEncodeMs = [];
      for (const tick of wireByTick.keys()) if (tick <= response.serverTick) wireByTick.delete(tick);
      return;
    }
    if (!("slot" in response)) return;
    if (response.type === "left") { occupiedSlots.delete(response.slot); return; }
    const session = sessions.get(response.slot);
    if (!session) return;
    try {
      if (response.type === "joined" && session.state === "joining") {
        session.transport.send("reliableControl", encodeMessage({ type: "welcome", slot: response.slot, serverTick: response.serverTick, tickRate: 60, matchSeed, map: options.match.map, rules }));
        session.state = "active";
        awaitBaseline(response.slot, session);
      } else if (response.type === "baseline" && session.state === "active") {
        baselineReady(response.slot, session, response.snapshotId);
      } else if (response.type === "send" && session.state === "active") {
        if (response.message.type === "snapshot" && response.message.baselineId === 0) {
          awaitBaseline(response.slot, session);
          session.expectedFullSnapshot = response.message.snapshotId;
        }
        const start = performance.now();
        const packet = encodeMessage(response.message);
        const encodingMs = performance.now() - start;
        wireEncodeMs.push(encodingMs);
        wireByTick.set(response.serverTick, (wireByTick.get(response.serverTick) ?? 0) + encodingMs);
        session.transport.send(response.message.type === "snapshot" ? "latestState" : "reliableControl", packet);
        if (response.message.type === "events") for (const event of response.message.events) options.onReliableEvent?.(response.slot, event);
      } else if (response.type === "reject") disconnect(response.slot, 1008, response.reason);
    } catch (error) { report(error instanceof Error ? error : new Error(String(error))); disconnect(response.slot, 1011, "Server packet failure"); }
  };
  sockets.on("connection", socket => {
    if (closing || occupiedSlots.size >= 32) { socket.close(1013, "Match unavailable or full"); return; }
    let slot = 1;
    while (occupiedSlots.has(slot)) slot++;
    occupiedSlots.add(slot);
    const transport = createNodeTransport(socket);
    const session: Session = { transport, state: "hello", timer: setTimeout(() => disconnect(slot, 1008, "Admission timed out"), 5000), inputTokens: INPUT_PACKET_BURST, lastInput: process.hrtime.bigint(), awaitingBaseline: false };
    sessions.set(slot, session);
    transport.onClose = (code, reason) => disconnect(slot, code, reason || "Connection closed");
    transport.onError = error => { report(error); disconnect(slot, 1002, "Transport error"); };
    transport.onMessage = (channel, packet) => {
      try {
        if (channel !== "reliableControl") throw new ProtocolError("CHANNEL", "Clients may only send reliable control messages");
        const message = decodeMessage(packet);
        if (session.state === "hello") {
          validateHello(message, options.match.contentSetHash);
          if (message.type !== "hello") throw new ProtocolError("TYPE", "Expected hello");
          session.state = "joining";
          controller.send({ type: "join", slot, weapon: message.weapon, secondaryWeapon: message.secondaryWeapon });
          return;
        }
        if (session.state !== "active") throw new ProtocolError("VALUE", "Admission is not complete");
        switch (message.type) {
          case "input": {
            // Bound IPC traffic before posting into the worker's input queue.
            const now = process.hrtime.bigint();
            session.inputTokens = Math.min(INPUT_PACKET_BURST, session.inputTokens + Number(now - session.lastInput) / 1e9 * INPUT_PACKETS_PER_SECOND);
            session.lastInput = now;
            if (session.inputTokens < 1) { disconnect(slot, 1008, "Input rate limit exceeded"); return; }
            session.inputTokens--;
            controller.send({ type: "input", slot, frames: message.frames });
            break;
          }
          case "snapshotAck": controller.send({ type: "snapshotAck", slot, snapshotId: message.snapshotId }); break;
          case "eventAck": controller.send({ type: "eventAck", slot, eventId: message.eventId }); break;
          case "resync":
            awaitBaseline(slot, session);
            controller.send({ type: "resync", slot, baselineId: message.baselineId });
            break;
          case "ping": transport.send("reliableControl", encodeMessage({ type: "pong", timestamp: message.timestamp })); break;
          case "pong":
            if (session.probe === undefined || message.timestamp !== session.probe / 1000n) throw new ProtocolError("VALUE", "Unknown timing probe");
            controller.send({ type: "rtt", slot, milliseconds: Number(process.hrtime.bigint() - session.probe) / 1e6 });
            delete session.probe;
            delete session.probeDeadline;
            break;
          case "disconnect": disconnect(slot, 1000, "Client disconnected"); break;
          case "chat": throw new ProtocolError("TYPE", "Chat is not implemented by this server foundation");
          default: throw new ProtocolError("TYPE", "Message is not permitted from a client");
        }
      } catch (error) {
        if (!(error instanceof ProtocolError)) report(error instanceof Error ? error : new Error(String(error)));
        disconnect(slot, error instanceof ProtocolError ? 1008 : 1011, error instanceof ProtocolError ? "Protocol admission or message rejected" : "Server failure");
      }
    };
  });
  sockets.on("error", error => { report(error); void close(); });
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const slot of sessions.keys()) disconnect(slot, 1001, "Server shutting down");
      server.off("error", serverError);
      const terminate = setTimeout(() => { for (const socket of sockets.clients) socket.terminate(); }, 1000);
      terminate.unref();
      await Promise.all([
        controller.stop(),
        new Promise<void>(resolve => sockets.close(() => resolve())),
        options.httpsServer || !server.listening ? Promise.resolve() : new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      ]).finally(() => clearTimeout(terminate));
    })();
    return closePromise;
  }
  if (!options.httpsServer) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 443, options.host ?? "0.0.0.0", () => { server.off("error", reject); resolve(); });
      });
    } catch (error) { await close(); throw error; }
  }
  server.on("error", serverError);
  return { httpsServer: server, close };
}
