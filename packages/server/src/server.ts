import { Server as HttpsServer, createServer } from "node:https";
import type { ServerOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { MAX_CLIENT_PACKET_BYTES, PROTOCOL_VERSION, ProtocolError, decodeMessage, encodeMessage, encodeTicksMessage, validateWeaponChoice } from "@soldat-web/protocol";
import type { Message, ReliableEvent } from "@soldat-web/protocol";
import type { MessageTransport } from "@soldat-web/protocol/transport";
import { SIM_ABI_VERSION } from "@soldat-web/sim-host";
import { MatchController } from "./match-controller.ts";
import { createNodeTransport } from "./transport/ws-server.ts";
import type { MatchConfiguration } from "./worker-messages.ts";
import type { WorkerResponse } from "./worker-messages.ts";
import { INPUT_PACKET_BURST, INPUT_PACKETS_PER_SECOND } from "./input-buffer.ts";
import { configureMatch, reservedBotSlots, WEAPON_CHOICE_BURST, WEAPON_CHOICES_PER_SECOND } from "./bots.ts";
import { ConnectionAdmission, TokenBucket, hardeningLimits, sourceIp } from "./hardening.ts";
export interface GameServerOptions {
  match: MatchConfiguration;
  httpsServer?: HttpsServer;
  tls?: ServerOptions;
  host?: string;
  port?: number;
  path?: string;
  authorize?: (request: IncomingMessage) => boolean;
  admission?: ConnectionAdmission;
  outboundQueueBytes?: number;
  controlBurst?: number;
  controlPerSecond?: number;
  onError?: (error: Error) => void;
  onMetrics?: (metrics: Extract<WorkerResponse, { type: "metrics" }> & { wireEncodeMs: number[]; workerSimEncodeMs: number[] }) => void;
  onReliableEvent?: (slot: number, event: ReliableEvent) => void;
  onDisconnect?: (slot: number, code: number, reason: string) => void;
}
export interface GameServer {
  httpsServer: HttpsServer;
  close(): Promise<void>;
  readonly humanCount: number;
  readonly humans: string[];
  readonly available: boolean;
}
interface Session {
  transport: MessageTransport;
  nickname?: string;
  state: "hello" | "joining" | "active" | "closed";
  timer: NodeJS.Timeout;
  inputTokens: number;
  lastInput: bigint;
  weaponTokens: number;
  lastWeaponChoice: bigint;
  probe?: bigint;
  probeTimer?: NodeJS.Timeout;
  probeDeadline?: bigint;
  control: TokenBucket;
  lastPing: number;
  pendingResync: boolean;
  pendingAck?: number;
  controlFlush?: NodeJS.Immediate;
  admitted(): void;
}

export function validateHello(message: Message, contentSetHash: string): void {
  if (message.type !== "hello") throw new ProtocolError("TYPE", "First packet must be hello");
  if (message.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError("VERSION", "Protocol version mismatch");
  if (message.simAbiVersion !== SIM_ABI_VERSION) throw new ProtocolError("VERSION", "Simulation ABI mismatch");
  if (Buffer.from(message.contentSetHash).toString("hex") !== contentSetHash) throw new ProtocolError("VALUE", "Content-set hash mismatch");
  if (!message.nickname.length || message.nickname !== message.nickname.trim() || /[\p{Cc}\p{Cf}]/u.test(message.nickname) || new TextEncoder().encode(message.nickname).length > 48) throw new ProtocolError("VALUE", "Invalid nickname");
  validateWeaponChoice(message.weapon, message.secondaryWeapon);
}

export async function createGameServer(options: GameServerOptions): Promise<GameServer> {
  if (Boolean(options.httpsServer) === Boolean(options.tls)) throw new Error("Supply exactly one TLS configuration or attached HTTPS server; insecure WebSockets are unsupported");
  if (options.httpsServer && !(options.httpsServer instanceof HttpsServer)) throw new Error("Attached server must be an HTTPS server");
  if (options.tls && !((options.tls.key && options.tls.cert) || options.tls.pfx)) throw new Error("TLS requires a certificate and private key (or PFX)");
  if (!/^[a-f0-9]{64}$/.test(options.match.contentSetHash)) throw new Error("Content-set hash must be lowercase SHA-256 hex");
  options = { ...options, match: configureMatch(options.match) };
  const limits = hardeningLimits(options);
  const admission = options.admission ?? new ConnectionAdmission(limits);
  const permits = new WeakMap<WebSocket, { joined(): void; release(): void }>();
  const rules = new TextEncoder().encode(JSON.stringify(options.match.rules));
  if (rules.length > 4096) throw new Error("Rules exceed protocol limit");
  const matchSeed = BigInt(options.match.matchSeed);
  if (matchSeed < 0n || matchSeed > 0xffffffffffffffffn) throw new Error("Match seed must be u64");
  const controller = await MatchController.start(options.match);
  let server: HttpsServer;
  let sockets: WebSocketServer;
  try {
    server = options.httpsServer ?? createServer({ ...options.tls!, handshakeTimeout: 5000 }, (_request, response) => {
      response.writeHead(404); response.end();
    });
    sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_PACKET_BYTES, perMessageDeflate: false });
  } catch (error) {
    await controller.stop();
    throw error;
  }
  const sessions = new Map<number, Session>();
  // A disconnected slot is not reusable until the worker confirms leave.
  const pendingConnections = new Map<WebSocket, NodeJS.Timeout>();
  const occupiedSlots = new Set<number>(options.match.targetPlayers === undefined ? reservedBotSlots(options.match.botCount!) : []);
  let closing = false;
  let wireEncodeMs: number[] = [];
  const wireByTick = new Map<number, number>();
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (socket.destroyed) return;
    if (new URL(request.url ?? "/", "https://localhost").pathname !== (options.path ?? "/")) return;
    if (closing || sessions.size + pendingConnections.size >= (options.match.targetPlayers ?? 32) + 2) { socket.destroy(); return; }
    const permit = admission.acquire(sourceIp(request.socket.remoteAddress));
    if (!permit) { socket.destroy(); return; }
    socket.once("close", permit.release);
    try {
      if (options.authorize && !options.authorize(request)) { permit.release(); socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, ws => { permits.set(ws, permit); sockets.emit("connection", ws, request); });
    } catch { permit.release(); socket.destroy(); }
  };
  server.on("upgrade", upgrade);
  const report = options.onError ?? ((error: Error) => console.error(error));
  const serverError = (error: Error) => { report(error); void close(); };
  const disconnect = (slot: number, code: number, reason: string) => {
    const session = sessions.get(slot);
    if (!session || session.state === "closed") return;
    session.state = "closed";
    clearTimeout(session.timer);
    clearInterval(session.probeTimer);
    clearImmediate(session.controlFlush);
    sessions.delete(slot);
    options.onDisconnect?.(slot, code, reason);
    if (!closing) {
      try { controller.send({ type: "leave", slot }); } catch (error) { report(error instanceof Error ? error : new Error(String(error))); }
    }
    session.transport.close(code, reason);
  };
  const stateReady = (slot: number, session: Session) => {
    clearTimeout(session.timer);
    if (session.probeTimer) return;
    session.probeTimer = setInterval(() => {
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
    if (response.type === "ticks") {
      for (const recipient of response.recipients) {
        const session = sessions.get(recipient.slot);
        if (!session || session.state !== "active") continue;
        try {
          const start = performance.now();
          const packet = encodeTicksMessage(recipient.lastConsumedInputSeq, response.records);
          const encodingMs = performance.now() - start;
          wireEncodeMs.push(encodingMs);
          wireByTick.set(response.serverTick, (wireByTick.get(response.serverTick) ?? 0) + encodingMs);
          session.transport.send("latestState", packet);
        } catch (error) { report(error instanceof Error ? error : new Error(String(error))); disconnect(recipient.slot, 1011, "Server packet failure"); }
      }
      return;
    }
    if (!("slot" in response)) return;
    if (response.type === "left") {
      occupiedSlots.delete(response.slot);
      const pending = pendingConnections.entries().next().value;
      if (pending) {
        const [socket, timer] = pending; pendingConnections.delete(socket); clearTimeout(timer);
        if (!closing && socket.readyState === socket.OPEN) { admit(socket); socket.resume(); }
      }
      return;
    }
    const session = sessions.get(response.slot);
    if (!session) return;
    try {
      if (response.type === "joined" && session.state === "joining") {
        session.transport.send("reliableControl", encodeMessage({ type: "welcome", slot: response.slot, serverTick: response.serverTick, tickRate: 60, matchSeed, map: options.match.map, rules }));
        session.state = "active";
      } else if (response.type === "send" && session.state === "active") {
        const start = performance.now();
        const packet = encodeMessage(response.message);
        const encodingMs = performance.now() - start;
        wireEncodeMs.push(encodingMs);
        wireByTick.set(response.serverTick, (wireByTick.get(response.serverTick) ?? 0) + encodingMs);
        session.transport.send(response.message.type === "state" ? "latestState" : "reliableControl", packet);
        if (response.message.type === "state") stateReady(response.slot, session);
        if (response.message.type === "events") for (const event of response.message.events) options.onReliableEvent?.(response.slot, event);
      } else if (response.type === "reject") disconnect(response.slot, 1008, response.reason);
    } catch (error) { report(error instanceof Error ? error : new Error(String(error))); disconnect(response.slot, 1011, "Server packet failure"); }
  };
  const admit = (socket: WebSocket) => {
    if (closing || occupiedSlots.size >= (options.match.targetPlayers ?? 32)) { socket.close(1013, "Match unavailable or full"); return; }
    let slot = 1;
    while (occupiedSlots.has(slot)) slot++;
    occupiedSlots.add(slot);
    const transport = createNodeTransport(socket, limits.outboundQueueBytes);
    const now = process.hrtime.bigint();
    const session: Session = { transport, state: "hello", timer: setTimeout(() => { disconnect(slot, 1008, "Admission timed out"); socket.terminate(); }, 5000), inputTokens: INPUT_PACKET_BURST, lastInput: now, weaponTokens: WEAPON_CHOICE_BURST, lastWeaponChoice: now,
      control: new TokenBucket(limits.controlBurst, limits.controlPerSecond), lastPing: -Infinity, pendingResync: false, admitted: () => permits.get(socket)?.joined() };
    sessions.set(slot, session);
    transport.onClose = (code, reason) => disconnect(slot, code, reason || "Connection closed");
    transport.onError = error => { report(error); disconnect(slot, 1002, "Transport error"); };
    transport.onMessage = (channel, packet) => {
      try {
        if (channel !== "reliableControl") throw new ProtocolError("CHANNEL", "Clients may only send reliable control messages");
        const message = decodeMessage(packet);
        if (message.type !== "input" && !session.control.take()) { disconnect(slot, 1008, "Control rate limit exceeded"); return; }
        if (session.state === "hello") {
          validateHello(message, options.match.contentSetHash);
          if (message.type !== "hello") throw new ProtocolError("TYPE", "Expected hello");
          session.nickname = message.nickname;
          session.state = "joining";
          // The sim stores original 24-char printable-ASCII names; other admitted nicknames get a slot label.
          const name = /^[\x20-\x7e]{1,24}$/.test(message.nickname) ? message.nickname : `Player ${slot}`;
          controller.send({ type: "join", slot, weapon: message.weapon, secondaryWeapon: message.secondaryWeapon, name });
          session.admitted();
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
          case "weapon-choice": {
            const now = process.hrtime.bigint();
            session.weaponTokens = Math.min(WEAPON_CHOICE_BURST, session.weaponTokens + Number(now - session.lastWeaponChoice) / 1e9 * WEAPON_CHOICES_PER_SECOND);
            session.lastWeaponChoice = now;
            if (session.weaponTokens < 1) { disconnect(slot, 1008, "Weapon choice rate limit exceeded"); return; }
            session.weaponTokens--;
            controller.send({ type: "weapon-choice", slot, primary: message.primary, secondary: message.secondary, selection: message.selection });
            break;
          }
          case "eventAck": session.pendingAck = Math.max(session.pendingAck ?? 0, message.eventId); flushControl(); break;
          case "resync": session.pendingResync = true; flushControl(); break;
          case "ping":
            if (Date.now() - session.lastPing >= 250) {
              session.lastPing = Date.now();
              transport.send("reliableControl", encodeMessage({ type: "pong", timestamp: message.timestamp }));
            }
            break;
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
    function flushControl(): void {
      if (session.controlFlush) return;
      session.controlFlush = setImmediate(() => {
        delete session.controlFlush;
        if (session.state !== "active") return;
        if (session.pendingResync) { session.pendingResync = false; controller.send({ type: "resync", slot }); }
        if (session.pendingAck !== undefined) {
          const eventId = session.pendingAck; delete session.pendingAck;
          controller.send({ type: "eventAck", slot, eventId });
        }
      });
    }
  };
  sockets.on("connection", socket => {
    if (options.match.targetPlayers !== undefined && !closing && sessions.size + pendingConnections.size < options.match.targetPlayers && occupiedSlots.size >= options.match.targetPlayers) {
      const timer = setTimeout(() => { pendingConnections.delete(socket); socket.terminate(); }, 5000);
      socket.pause();
      timer.unref(); pendingConnections.set(socket, timer);
      socket.once("close", () => { clearTimeout(timer); pendingConnections.delete(socket); });
    } else admit(socket);
  });
  sockets.on("error", error => { report(error); void close(); });
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const slot of sessions.keys()) disconnect(slot, 1001, "Server shutting down");
      for (const [socket, timer] of pendingConnections) { clearTimeout(timer); socket.close(1001, "Server shutting down"); }
      pendingConnections.clear();
      server.off("error", serverError);
      server.off("upgrade", upgrade);
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
  return { httpsServer: server, close,
    get humanCount() { return sessions.size + pendingConnections.size; },
    get humans() { return [...sessions.values()].flatMap(session => session.nickname ? [session.nickname] : []); },
    get available() { return !closing; },
  };
}
