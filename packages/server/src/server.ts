import { Server as HttpsServer, createServer } from "node:https";
import type { ServerOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { MAX_CLIENT_PACKET_BYTES, PROTOCOL_VERSION, ProtocolError, decodeMessage, encodeMessage, encodeTicksMessage, validateWeaponChoice, validateAppearance, validateTeam } from "@soldat-web/protocol";
import type { GameMode, Message, ReliableEvent } from "@soldat-web/protocol";
import type { NodeMessageTransport } from "./transport/ws-server.ts";
import { SIM_ABI_VERSION } from "@soldat-web/sim-host";
import { MatchController } from "./match-controller.ts";
import { createNodeTransport } from "./transport/ws-server.ts";
import type { MatchConfiguration } from "./worker-messages.ts";
import type { WorkerResponse } from "./worker-messages.ts";
import { INPUT_PACKET_BURST, INPUT_PACKETS_PER_SECOND } from "./input-buffer.ts";
import { configureMatch, reservedBotSlots, WEAPON_CHOICE_BURST, WEAPON_CHOICES_PER_SECOND } from "./bots.ts";
import { ConnectionAdmission, TokenBucket, hardeningLimits, sourceIp } from "./hardening.ts";
import { randomBytes } from "node:crypto";
import { isClientFeature } from "@soldat-web/protocol";
import { MatchAuthority, validateOperatorToken, type AuthorityPlayer } from "./authority.ts";
import { BanStore } from "./bans.ts";
import { validateVoiceConfiguration, type VoiceOperatorConfiguration } from "./voice.ts";
import { MAX_METRIC_REPORT_SAMPLES, MetricHistogram, type MetricHistogramSnapshot } from "./metric-histogram.ts";
import { TransportMetrics, type TransportQueueMetrics } from "./transport-metrics.ts";
export interface GameServerOptions {
  match: MatchConfiguration;
  httpsServer?: HttpsServer;
  tls?: ServerOptions;
  host?: string;
  port?: number;
  path?: string;
  authorize?: (request: IncomingMessage) => boolean | { host: boolean };
  operatorToken?: string;
  banFile?: string;
  bans?: BanStore;
  voice?: VoiceOperatorConfiguration;
  admission?: ConnectionAdmission;
  outboundQueueBytes?: number;
  controlBurst?: number;
  controlPerSecond?: number;
  onError?: (error: Error) => void;
  onMetrics?: (metrics: Extract<WorkerResponse, { type: "metrics" }> & {
    wireEncodeMs: number[]; workerSimEncodeMs: number[]; rttMs: number[]; workerPublicationDelayMs: number[];
    transportQueue: TransportQueueMetrics;
    /** Samples current queues at log flush too, including queues still stalled. */
    sampleTransportQueue(): TransportQueueMetrics | undefined;
    serverMetricOverflow: { wireEncodeMs: number; rttMs: number; workerPublicationDelayMs: number };
    serverMetricOverflowHistograms: { wireEncodeMs: MetricHistogramSnapshot; rttMs: MetricHistogramSnapshot; workerPublicationDelayMs: MetricHistogramSnapshot };
    inboundBytes: number; outboundBytes: number; resyncRequests: number; disconnects: number;
  }) => void;
  onReliableEvent?: (slot: number, event: ReliableEvent) => void;
  onDisconnect?: (slot: number, code: number, reason: string) => void;
  onRound?: (round: { map: string; roundEpoch: number; serverTick: number }) => void;
}
export interface GameServer {
  httpsServer: HttpsServer;
  close(): Promise<void>;
  readonly humanCount: number;
  readonly humans: string[];
  readonly available: boolean;
  readonly map: string;
  readonly roundEpoch: number;
}
interface Session {
  identity: AuthorityPlayer;
  signaling: TokenBucket;
  feature: TokenBucket;
  authentication: TokenBucket;
  transport: NodeMessageTransport;
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
  chat: TokenBucket;
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
  if (message.appearance !== undefined) validateAppearance(message.appearance);
}

export async function createGameServer(options: GameServerOptions): Promise<GameServer> {
  if (Boolean(options.httpsServer) === Boolean(options.tls)) throw new Error("Supply exactly one TLS configuration or attached HTTPS server; insecure WebSockets are unsupported");
  if (options.httpsServer && !(options.httpsServer instanceof HttpsServer)) throw new Error("Attached server must be an HTTPS server");
  if (options.tls && !((options.tls.key && options.tls.cert) || options.tls.pfx)) throw new Error("TLS requires a certificate and private key (or PFX)");
  if (!/^[a-f0-9]{64}$/.test(options.match.contentSetHash)) throw new Error("Content-set hash must be lowercase SHA-256 hex");
  options = { ...options, match: configureMatch(options.match) };
  validateOperatorToken(options.operatorToken);
  if (options.voice !== undefined) validateVoiceConfiguration(options.voice);
  const bans = options.bans ?? await BanStore.load(options.banFile);
  const limits = hardeningLimits(options);
  const admission = options.admission ?? new ConnectionAdmission(limits);
  const permits = new WeakMap<WebSocket, { joined(): void; release(): void }>();
  const identities = new WeakMap<WebSocket, { address: string; host: boolean }>();
  const rules = new TextEncoder().encode(JSON.stringify(options.match.rules));
  if (rules.length > 4096) throw new Error("Rules exceed protocol limit");
  const matchSeed = BigInt(options.match.matchSeed);
  if (matchSeed < 0n || matchSeed > 0xffffffffffffffffn) throw new Error("Match seed must be u64");
  const controller = await MatchController.start(options.match);
  let currentMap = options.match.map, roundEpoch = 0;
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
  let rttMs: number[] = [];
  let workerPublicationDelayMs: number[] = [];
  let serverMetricOverflow = { wireEncodeMs: 0, rttMs: 0, workerPublicationDelayMs: 0 };
  const overflowHistograms = { wireEncodeMs: new MetricHistogram(), rttMs: new MetricHistogram(), workerPublicationDelayMs: new MetricHistogram() };
  const transportMetrics = new TransportMetrics();
  const sampleTransportQueue = (): TransportQueueMetrics | undefined => {
    if (closing) return undefined;
    for (const session of sessions.values()) session.transport.sampleQueue();
    return transportMetrics.take();
  };
  const recordSample = (name: keyof typeof serverMetricOverflow, values: number[], value: number): void => {
    if (values.length < MAX_METRIC_REPORT_SAMPLES) values.push(value);
    else {
      serverMetricOverflow[name] = Math.min(Number.MAX_SAFE_INTEGER, serverMetricOverflow[name] + 1);
      overflowHistograms[name].add(value);
    }
  };
  const wireByTick = new Map<number, number>();
  let inboundBytes = 0, outboundBytes = 0, resyncRequests = 0, disconnects = 0;
  const authority = await MatchAuthority.create({
    players: () => [...sessions.values()].filter(s => s.state === "active").map(s => s.identity),
    send: (slot, message) => {
      const session = sessions.get(slot);
      if (session?.state === "active") {
        try { session.transport.send("reliableControl", encodeMessage(message)); }
        catch (error) { (options.onError ?? console.error)(error instanceof Error ? error : new Error(String(error))); disconnect(slot, 1011, "Feature delivery failed"); }
      }
    },
    disconnect: (slot, reason) => disconnect(slot, 1008, reason),
    worker: message => controller.send(message), maps: options.match.allowedMaps ?? options.match.mapRotation ?? [options.match.map],
    mode: options.match.rules.mode as GameMode, bans,
    ...(options.operatorToken ? { operatorToken: options.operatorToken } : {}),
    ...(options.voice ? { voice: options.voice } : {}),
    onError: error => (options.onError ?? console.error)(error),
  });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (socket.destroyed) return;
    if (new URL(request.url ?? "/", "https://localhost").pathname !== (options.path ?? "/")) return;
    if (closing || sessions.size + pendingConnections.size >= (options.match.targetPlayers ?? 32) + 2) { socket.destroy(); return; }
    const address = sourceIp(request.socket.remoteAddress);
    if (authority.blocked(address)) { socket.destroy(); return; }
    const permit = admission.acquire(sourceIp(request.socket.remoteAddress));
    if (!permit) { socket.destroy(); return; }
    socket.once("close", permit.release);
    try {
      const authorization = options.authorize ? options.authorize(request) : true;
      if (!authorization) { permit.release(); socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, ws => {
        permits.set(ws, permit);
        identities.set(ws, { address, host: typeof authorization === "object" && authorization.host === true });
        sockets.emit("connection", ws, request);
      });
    } catch { permit.release(); socket.destroy(); }
  };
  server.on("upgrade", upgrade);
  const report = options.onError ?? ((error: Error) => console.error(error));
  const serverError = (error: Error) => { report(error); void close(); };
  const disconnect = (slot: number, code: number, reason: string) => {
    const session = sessions.get(slot);
    if (!session || session.state === "closed") return;
    session.state = "closed";
    disconnects++;
    clearTimeout(session.timer);
    clearInterval(session.probeTimer);
    clearImmediate(session.controlFlush);
    sessions.delete(slot);
    authority.departed(session.identity.id);
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
  controller.onMessage = (response, publicationDelayMs) => {
    recordSample("workerPublicationDelayMs", workerPublicationDelayMs, publicationDelayMs);
    if (response.type === "paused") { authority.pauseChanged(response.paused); return; }
    if (response.type === "roster") {
      for (const player of response.players) { const session = sessions.get(player.slot); if (session) session.identity.team = player.team; }
      authority.membership();
      return;
    }
    if (response.type === "metrics") {
      const firstTick = response.serverTick - (Array.isArray(response.simEncodeMs) ? response.simEncodeMs.length : 0) + 1;
      const simEncodeMs = Array.isArray(response.simEncodeMs) && response.simEncodeMs.length <= MAX_METRIC_REPORT_SAMPLES
        ? response.simEncodeMs.map((ms, index) => ms + (wireByTick.get(firstTick + index) ?? 0)) : response.simEncodeMs;
      const serverMetricOverflowHistograms = { wireEncodeMs: overflowHistograms.wireEncodeMs.take(), rttMs: overflowHistograms.rttMs.take(), workerPublicationDelayMs: overflowHistograms.workerPublicationDelayMs.take() };
      options.onMetrics?.({ ...response, workerSimEncodeMs: response.simEncodeMs, simEncodeMs, wireEncodeMs, rttMs,
        workerPublicationDelayMs, transportQueue: sampleTransportQueue() ?? transportMetrics.take(), sampleTransportQueue, serverMetricOverflow, serverMetricOverflowHistograms,
        inboundBytes, outboundBytes, resyncRequests, disconnects });
      inboundBytes = 0; outboundBytes = 0; resyncRequests = 0; disconnects = 0;
      wireEncodeMs = [];
      rttMs = [];
      workerPublicationDelayMs = [];
      serverMetricOverflow = { wireEncodeMs: 0, rttMs: 0, workerPublicationDelayMs: 0 };
      for (const tick of wireByTick.keys()) if (tick <= response.serverTick) wireByTick.delete(tick);
      return;
    }
    if (response.type === "round") {
      currentMap = response.map; roundEpoch = response.roundEpoch;
      authority.round(response.roundEpoch);
      for (const [slot, session] of sessions) {
        if (session.state !== "active") continue;
        try { session.transport.send("reliableControl", encodeMessage({ type: "welcome", slot, serverTick: response.serverTick, tickRate: 60, matchSeed, map: currentMap, rules, roundEpoch })); }
        catch (error) { report(error instanceof Error ? error : new Error(String(error))); disconnect(slot, 1011, "Round bootstrap failed"); }
      }
      options.onRound?.(response);
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
          recordSample("wireEncodeMs", wireEncodeMs, encodingMs);
          if (wireByTick.size < MAX_METRIC_REPORT_SAMPLES || wireByTick.has(response.serverTick)) wireByTick.set(response.serverTick, (wireByTick.get(response.serverTick) ?? 0) + encodingMs);
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
        if (authority.blocked(session.identity.address)) { disconnect(response.slot, 1008, "Admission blocked"); return; }
        currentMap = response.map; roundEpoch = response.roundEpoch;
        session.transport.send("reliableControl", encodeMessage({ type: "welcome", slot: response.slot, serverTick: response.serverTick, tickRate: 60, matchSeed, map: response.map, rules, roundEpoch: response.roundEpoch }));
        session.state = "active";
        session.identity.joinedAt = Date.now();
        authority.membership();
      } else if (response.type === "send" && session.state === "active") {
        const start = performance.now();
        const packet = encodeMessage(response.message);
        const encodingMs = performance.now() - start;
        recordSample("wireEncodeMs", wireEncodeMs, encodingMs);
        if (wireByTick.size < MAX_METRIC_REPORT_SAMPLES || wireByTick.has(response.serverTick)) wireByTick.set(response.serverTick, (wireByTick.get(response.serverTick) ?? 0) + encodingMs);
        session.transport.send(response.message.type === "state" ? "latestState" : "reliableControl", packet);
        if (response.message.type === "state") stateReady(response.slot, session);
        if (response.message.type === "events") for (const event of response.message.events) options.onReliableEvent?.(response.slot, event);
      } else if (response.type === "reject") disconnect(response.slot, 1008, response.reason);
    } catch (error) { report(error instanceof Error ? error : new Error(String(error))); disconnect(response.slot, 1011, "Server packet failure"); }
  };
  const admit = (socket: WebSocket) => {
    if (closing || occupiedSlots.size >= (options.match.targetPlayers ?? 32)) { socket.close(1013, "Match unavailable or full"); return; }
    const admissionIdentity = identities.get(socket);
    if (!admissionIdentity || authority.blocked(admissionIdentity.address)) { socket.close(1008, "Admission blocked"); return; }
    let slot = 1;
    while (occupiedSlots.has(slot)) slot++;
    occupiedSlots.add(slot);
    const transport = createNodeTransport(socket, limits.outboundQueueBytes, { observer: transportMetrics });
    const send = transport.send.bind(transport);
    transport.send = (channel, packet) => { outboundBytes += packet.byteLength; send(channel, packet); };
    const now = process.hrtime.bigint();
    const session: Session = { identity: { id: randomBytes(16).toString("hex"), address: admissionIdentity.address, host: admissionIdentity.host, admin: false, muted: false, slot, nickname: "", joinedAt: Date.now(), team: 5 },
      signaling: new TokenBucket(512, 128), feature: new TokenBucket(12, 4), authentication: new TokenBucket(3, 0.1),
      transport, state: "hello", timer: setTimeout(() => { disconnect(slot, 1008, "Admission timed out"); socket.terminate(); }, 5000), inputTokens: INPUT_PACKET_BURST, lastInput: now, weaponTokens: WEAPON_CHOICE_BURST, lastWeaponChoice: now,
      control: new TokenBucket(limits.controlBurst, limits.controlPerSecond), chat: new TokenBucket(4, 1), lastPing: -Infinity, pendingResync: false, admitted: () => permits.get(socket)?.joined() };
    sessions.set(slot, session);
    transport.onClose = (code, reason) => disconnect(slot, code, reason || "Connection closed");
    transport.onError = error => { report(error); disconnect(slot, 1002, "Transport error"); };
    transport.onMessage = (channel, packet) => {
      inboundBytes += packet.byteLength;
      try {
        if (channel !== "reliableControl") throw new ProtocolError("CHANNEL", "Clients may only send reliable control messages");
        const message = decodeMessage(packet);
        if (message.type === "voice-signal") {
          if (!session.signaling.take()) { transport.send("reliableControl", encodeMessage({ type: "notice", text: "Voice signaling rate exceeded; please wait." })); return; }
        } else if (isClientFeature(message)) {
          if (!session.feature.take() || (message.type === "admin-auth" && !session.authentication.take())) {
            transport.send("reliableControl", encodeMessage({ type: "notice", text: "Please wait before sending another feature command." })); return;
          }
        } else if (message.type !== "input" && !session.control.take()) { disconnect(slot, 1008, "Control rate limit exceeded"); return; }
        if (session.state === "hello") {
          validateHello(message, options.match.contentSetHash);
          if (message.type !== "hello") throw new ProtocolError("TYPE", "Expected hello");
          session.nickname = message.nickname;
          session.identity.nickname = message.nickname;
          session.state = "joining";
          // The sim stores original 24-char printable-ASCII names; other admitted nicknames get a slot label.
          const name = /^[\x20-\x7e]{1,24}$/.test(message.nickname) ? message.nickname : `Player ${slot}`;
          controller.send({ type: "join", slot, weapon: message.weapon, secondaryWeapon: message.secondaryWeapon, name, nickname: message.nickname, ...(message.appearance ? { appearance: message.appearance } : {}) });
          session.admitted();
          return;
        }
        if (session.state !== "active") throw new ProtocolError("VALUE", "Admission is not complete");
        if (isClientFeature(message)) { void authority.receive(session.identity, message).catch(error => report(error instanceof Error ? error : new Error(String(error)))); return; }
        switch (message.type) {
          case "input": {
            if (authority.paused) break;
            // Bound IPC traffic before posting into the worker's input queue.
            const now = process.hrtime.bigint();
            session.inputTokens = Math.min(INPUT_PACKET_BURST, session.inputTokens + Number(now - session.lastInput) / 1e9 * INPUT_PACKETS_PER_SECOND);
            session.lastInput = now;
            if (session.inputTokens < 1) { disconnect(slot, 1008, "Input rate limit exceeded"); return; }
            session.inputTokens--;
            controller.send({ type: "input", slot, frames: message.frames });
            break;
          }
          case "team-change": validateTeam(message.team, options.match.rules.mode as GameMode); controller.send({ type: "team-change", slot, team: message.team }); break;
          case "appearance": validateAppearance(message.appearance); controller.send({ type: "appearance", slot, appearance: message.appearance }); break;
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
          case "resync": resyncRequests++; session.pendingResync = true; flushControl(); break;
          case "ping":
            if (Date.now() - session.lastPing >= 250) {
              session.lastPing = Date.now();
              transport.send("reliableControl", encodeMessage({ type: "pong", timestamp: message.timestamp }));
            }
            break;
          case "pong": {
            if (session.probe === undefined || message.timestamp !== session.probe / 1000n) throw new ProtocolError("VALUE", "Unknown timing probe");
            const milliseconds = Number(process.hrtime.bigint() - session.probe) / 1e6;
            recordSample("rttMs", rttMs, milliseconds);
            controller.send({ type: "rtt", slot, milliseconds });
            delete session.probe;
            delete session.probeDeadline;
            break;
          }
          case "disconnect": disconnect(slot, 1000, "Client disconnected"); break;
          case "chat":
            if (session.identity.muted) { transport.send("reliableControl", encodeMessage({ type: "notice", text: "You are server-muted." })); break; }
            if (!session.chat.take()) { disconnect(slot, 1008, "Chat rate limit exceeded"); return; }
            controller.send({ type: "chat", slot, channel: message.channel, text: message.text }); break;
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
    authority.close();
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
        bans.flush(),
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
    get map() { return currentMap; },
    get roundEpoch() { return roundEpoch; },
  };
}
