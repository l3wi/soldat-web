import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";
import type { Server as HttpsServer, ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Socket } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { decodeMessage, encodeMessage, encodeLobbyStateShared, encodeLobbyStateMessage, MAX_CLIENT_PACKET_BYTES, isGameMode, normalizeMatchRules, ProtocolError } from "@soldat-web/protocol";
import type { GameMode, MatchRules, LobbyState, LobbyPlayer, Message, Region } from "@soldat-web/protocol";
import { createGameServer } from "./server.ts";
import type { GameServer, GameServerOptions } from "./server.ts";
import type { MatchConfiguration } from "./worker-messages.ts";
import { BucketTable, TokenBucket, ConnectionAdmission, hardeningLimits, sourceIp, type HardeningOptions } from "./hardening.ts";
import { BanStore } from "./bans.ts";
import { validateOperatorToken } from "./authority.ts";
import { validateVoiceConfiguration, type VoiceOperatorConfiguration } from "./voice.ts";

export interface PlatformOptions extends HardeningOptions {
  match: MatchConfiguration;
  tls: ServerOptions;
  operatorToken?: string;
  banFile?: string;
  voice?: VoiceOperatorConfiguration;
  host?: string;
  port?: number;
  /** Explicit public HTTPS origin, required behind a reverse proxy. Never trust Host. */
  publicUrl?: string;
  regions?: Region[];
  maps: { name: string; mode: GameMode; modes?: GameMode[]; botCapable: boolean }[];
  targetPlayers?: number;
  maxMatches?: number;
  maxLobbies?: number;
  idleMs?: number;
  reservationMs?: number;
  allowedOrigins?: string[];
  onError?: (error: Error) => void;
  onMetrics?: (info: { id: string; map: string; mode: string; targetPlayers: number; humans: number }, metrics: Parameters<NonNullable<GameServerOptions["onMetrics"]>>[0]) => void;
}
interface MatchEntry {
  id: string; game: GameServer; mode: GameMode; map: string; target: number; public: boolean;
  owner?: string; idleSince: number; leases: Map<string, { nickname: string; expires: number; address: string; host: boolean }>;
}
interface Lobby {
  code: string; hostToken: string; state: LobbyState; peers: Map<string, WebSocket>;
  owner: string; created: number; pending: number; addresses: Map<string, string>; blocked: Map<string, number>;
  broadcastTimer?: NodeJS.Timeout; lastBroadcast: number;
  idleSince: number; starting: boolean; match?: MatchEntry; tickets: Map<string, string>;
}
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function validateNickname(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value !== value.trim() || /[\p{Cc}\p{Cf}]/u.test(value) || Buffer.byteLength(value) > 48 || !value.isWellFormed()) throw new HttpError(400, "Invalid nickname");
}
function objectBody(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected JSON object");
}
function keys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, "Unknown request field");
}
async function body(request: IncomingMessage, maxBytes = 1024): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "Expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON"); }
  objectBody(parsed); return parsed;
}

/** HTTPS control plane. Every registered match owns a separate existing worker/WASM. */
export async function createPlatformServer(options: PlatformOptions): Promise<{ httpsServer: HttpsServer; close(): Promise<void> }> {
  const target = options.targetPlayers ?? 12, maxMatches = options.maxMatches ?? 8, maxLobbies = options.maxLobbies ?? 128;
  const idleMs = options.idleMs ?? 60_000, reservationMs = options.reservationMs ?? 30_000;
  const serverRules = normalizeMatchRules(options.match.rules);
  validateOperatorToken(options.operatorToken);
  if (options.voice !== undefined) validateVoiceConfiguration(options.voice);
  const bans = await BanStore.load(options.banFile);
  const limits = hardeningLimits(options), admission = new ConnectionAdmission(limits);
  const reservedPublicMatches = Math.max(1, Math.ceil(maxMatches / 4));
  for (const [name, value, max] of [["targetPlayers", target, 32], ["maxMatches", maxMatches, 64], ["maxLobbies", maxLobbies, 4096]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  }
  if (!Number.isFinite(idleMs) || !Number.isFinite(reservationMs) || idleMs < 1 || reservationMs < 1) throw new Error("Invalid lifecycle timeout");
  if (options.allowedOrigins !== undefined) {
    if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length > 32) throw new Error("Invalid allowedOrigins configuration");
    for (const value of options.allowedOrigins) {
      if (typeof value !== "string") throw new Error("Invalid allowed origin");
      const url = new URL(value);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || value !== url.origin) throw new Error("Allowed origins must be exact HTTP(S) origins");
    }
  }
  if (options.regions !== undefined) {
    if (!Array.isArray(options.regions) || options.regions.length < 1 || options.regions.length > 32) throw new Error("Invalid regions configuration");
    const ids = new Set<string>();
    for (const region of options.regions) {
      if (!region || typeof region.id !== "string" || !/^[a-z0-9-]{1,32}$/.test(region.id) || ids.has(region.id) || typeof region.name !== "string" || !region.name.trim() || region.name.length > 64 || typeof region.url !== "string") throw new Error("Invalid region");
      const url = new URL(region.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Region URL must be an HTTPS origin");
      ids.add(region.id);
    }
  }
  if (!options.maps.length || !options.maps.some(map => map.mode === "dm" && map.botCapable)) throw new Error("A bot-capable DM map is required");
  const matches = new Map<string, MatchEntry>(), lobbies = new Map<string, Lobby>();
  const buckets = new BucketTable(4096, 8, 0.1);
  const failedLookups = new BucketTable(4096, limits.failedLookupsPerMinute, limits.failedLookupsPerMinute / 60);
  const globalFailures = new TokenBucket(limits.globalFailedLookupsPerSecond, limits.globalFailedLookupsPerSecond);
  const globalCreations = new TokenBucket(limits.globalCreationsPerSecond, limits.globalCreationsPerSecond);
  let closing = false, rotation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation); queue = next.catch(() => {}); return next;
  };
  const report = options.onError ?? console.error;
  const server = createServer({ ...options.tls, handshakeTimeout: 5000 }, (request, response) => { void handle(request, response); });
  const connections = new Map<string, number>();
  server.on("connection", socket => {
    if (!(socket instanceof Socket)) { socket.destroy(); return; }
    const address = sourceIp(socket.remoteAddress), count = connections.get(address) ?? 0;
    if (count >= limits.maxConnectionsPerIp) { socket.destroy(); return; }
    connections.set(address, count + 1);
    socket.once("close", () => {
      const next = connections.get(address)! - 1;
      if (next) connections.set(address, next); else connections.delete(address);
    });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.setMaxListeners(maxMatches + 10);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_PACKET_BYTES, perMessageDeflate: false });
  let origin = options.publicUrl ? new URL(options.publicUrl).origin : "";
  if (origin && !origin.startsWith("https://")) throw new Error("publicUrl must use HTTPS");
  const wsOrigin = () => origin.replace(/^https:/, "wss:");
  const matchUrl = (match: MatchEntry) => `${wsOrigin()}/matches/${match.id}`;
  const validSetup = (mode: unknown, map: unknown): { mode: GameMode; map: string } => {
    if (!isGameMode(mode) || typeof map !== "string" || !options.maps.some(item => item.name === map && (item.modes ?? [item.mode]).includes(mode) && item.botCapable)) throw new HttpError(400, "Select a bot-capable map for this mode");
    return { mode, map };
  };
  const validRotation = (mode: GameMode, map: string, value?: unknown): string[] => {
    const maps = value === undefined ? [...new Set([map, ...options.maps.filter(item => item.botCapable && (item.modes ?? [item.mode]).includes(mode)).map(item => item.name)])].slice(0, 32) : value;
    if (!Array.isArray(maps) || maps.length < 1 || maps.length > 32 || new Set(maps).size !== maps.length || !maps.includes(map)) throw new HttpError(400, "Invalid map rotation");
    for (const name of maps) validSetup(mode, name);
    return [...maps] as string[];
  };
  const lobbyRules = (value: unknown, mode: GameMode): MatchRules => {
    const rules = normalizeMatchRules(value);
    if (rules.mode !== mode) throw new HttpError(400, "Lobby mode/rules mismatch");
    return { ...rules, world: "original", ai: true, ...(serverRules.rng === undefined ? {} : { rng: serverRules.rng }) };
  };
  const expireLeases = (match: MatchEntry, now: number) => {
    for (const [token, lease] of match.leases) if (lease.expires <= now) match.leases.delete(token);
  };
  const load = (match: MatchEntry) => match.game.humanCount + match.leases.size;
  const reserve = (match: MatchEntry, nickname: string, address: string, host = false): string => {
    expireLeases(match, Date.now());
    if (bans.contains(address)) throw new HttpError(403, "Admission blocked");
    if (!match.game.available || load(match) >= match.target) throw new HttpError(409, "Match full");
    const token = randomBytes(24).toString("hex");
    match.leases.set(token, { nickname, expires: Date.now() + reservationMs, address, host });
    match.idleSince = Date.now();
    return `${matchUrl(match)}?ticket=${token}`;
  };
  async function newMatch(mode: GameMode, map: string, population: number, isPublic: boolean, owner?: string, rules?: MatchRules, mapRotation?: string[]): Promise<MatchEntry> {
    if (closing || matches.size >= maxMatches) throw new HttpError(503, "Match capacity reached");
    if (!isPublic) {
      if ([...matches.values()].filter(match => !match.public).length >= maxMatches - reservedPublicMatches) throw new HttpError(503, "Private match capacity reached; capacity reserved for quickplay");
      if ([...matches.values()].filter(match => !match.public && match.owner === owner).length >= limits.maxPrivateMatchesPerIp) throw new HttpError(429, "Private match quota exceeded");
    }
    const id = randomUUID();
    let entry: MatchEntry;
    const game = await createGameServer({
      match: { ...options.match, afkMs: limits.afkMs, replayTicksPerSecond: limits.replayTicksPerSecond, map, mapRotation: validRotation(mode, map, mapRotation), allowedMaps: [...new Set(options.maps.filter(item => item.botCapable && (item.modes ?? [item.mode]).includes(mode)).map(item => item.name))], rules: lobbyRules(rules ?? { ...options.match.rules, mode }, mode), targetPlayers: population },
      admission, outboundQueueBytes: limits.outboundQueueBytes, controlBurst: limits.controlBurst, controlPerSecond: limits.controlPerSecond,
      httpsServer: server, path: `/matches/${id}`, ...(options.onError ? { onError: options.onError } : {}),
      bans, ...(options.operatorToken ? { operatorToken: options.operatorToken } : {}), ...(options.voice ? { voice: options.voice } : {}),
      ...(options.onMetrics ? { onMetrics: (metrics: Parameters<NonNullable<GameServerOptions["onMetrics"]>>[0]) => {
        if (entry) options.onMetrics!({ id, map: entry.game.map, mode, targetPlayers: population, humans: entry.game.humanCount }, metrics);
      } } : {}),
      onRound: round => {
        if (!entry) return;
        entry.map = round.map;
        for (const lobby of lobbies.values()) if (lobby.match === entry) { lobby.state.map = round.map; broadcast(lobby); }
      },
      authorize: request => {
        if (!entry || !entry.game.available || entry.game.humanCount >= entry.target) return false;
        const ticket = new URL(request.url!, origin).searchParams.get("ticket");
        if (!ticket) return false;
        const lease = entry.leases.get(ticket);
        if (!lease || lease.expires <= Date.now()) { entry.leases.delete(ticket); return false; }
        if (lease.address !== sourceIp(request.socket.remoteAddress) || bans.contains(lease.address)) return false;
        entry.leases.delete(ticket); return { host: lease.host };
      },
    });
    entry = { id, game, mode, map, target: population, public: isPublic, ...(owner ? { owner } : {}), idleSince: Date.now(), leases: new Map() };
    matches.set(id, entry); return entry;
  }
  function sendLobby(peer: WebSocket, packet: Uint8Array): void {
    if (peer.bufferedAmount > limits.lobbyBufferedBytes || packet.byteLength > limits.lobbyBufferedBytes - peer.bufferedAmount) { peer.terminate(); return; }
    if (peer.readyState === peer.OPEN) peer.send(packet, { binary: true, compress: false }, error => { if (error) peer.terminate(); });
  }
  function broadcast(lobby: Lobby): void {
    if (lobby.broadcastTimer || lobbies.get(lobby.code) !== lobby) return;
    lobby.broadcastTimer = setTimeout(() => {
      delete lobby.broadcastTimer;
      if (lobbies.get(lobby.code) !== lobby) return;
      try {
        if (lobby.match && !lobby.match.game.available) throw new Error("Match unavailable");
        if (lobby.match) lobby.state.map = lobby.match.game.map;
        lobby.lastBroadcast = Date.now();
        const shared = encodeLobbyStateShared(lobby.state);
        for (const [selfId, peer] of lobby.peers) {
          let url: string | undefined;
          if (lobby.match) {
            const player = lobby.state.players.find(item => item.id === selfId)!;
            let ticket = lobby.tickets.get(selfId);
            if (!ticket && load(lobby.match) < lobby.match.target) {
              ticket = new URL(reserve(lobby.match, player.nickname, lobby.addresses.get(selfId)!, player.host)).searchParams.get("ticket")!;
              lobby.tickets.set(selfId, ticket);
            }
            url = ticket ? `${matchUrl(lobby.match)}?ticket=${ticket}` : matchUrl(lobby.match);
          }
          sendLobby(peer, encodeLobbyStateMessage(selfId, shared, url));
        }
      } catch (error) {
        report(error instanceof Error ? error : new Error(String(error)));
        lobbies.delete(lobby.code);
        for (const peer of lobby.peers.values()) peer.terminate();
      }
    }, Math.max(0, 100 - (Date.now() - lobby.lastBroadcast)));
    lobby.broadcastTimer.unref();
  }
  function leave(lobby: Lobby, id: string): void {
    const player = lobby.state.players.find(item => item.id === id);
    lobby.peers.delete(id); lobby.state.players = lobby.state.players.filter(item => item.id !== id);
    lobby.addresses.delete(id);
    lobby.idleSince = Date.now();
    const ticket = lobby.tickets.get(id);
    if (ticket) lobby.match?.leases.delete(ticket);
    lobby.tickets.delete(id);
    if (player?.host && !lobby.state.started) {
      // The capability stays with the original host; a stranger cannot take it by joining first.
      for (const peer of lobby.peers.values()) peer.close(1001, "Host left");
      lobbies.delete(lobby.code);
    } else broadcast(lobby);
  }
  function rateLimit(address: string): void {
    if (!globalCreations.take() || !buckets.take(address)) throw new HttpError(429, "Creation rate limit exceeded");
  }
  function failedLookup(address: string): never {
    if (!globalFailures.take() || !failedLookups.take(address)) throw new HttpError(429, "Lobby lookup rate limit exceeded");
    throw new HttpError(404, "Lobby not found; codes must contain eight Crockford base32 characters");
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const requestOrigin = request.headers.origin;
    const allowed = options.allowedOrigins ?? ["http://127.0.0.1:5195", "http://localhost:5195"];
    if (requestOrigin && (requestOrigin === origin || allowed.includes(requestOrigin))) {
      response.setHeader("Access-Control-Allow-Origin", requestOrigin); response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    try {
      if (requestOrigin && requestOrigin !== origin && !allowed.includes(requestOrigin)) throw new HttpError(403, "Origin not allowed");
      const path = new URL(request.url ?? "/", "https://localhost").pathname;
      const address = sourceIp(request.socket.remoteAddress);
      if (bans.contains(address)) throw new HttpError(403, "Admission blocked");
      if (request.method === "OPTIONS" && path.startsWith("/api/")) { response.writeHead(204); response.end(); return; }
      let result: unknown;
      if (request.method === "GET" && path === "/api/ping") result = { ok: true };
      else if (request.method === "GET" && path === "/api/regions") result = options.regions ?? [{ id: "local", name: "Local", url: origin }];
      else if (request.method === "GET" && path.startsWith("/api/lobbies/")) {
        if (!globalFailures.available() || !failedLookups.available(address)) throw new HttpError(429, "Lobby lookup rate limit exceeded");
        const code = path.split("/").at(-1)!.toUpperCase();
        const lobby = /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? lobbies.get(code) : undefined;
        if (!lobby) failedLookup(address);
        const blockedUntil = lobby.blocked.get(address) ?? 0;
        if (lobby.match) lobby.state.map = lobby.match.game.map;
        if (blockedUntil > Date.now()) throw new HttpError(403, `Removed by the host; you can rejoin in ${Math.ceil((blockedUntil - Date.now()) / 60_000)} min`);
        result = { ...lobby.state, wsUrl: `${wsOrigin()}/lobbies/${lobby.code}` };
      } else if (request.method === "POST" && (path === "/api/quickplay" || path === "/api/lobbies")) {
        rateLimit(address);
        const data = await body(request, path === "/api/lobbies" ? 8192 : 1024);
        if (path === "/api/quickplay") {
          keys(data, ["nickname"]); validateNickname(data.nickname);
          result = await serial(async () => {
            for (const match of matches.values()) expireLeases(match, Date.now());
            if ([...matches.values()].filter(match => match.public).reduce((total, match) => total + [...match.leases.values()].filter(lease => lease.address === address).length, 0) >= limits.maxQuickplayReservationsPerIp) throw new HttpError(429, "Quickplay reservation quota exceeded");
            let match = [...matches.values()].filter(item => item.public && item.game.available && load(item) < item.target).sort((a, b) => load(a) - load(b))[0];
            if (!match) {
              const maps = options.maps.filter(item => item.mode === "dm" && item.botCapable);
              match = await newMatch("dm", maps[rotation++ % maps.length]!.name, target, true);
            }
            const wsUrl = reserve(match, data.nickname as string, address);
            return { matchId: match.id, wsUrl, map: match.game.map, mode: match.mode, humans: [...match.game.humans, ...[...match.leases.values()].map(lease => lease.nickname)], bots: Math.max(0, match.target - load(match)) };
          });
        } else {
          keys(data, ["mode", "map", "rules", "mapRotation"]); const setup = validSetup(data.mode, data.map);
          const rules = lobbyRules(data.rules === undefined ? { ...options.match.rules, mode: setup.mode } : data.rules, setup.mode);
          const mapRotation = validRotation(setup.mode, setup.map, data.mapRotation);
          if (lobbies.size >= maxLobbies) throw new HttpError(503, "Lobby capacity reached");
          if ([...lobbies.values()].filter(lobby => lobby.owner === address).length >= limits.maxHostedLobbiesPerIp) throw new HttpError(429, "Hosted lobby quota exceeded");
          let code: string;
          const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
          do { code = [...randomBytes(8)].map(byte => alphabet[byte & 31]).join(""); } while (lobbies.has(code));
          const hostToken = randomBytes(32).toString("hex");
          lobbies.set(code, { code, hostToken, owner: address, created: Date.now(), pending: 0, addresses: new Map(), blocked: new Map(), lastBroadcast: 0, peers: new Map(), tickets: new Map(), state: { code, ...setup, rules, mapRotation, targetPlayers: target, players: [], started: false }, idleSince: Date.now(), starting: false });
          result = { code, hostToken, wsUrl: `${wsOrigin()}/lobbies/${code}` };
        }
      } else throw new HttpError(404, "Route not found");
      response.writeHead(request.method === "POST" ? 201 : 200); response.end(JSON.stringify(result));
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof ProtocolError)) report(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(error instanceof HttpError ? error.status : error instanceof ProtocolError ? 400 : 500); response.end(JSON.stringify({ error: error instanceof HttpError || error instanceof ProtocolError ? error.message : "Server failure" }));
    }
  }
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "https://localhost").pathname;
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== origin && !(options.allowedOrigins ?? ["http://127.0.0.1:5195", "http://localhost:5195"]).includes(requestOrigin)) { socket.destroy(); return; }
    if (path.startsWith("/matches/")) {
      if (![...matches.values()].some(match => path === `/matches/${match.id}`)) socket.destroy();
      return;
    }
    const address = sourceIp(request.socket.remoteAddress);
    if (bans.contains(address)) { socket.destroy(); return; }
    if (!globalFailures.available() || !failedLookups.available(address)) { socket.destroy(); return; }
    const code = path.match(/^\/lobbies\/([0-9A-HJKMNP-TV-Z]{8})$/i)?.[1]?.toUpperCase(), lobby = code ? lobbies.get(code) : undefined;
    if (!lobby || closing || lobby.peers.size + lobby.pending >= lobby.state.targetPlayers + 2 || (lobby.blocked.get(address) ?? 0) > Date.now()) {
      try { failedLookup(address); } catch {} socket.destroy(); return;
    }
    const permit = admission.acquire(address);
    if (!permit) { try { failedLookup(address); } catch {} socket.destroy(); return; }
    lobby.pending++;
    let pending = true;
    const joined = () => { if (pending) { pending = false; lobby.pending--; permit.joined(); } };
    socket.once("close", () => { joined(); permit.release(); });
    try { sockets.handleUpgrade(request, socket, head, peer => sockets.emit("connection", peer, lobby, address, joined)); }
    catch { joined(); permit.release(); socket.destroy(); }
  };
  server.on("upgrade", upgrade);
  sockets.on("connection", (peer: WebSocket, lobby: Lobby, address: string, admitted: () => void) => {
    const id = randomBytes(12).toString("hex"); let joined = false, tokens = 12, last = Date.now(), busy = false;
    const timeout = setTimeout(() => peer.terminate(), 5000); timeout.unref();
    peer.on("error", () => peer.terminate());
    peer.on("close", () => { clearTimeout(timeout); admitted(); if (joined) leave(lobby, id); });
    peer.on("message", (bytes, binary) => { void receive(bytes as Buffer, binary); });
    async function receive(bytes: Buffer, binary: boolean): Promise<void> {
      try {
        const now = Date.now(); tokens = Math.min(12, tokens + (now - last) / 1000 * 4); last = now;
        if (!binary || tokens < 1 || busy) { peer.close(1008, "Invalid or excessive lobby traffic"); return; } tokens--;
        const message: Message = decodeMessage(bytes);
        if (!joined) {
          if (message.type !== "lobby-join") throw new Error("First message must be lobby-join");
          validateNickname(message.nickname);
          if ((lobby.blocked.get(address) ?? 0) > Date.now() || lobbies.get(lobby.code) !== lobby) throw new Error("Lobby admission blocked");
          if (lobby.peers.size >= lobby.state.targetPlayers) throw new Error("Lobby full");
          let host = false;
          if (message.hostToken !== undefined) {
            const token = Buffer.from(message.hostToken), expected = Buffer.from(lobby.hostToken);
            if (token.length !== expected.length || !timingSafeEqual(token, expected) || lobby.state.players.some(player => player.host)) throw new Error("Invalid host token");
            host = true;
          }
          if (lobby.match && load(lobby.match) >= lobby.match.target) throw new Error("Match full");
          const player: LobbyPlayer = { id, nickname: message.nickname, host, ready: host };
          joined = true; admitted(); clearTimeout(timeout); lobby.peers.set(id, peer); lobby.addresses.set(id, address); lobby.state.players.push(player); lobby.idleSince = Date.now(); broadcast(lobby); return;
        }
        const player = lobby.state.players.find(item => item.id === id)!;
        if (message.type === "lobby-leave") { peer.close(1000, "Left lobby"); return; }
        if (message.type === "lobby-ready") {
          if (lobby.state.started || lobby.starting) throw new Error("Match already starting");
          const ready = player.host || message.ready;
          if (player.ready === ready) return;
          player.ready = ready;
        } else if (message.type === "lobby-update") {
          if (!player.host) throw new Error("Only host may change setup");
          if (lobby.state.started || lobby.starting) throw new Error("Match already starting");
          const setup = validSetup(message.mode ?? message.rules?.mode ?? lobby.state.mode, message.map ?? lobby.state.map);
          const rules = lobbyRules(message.rules ?? { ...lobby.state.rules, mode: setup.mode }, setup.mode);
          const mapRotation = validRotation(setup.mode, setup.map, message.mapRotation ?? (setup.mode === lobby.state.mode && setup.map === lobby.state.map ? lobby.state.mapRotation : undefined));
          const population = message.targetPlayers ?? lobby.state.targetPlayers;
          if (population < lobby.state.players.length) throw new Error("Target smaller than roster");
          if (setup.mode === lobby.state.mode && setup.map === lobby.state.map && population === lobby.state.targetPlayers && JSON.stringify(rules) === JSON.stringify(lobby.state.rules) && JSON.stringify(mapRotation) === JSON.stringify(lobby.state.mapRotation)) return;
          Object.assign(lobby.state, setup, { rules, mapRotation, targetPlayers: population });
          for (const member of lobby.state.players) member.ready = member.host;
        } else if (message.type === "lobby-start") {
          if (!player.host) throw new Error("Only host may start");
          if (lobby.state.started || lobby.starting) throw new Error("Match already starting");
          if (lobby.state.players.some(member => !member.ready)) throw new Error("Players are not ready");
          lobby.starting = true; busy = true;
          try {
            const match = await serial(() => newMatch(lobby.state.mode, lobby.state.map, lobby.state.targetPlayers, false, lobby.owner, lobby.state.rules, lobby.state.mapRotation));
            if (lobbies.get(lobby.code) !== lobby || closing) {
              matches.delete(match.id); await match.game.close(); return;
            }
            lobby.match = match;
            lobby.state.started = true; lobby.state.matchId = lobby.match.id; lobby.state.matchWsUrl = matchUrl(lobby.match);
          } finally { lobby.starting = false; busy = false; }
        } else if (message.type === "lobby-kick") {
          if (!player.host) throw new Error("Only host may kick");
          const guest = lobby.state.players.find(member => member.id === message.id);
          if (!guest || guest.host) throw new Error("Invalid kick target");
          const guestAddress = lobby.addresses.get(guest.id)!;
          lobby.blocked.set(guestAddress, Date.now() + 600_000);
          const kicked = lobby.peers.get(guest.id)!;
          leave(lobby, guest.id); kicked.close(1008, "Kicked by host; rejoin blocked for 10 minutes");
        } else throw new Error("Message not permitted in lobby");
        broadcast(lobby);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Lobby request rejected";
        sendLobby(peer, encodeMessage({ type: "lobby-error", reason: reason.slice(0, 200) }));
        if (!joined) {
          try { failedLookup(address); } catch {}
          peer.close(1008, "Lobby admission rejected");
        }
      }
    }
  });
  const cleanup = setInterval(() => { void serial(async () => {
    const now = Date.now();
    buckets.prune(now); failedLookups.prune(now);
    for (const match of matches.values()) {
      expireLeases(match, now);
      if (load(match)) match.idleSince = now;
      else if (!match.game.available || now - match.idleSince >= idleMs) {
        matches.delete(match.id); await match.game.close();
        for (const lobby of lobbies.values()) if (lobby.match === match) { for (const peer of lobby.peers.values()) peer.close(1001, "Match expired"); lobbies.delete(lobby.code); }
      }
    }
    for (const lobby of lobbies.values()) {
      for (const [address, until] of lobby.blocked) if (until <= now) lobby.blocked.delete(address);
      if ((!lobby.state.started && now - lobby.created >= limits.lobbyExpiryMs) || (!lobby.peers.size && now - lobby.idleSince >= idleMs)) {
        clearTimeout(lobby.broadcastTimer); lobbies.delete(lobby.code);
        for (const peer of lobby.peers.values()) peer.close(1001, "Lobby expired");
      }
    }
  }).catch(report); }, Math.min(idleMs, limits.lobbyExpiryMs, 5000)); cleanup.unref();
  try {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(options.port ?? 443, options.host ?? "127.0.0.1", () => { server.off("error", listening.reject); listening.resolve(); });
    await listening.promise;
    if (!origin) { const address = server.address(); if (!address || typeof address === "string") throw new Error("TCP address unavailable"); origin = `https://127.0.0.1:${address.port}`; }
  } catch (error) { clearInterval(cleanup); sockets.close(); throw error; }
  let closePromise: Promise<void> | undefined;
  return { httpsServer: server, close() {
    return closePromise ??= (async () => {
      closing = true; clearInterval(cleanup); await queue;
      for (const lobby of lobbies.values()) clearTimeout(lobby.broadcastTimer);
      for (const peer of sockets.clients) peer.terminate();
      await Promise.all([...matches.values()].map(match => match.game.close()));
      await bans.flush();
      const socketsClosed = Promise.withResolvers<void>();
      sockets.close(() => socketsClosed.resolve()); await socketsClosed.promise;
      server.off("upgrade", upgrade);
      const serverClosed = Promise.withResolvers<void>();
      server.close(error => error ? serverClosed.reject(error) : serverClosed.resolve()); await serverClosed.promise;
    })();
  } };
}
