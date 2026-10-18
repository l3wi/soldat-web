import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { encodeTickRecords, validateChat, validateWeaponChoice, validateWeaponSelection, validateAppearance, validateTeam, teamCount, type GameMode, type TickRecord, type InputFrame, type ReliableEvent } from "@soldat-web/protocol";
import { loadSim, loadSimContent, requireStatus, SIM_GAMEPLAY_EVENTS } from "@soldat-web/sim-host";
import type { SimHost, SimManifest } from "@soldat-web/sim-host";
import { PlayerInputBuffer, type FireAdmission } from "./input-buffer.ts";
import type { MatchConfiguration, WorkerRequest, WorkerResponse, TickWorkProfile } from "./worker-messages.ts";
import { BOT_PROFILES, configureMatch, reservedBotSlots, WEAPON_CHOICE_BURST, WEAPON_CHOICES_PER_SECOND } from "./bots.ts";
import { hardeningLimits, TokenBucket } from "./hardening.ts";

interface Player {
  inputs: PlayerInputBuffer;
  nickname: string;
  syncTick: number | undefined;
  nextStateTick: number;
  events: Map<number, ReliableEvent>;
  lastEventAck: number;
  lastSentEvent: number;
  rttMs: number;
  lastRewind: number;
  weaponTokens: number;
  lastWeaponChoice: bigint;
  playerChanges: TokenBucket;
  chat: TokenBucket;
  lastInput: Uint8Array;
  changedAtMs: number;
  afkRejected: boolean;
  muted: boolean;
}
interface History {
  state: Uint8Array | undefined;
  inputs: Map<number, Uint8Array>;
  weapons: Map<number, number>;
}
const HISTORY_TICKS = 30;
const REWIND_TICKS = 12;
const emptyProfile = (): TickWorkProfile => ({ tick: 0, stepMs: 0, saveMs: 0, hashMs: 0, recordsMs: 0, postMs: 0, recordEncodes: 0, recipients: 0, ...(process.env.NET_G4_INPUT_DIAGNOSTICS === "1" ? { controls: [] } : {}) });

/** One worker, one instance. History and all uncommitted effects share its timeline. */
export class AuthoritativeMatch {
  private readonly players = new Map<number, Player>();
  private readonly history = new Map<number, History>();
  private readonly pendingEvents = new Map<number, Uint8Array>();
  private records: TickRecord[] = [];
  private commands: Uint8Array[] = [];
  private eventId = 0;
  private lastRewindTick = -1;
  private inputPtr: number;
  private replayMs: number[] = [];
  private replayTicks = 0;
  private rejectedShots = 0;
  private uncompensatedShots = 0;
  private replayBudgetFallbacks = 0;
  private readonly replayBudget: TokenBucket;
  private replayNow = 0;
  private readonly afkMs: number;
  private inputBufferOccupancy: number[] = [];
  private inputBufferLeadTicks: number[] = [];
  private profile = process.env.NET_G4_PROFILE === "1" ? emptyProfile() : undefined;
  private readonly host: SimHost;
  private readonly bots: number[];
  private readonly targetPlayers: number | undefined;
  private nextBotProfile = 0;
  private readonly mode: GameMode;
  private readonly mapRotation: string[];
  private readonly allowedMaps: Set<string>;
  private map: string;
  private roundEpoch = 0;
  private readonly emit: (response: WorkerResponse) => void;
  tick = 0;
  paused = false;

  get tickScale(): number {
    const view = this.host.renderView();
    if (typeof view === "number") throw new Error(`sim_render_view failed: ${view}`);
    return view.globals.tickScale;
  }

  private constructor(host: SimHost, config: MatchConfiguration & { botCount: number }, emit: (response: WorkerResponse) => void) {
    this.host = host;
    const limits = hardeningLimits(config);
    this.replayBudget = new TokenBucket(60, limits.replayTicksPerSecond, 0);
    this.afkMs = limits.afkMs;
    this.targetPlayers = config.targetPlayers;
    this.bots = reservedBotSlots(config.targetPlayers ?? config.botCount);
    this.mode = config.rules.mode as GameMode;
    this.map = config.map;
    this.mapRotation = [...(config.mapRotation ?? [config.map])];
    this.allowedMaps = new Set(config.allowedMaps ?? this.mapRotation);
    this.emit = this.profile ? response => {
      const start = performance.now(); emit(response);
      this.profile!.postMs += performance.now() - start;
    } : emit;
    this.inputPtr = requireStatus(host.exports.sim_alloc(12), "sim_alloc(input)");
    if (!this.inputPtr) throw new Error("Input allocation failed");
    for (const slot of [...this.bots]) {
      requireStatus(host.command(0, { kind: "join", slot, control: "bot", bot: BOT_PROFILES[this.nextBotProfile++ % BOT_PROFILES.length]!, team: this.joinTeam() }), "sim_command(bot join)");
    }
  }

  static async start(config: MatchConfiguration, emit: (response: WorkerResponse) => void): Promise<AuthoritativeMatch> {
    const configured = configureMatch(config);
    const seed = BigInt(config.matchSeed);
    if (seed < 0n || seed > 0xffffffffffffffffn) throw new RangeError("Match seed must be u64");
    const manifest = JSON.parse(await readFile(resolve(config.contentRoot, "sim/manifest.json"), "utf8")) as SimManifest;
    if (manifest.sha256 !== config.contentSetHash) throw new Error("Configured content hash does not match manifest");
    const host = await loadSim(new Uint8Array(await readFile(config.wasmPath)));
    try {
      await loadSimContent(host, manifest, async name => {
        const path = resolve(config.contentRoot, name);
        const rel = relative(resolve(config.contentRoot), path);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Content path escapes root");
        return new Uint8Array(await readFile(path));
      });
      requireStatus(host.init(configured.rules, Number(seed & 0xffffffffn), Number(seed >> 32n), 0), "sim_init");
      requireStatus(host.loadMap(config.map), "sim_load_map");
      return new AuthoritativeMatch(host, configured, emit);
    } catch (error) { host.dispose(); throw error; }
  }

  receive(message: WorkerRequest, now: bigint): void {
    if (message.type === "stop") return;
    if (message.type === "pause") {
      this.flushRecords(); this.commitEvents(this.tick);
      this.paused = message.paused;
      this.history.clear();
      for (const [slot, player] of this.players) {
        player.inputs.resync(this.tick); player.lastInput.fill(0);
        player.changedAtMs = performance.now(); player.afkRejected = false;
        this.apply(slot, this.tick, player.lastInput);
      }
      this.sendFullStates();
      this.emit({ type: "paused", paused: this.paused });
      return;
    }
    if (message.type === "map-control") {
      const map = message.restart ? this.map : message.next ? this.mapRotation[(this.mapRotation.indexOf(this.map) + 1) % this.mapRotation.length]! : message.map;
      if (map && this.allowedMaps.has(map)) this.advanceRound(map);
      return;
    }
    if (message.type === "join") {
      if (!Number.isInteger(message.slot) || message.slot < 1 || message.slot > 32 || this.players.has(message.slot) || (this.targetPlayers === undefined && this.bots.includes(message.slot)) || (this.targetPlayers !== undefined && this.players.size >= this.targetPlayers)) throw new Error("Invalid player slot");
      if (this.targetPlayers !== undefined && this.bots.length) {
        const bot = this.bots.includes(message.slot) ? message.slot : this.bots.at(-1)!;
        requireStatus(this.command({ kind: "leave", slot: bot, replacement: true }), "sim_command(bot replacement)");
        this.bots.splice(this.bots.indexOf(bot), 1);
      }
      requireStatus(this.command({ kind: "join", slot: message.slot, control: "authoritative", weapon: message.weapon, secondaryWeapon: message.secondaryWeapon, team: this.joinTeam(), ...(message.name ? { name: message.name } : {}), ...(message.appearance ? { appearance: message.appearance } : {}) }), "sim_command(join)");
      requireStatus(this.command({ kind: "weapon-choice", slot: message.slot, weapon: message.weapon, secondaryWeapon: message.secondaryWeapon }), "sim_command(weapon-choice)");
      this.captureCommandEvents();
      this.players.set(message.slot, { muted: false, nickname: message.nickname ?? message.name ?? `Player ${message.slot}`, chat: new TokenBucket(4, 1, Number(now) / 1e6), inputs: new PlayerInputBuffer(now), syncTick: undefined, nextStateTick: this.tick, events: new Map(), lastEventAck: this.eventId, lastSentEvent: this.eventId, rttMs: 0, lastRewind: -6, weaponTokens: WEAPON_CHOICE_BURST, lastWeaponChoice: now, playerChanges: new TokenBucket(4, 2, Number(now) / 1e6), lastInput: new Uint8Array(12), changedAtMs: performance.now(), afkRejected: false });
      // Never rewind across membership commands (their ownership is not input).
      this.history.clear();
      this.emit({ type: "joined", slot: message.slot, serverTick: this.tick, map: this.map, roundEpoch: this.roundEpoch });
      this.publishRoster();
      if (this.paused) this.sendFullStates();
      return;
    }
    const player = this.players.get(message.slot);
    if (message.type === "leave") {
      if (player) {
        requireStatus(this.command({ kind: "leave", slot: message.slot, ...(this.targetPlayers !== undefined ? { replacement: true } : {}) }), "sim_command(leave)");
        this.captureCommandEvents();
        this.players.delete(message.slot); this.history.clear();
        if (this.targetPlayers !== undefined) {
          let slot = 32;
          while (this.players.has(slot) || this.bots.includes(slot)) slot--;
          requireStatus(this.command({ kind: "join", slot, control: "bot", bot: BOT_PROFILES[this.nextBotProfile++ % BOT_PROFILES.length]!, team: this.joinTeam() }), "sim_command(bot refill)");
          this.bots.push(slot);
          this.captureCommandEvents();
        }
      }
      this.emit({ type: "left", slot: message.slot });
      this.publishRoster();
      if (this.paused) this.sendFullStates();
      return;
    }
    if (!player) return;
    switch (message.type) {
      case "server-mute": player.muted = message.muted; break;
      case "force-team":
      case "gesture":
      case "player-kill": {
        const command = message.type === "force-team" ? { kind: "team" as const, slot: message.slot, team: message.team, force: true }
          : message.type === "gesture" ? { kind: "gesture" as const, slot: message.slot, gesture: message.gesture }
          : { kind: "kill" as const, slot: message.slot };
        const status = this.command(command);
        this.captureCommandEvents(); this.history.clear(); this.publishRoster();
        if (status < 0) this.emit({ type: "send", slot: message.slot, serverTick: this.tick, message: { type: "notice", text: "The native action is unavailable in your current state." } });
        if (this.paused) this.sendFullStates();
        break;
      }
      case "radio": {
        if (player.muted) break;
        const view = this.host.renderView();
        if (typeof view === "number") throw new Error(`sim_render_view failed: ${view}`);
        const sender = view.sprite(message.slot - 1);
        if (!(sender.flags & 1) || sender.team === 5) {
          this.emit({ type: "send", slot: message.slot, serverTick: this.tick, message: { type: "notice", text: "Spectators cannot send team radio." } }); break;
        }
        for (const slot of this.players.keys()) {
          const recipient = view.sprite(slot - 1);
          if ((recipient.flags & 1) && recipient.team === sender.team) this.emit({ type: "send", slot, serverTick: this.tick, message: { type: "radio-message", slot: message.slot, nickname: player.nickname, category: message.category, direction: message.direction } });
        }
        break;
      }
      case "team-change":
      case "appearance": {
        try {
          if (message.type === "team-change") validateTeam(message.team, this.mode);
          else validateAppearance(message.appearance);
        } catch { this.emit({ type: "reject", slot: message.slot, reason: "Invalid player change" }); break; }
        if (!player.playerChanges.take(1, Number(now) / 1e6)) {
          if (message.type === "team-change") this.emit({ type: "send", slot: message.slot, serverTick: this.tick, message: { type: "notice", text: "Please wait before changing teams again." } });
          else this.emit({ type: "reject", slot: message.slot, reason: "Player change rate limit exceeded" });
          break;
        }
        const status = this.command(message.type === "team-change"
          ? { kind: "team", slot: message.slot, team: message.team }
          : { kind: "appearance", slot: message.slot, appearance: message.appearance });
        this.captureCommandEvents(); this.history.clear();
        if (status === -4 && message.type === "team-change") this.emit({ type: "send", slot: message.slot, serverTick: this.tick, message: { type: "notice", text: "Team is full: choose a smaller team while team balancing is enabled." } });
        else if (status < 0) this.emit({ type: "reject", slot: message.slot, reason: "Player change rejected by simulation" });
        this.publishRoster();
        if (this.paused) this.sendFullStates();
        break;
      }
      case "chat": {
        if (player.muted) break;
        try { validateChat(message.channel, message.text); }
        catch { this.emit({ type: "reject", slot: message.slot, reason: "Invalid chat" }); break; }
        if (!player.chat.take(1, Number(now) / 1e6)) { this.emit({ type: "reject", slot: message.slot, reason: "Chat rate limit exceeded" }); break; }
        const render = this.host.renderView();
        if (typeof render === "number") throw new Error(`sim_render_view failed: ${render}`);
        const sender = render.sprite(message.slot - 1);
        if (!(sender.flags & 1)) break;
        const delivery = { type: "chat-message", channel: message.channel, slot: message.slot, nickname: player.nickname, text: message.text } as const;
        for (const slot of this.players.keys()) {
          const recipient = render.sprite(slot - 1);
          // Original IsInSameTeam compares exact teams, including solo team 0 and spectators 5.
          if ((recipient.flags & 1) && (message.channel === "public" || recipient.team === sender.team))
            this.emit({ type: "send", slot, serverTick: this.tick, message: delivery });
        }
        break;
      }
      case "input": {
        if (this.paused) break;
        this.replayNow = Number(now) / 1e6;
        const rejected = player.inputs.offer(message.frames, this.tick, now, frame => this.admitFire(message.slot, player, frame));
        if (rejected.includes("rate")) this.emit({ type: "reject", slot: message.slot, reason: "Input rate limit exceeded" });
        break;
      }
      case "weapon-choice": {
        try { validateWeaponChoice(message.primary, message.secondary); validateWeaponSelection(message.selection); }
        catch { this.emit({ type: "reject", slot: message.slot, reason: "Invalid weapon choice" }); break; }
        player.weaponTokens = Math.min(WEAPON_CHOICE_BURST, player.weaponTokens + Number(now - player.lastWeaponChoice) / 1e9 * WEAPON_CHOICES_PER_SECOND);
        player.lastWeaponChoice = now;
        if (player.weaponTokens < 1) { this.emit({ type: "reject", slot: message.slot, reason: "Weapon choice rate limit exceeded" }); break; }
        player.weaponTokens--;
        const choice = { slot: message.slot, weapon: message.primary, secondaryWeapon: message.secondary };
        // Always retain the next-respawn choice even when original limbo rules
        // do not permit changing the currently equipped weapons.
        const saved = this.command({ kind: "weapon-choice", ...choice });
        const applied = saved < 0 ? saved : this.command({ kind: "weapon-apply", ...choice, selection: message.selection });
        this.captureCommandEvents();
        this.history.clear();
        if (saved < 0 || (applied < 0 && applied !== -4)) this.emit({ type: "reject", slot: message.slot, reason: "Weapon choice rejected by simulation" });
        break;
      }
      case "rtt": {
        if (!Number.isFinite(message.milliseconds)) break;
        const sample = Math.max(0, Math.min(1000, message.milliseconds));
        const clamped = Math.max(player.rttMs - 50, Math.min(player.rttMs + 50, sample));
        player.rttMs += (clamped - player.rttMs) * 0.25;
        break;
      }
      case "eventAck":
        if (message.eventId <= player.lastEventAck) break;
        if (!player.events.has(message.eventId)) { this.emit({ type: "reject", slot: message.slot, reason: "Unknown event acknowledgement" }); break; }
        player.lastEventAck = message.eventId;
        for (const id of player.events.keys()) if (id <= message.eventId) player.events.delete(id);
        break;
      case "resync":
        if (player.syncTick === undefined) break;
        player.inputs.resync(this.tick);
        // Queue one state even inside the rate window: dropping the request
        // would strand a client that correctly keeps only one resync in flight.
        player.syncTick = undefined;
        break;
    }
  }

  private joinTeam(): number {
    const count = teamCount(this.mode);
    if (!count) return 0;
    const render = this.host.renderView();
    if (typeof render === "number") throw new Error(`sim_render_view failed: ${render}`);
    const populations = new Uint8Array(count + 1);
    for (let index = 0; index < 32; index++) {
      const sprite = render.sprite(index);
      if ((sprite.flags & 1) && sprite.team >= 1 && sprite.team <= count) populations[sprite.team]!++;
    }
    let team = 1;
    for (let candidate = 2; candidate <= count; candidate++) if (populations[candidate]! < populations[team]!) team = candidate;
    return team;
  }

  private command(command: Parameters<SimHost["command"]>[1]): number {
    const bytes = new TextEncoder().encode(JSON.stringify(command));
    this.commands.push(bytes);
    return this.host.command(this.tick, command);
  }

  private save(): Uint8Array {
    const start = this.profile ? performance.now() : 0;
    const state = this.host.saveState();
    if (this.profile) this.profile.saveMs += performance.now() - start;
    if (typeof state === "number") throw new Error(`sim_save_state failed: ${state}`);
    return state;
  }
  private apply(slot: number, tick: number, input: Uint8Array): void {
    new Uint8Array(this.host.exports.memory.buffer, this.inputPtr, 12).set(input);
    requireStatus(this.host.exports.sim_set_input(slot, tick, this.inputPtr), "sim_set_input");
  }
  private events(): Uint8Array {
    const bytes = this.host.events();
    if (typeof bytes === "number") throw new Error(`sim_events failed: ${bytes}`);
    return bytes;
  }
  private captureCommandEvents(): void {
    const bytes = this.events();
    if (!bytes.length) return;
    const previous = this.pendingEvents.get(this.tick);
    if (!previous) { this.pendingEvents.set(this.tick, bytes); return; }
    const combined = new Uint8Array(previous.length + bytes.length);
    combined.set(previous); combined.set(bytes, previous.length);
    this.pendingEvents.set(this.tick, combined);
  }

  step(nowMs = performance.now()): void {
    if (this.paused) return;
    if (this.tick === 0xffffffff) throw new Error("Network tick space exhausted; restart match");
    const phase = this.host.renderView();
    if (typeof phase === "number") throw new Error(`sim_render_view failed: ${phase}`);
    if (phase.globals.roundPhase === 2) this.advanceRound();
    if (!this.players.size) {
      this.tick = requireStatus(this.host.step(), "sim_step"); this.events();
      this.commands = []; this.records = [];
      return;
    }
    const inputs = new Map<number, Uint8Array>(), weapons = new Map<number, number>();
    const render = this.host.renderView();
    if (typeof render === "number") throw new Error(`sim_render_view failed: ${render}`);
    for (const [slot, player] of this.players) {
      this.inputBufferOccupancy.push(player.inputs.size);
      this.inputBufferLeadTicks.push(player.inputs.leadTicks(this.tick));
      const consumed = player.inputs.consume(this.tick), input = consumed.input.slice();
      let changed = false;
      for (let index = 0; index < input.length; index++) if (input[index] !== player.lastInput[index]) { changed = true; break; }
      if (changed) {
        player.lastInput.set(input); player.changedAtMs = nowMs;
      } else if (!player.afkRejected && nowMs - player.changedAtMs >= this.afkMs) {
        player.afkRejected = true;
        this.emit({ type: "reject", slot, reason: "AFK: consumed input unchanged for too long" });
      }
      this.profile?.controls?.push({ slot, seq: consumed.seq, repeated: consumed.repeated, bits: new DataView(input.buffer, input.byteOffset, 12).getUint16(0, true), rejected: { ...player.inputs.rejected } });
      inputs.set(slot, input); weapons.set(slot, render.sprite(slot - 1).weapon);
    }
    const anchor = this.tick % 4 === 0 || ![...this.history.values()].some(entry => entry.state);
    this.history.set(this.tick, { state: anchor ? this.save() : undefined, inputs, weapons });
    while (this.history.size > HISTORY_TICKS + 1) this.history.delete(this.history.keys().next().value!);
    for (const [slot, input] of inputs) this.apply(slot, this.tick, input);
    this.records.push({ type: "step", tick: this.tick, commands: this.commands, inputs: [...inputs].sort((a, b) => a[0] - b[0]).map(([slot, input]) => ({ slot, input })) });
    this.commands = [];
    const stepStart = this.profile ? performance.now() : 0;
    const advanced = requireStatus(this.host.step(), "sim_step");
    if (this.profile) this.profile.stepMs += performance.now() - stepStart;
    if (advanced !== this.tick + 1) throw new Error(`Unexpected sim tick ${advanced}`);
    this.tick = advanced;
    this.pendingEvents.set(this.tick, this.events());
    this.commitEvents();
    if (this.tick % 30 === 0) this.records.push({ type: "hash", tick: this.tick, hash: this.hash() });
    const syncing = [...this.players].filter(([, player]) => player.syncTick === undefined && this.tick >= player.nextStateTick);
    if (this.tick % 2 === 0 || syncing.length) this.flushRecords();
    if (syncing.length) {
      const bytes = this.save(), hash = this.hash();
      for (const [slot, player] of syncing) {
        player.syncTick = this.tick; player.nextStateTick = this.tick + 30;
        this.emit({ type: "send", slot, serverTick: this.tick, message: { type: "state", tick: this.tick, hash, lastConsumedInputSeq: player.inputs.lastConsumedSequence, bytes } });
      }
    }
    if (this.tick % 30 === 0) this.retransmitEvents();
  }

  private advanceRound(map = this.mapRotation[(this.mapRotation.indexOf(this.map) + 1) % this.mapRotation.length]!): void {
    this.flushRecords();
    this.commitEvents(this.tick);
    this.map = map;
    requireStatus(this.host.loadMap(this.map), "sim_load_map(next round)");
    const view = this.host.renderView();
    if (typeof view === "number") throw new Error(`sim_render_view failed: ${view}`);
    this.roundEpoch = view.globals.roundEpoch;
    this.history.clear(); this.records = []; this.commands = []; this.pendingEvents.clear();
    this.events();
    this.emit({ type: "round", serverTick: this.tick, map: this.map, roundEpoch: this.roundEpoch });
    const bytes = this.save(), hash = this.hash();
    for (const [slot, player] of this.players) {
      player.inputs.resync(this.tick);
      player.events.clear(); player.lastEventAck = this.eventId; player.lastSentEvent = this.eventId;
      player.syncTick = this.tick; player.nextStateTick = this.tick + 30;
      player.lastInput.fill(0); player.changedAtMs = performance.now(); player.afkRejected = false;
      this.emit({ type: "send", slot, serverTick: this.tick, message: { type: "state", tick: this.tick, hash, lastConsumedInputSeq: player.inputs.lastConsumedSequence, bytes } });
    }
    this.publishRoster();
  }

  private publishRoster(): void {
    const view = this.host.renderView();
    if (typeof view === "number") throw new Error(`sim_render_view failed: ${view}`);
    this.emit({ type: "roster", players: [...this.players.keys()].map(slot => ({ slot, team: view.sprite(slot - 1).team })) });
  }

  private sendFullStates(): void {
    this.flushRecords();
    this.commitEvents(this.tick);
    // Paused commands must not replay when the same-tick fullstate already includes them.
    this.commands = []; this.records = [];
    const bytes = this.save(), hash = this.hash();
    for (const [slot, player] of this.players) {
      player.inputs.resync(this.tick); player.syncTick = this.tick; player.nextStateTick = this.tick + 30;
      this.emit({ type: "send", slot, serverTick: this.tick, message: { type: "state", tick: this.tick, hash, lastConsumedInputSeq: player.inputs.lastConsumedSequence, bytes } });
    }
  }

  private admitFire(slot: number, player: Player, frame: InputFrame): FireAdmission {
    const allowance = Math.min(REWIND_TICKS, Math.ceil(player.rttMs * 0.03) + 2);
    const viewAllowance = Math.min(18, Math.ceil(player.rttMs * 0.06) + 8);
    const late = frame.tick < this.tick;
    if (this.tick - frame.tick > allowance || frame.tick - frame.viewTick > viewAllowance || (late && !this.history.has(frame.tick))) {
      this.uncompensatedShots++;
      return "present";
    }
    if (late) {
      let anchorTick = frame.tick;
      while (anchorTick >= this.tick - HISTORY_TICKS && !this.history.get(anchorTick)?.state) anchorTick--;
      if (!this.history.get(anchorTick)?.state) { this.uncompensatedShots++; return "present"; }
    }
    if (!late) return "present";
    const result = this.rewindFire(slot, player, frame);
    return result === "budget" ? "present" : result ? "rewound" : "reject";
  }

  /** Insert intent only; original historical guns derive muzzle, cooldown, ammo and hits. */
  private rewindFire(slot: number, player: Player, frame: InputFrame): boolean | "budget" {
    const age = this.tick - frame.tick;
    const bits = new DataView(frame.input.buffer, frame.input.byteOffset, 12).getUint16(0, true);
    const entry = this.history.get(frame.tick);
    const previous = entry?.inputs.get(slot);
    const allowance = Math.min(REWIND_TICKS, Math.ceil(player.rttMs * 0.03) + 2);
    const weapon = entry?.weapons.get(slot);
    const grenade = (bits & 64) !== 0;
    if (age < 1 || age > allowance || !entry || !previous || !(bits & 80) || (bits & 0xfc0) !== (grenade ? 64 : 0) || ((bits & 16) !== 0 && (weapon === 11 || weapon === 12 || weapon === 255)) || this.lastRewindTick === this.tick || this.tick - player.lastRewind < 6) {
      this.rejectedShots++; return false;
    }
    if (new DataView(previous.buffer, previous.byteOffset, 12).getUint16(0, true) & 80) { this.rejectedShots++; return false; }
    // View is bounded independently of shot tick: interpolation is 2..6 ticks,
    // plus outbound prediction lead. No client-provided RTT increases allowance.
    if (frame.viewTick > this.tick + 2 || frame.tick - frame.viewTick > Math.min(18, Math.ceil(player.rttMs * 0.06) + 8)) { this.rejectedShots++; return false; }
    let restoreTick = frame.tick;
    while (restoreTick >= this.tick - HISTORY_TICKS && !this.history.get(restoreTick)?.state) restoreTick--;
    const anchor = this.history.get(restoreTick)?.state;
    if (!anchor) { this.uncompensatedShots++; return false; }
    if (!this.replayBudget.take(this.tick - restoreTick, this.replayNow)) {
      this.uncompensatedShots++; this.replayBudgetFallbacks++; return "budget";
    }
    const start = performance.now();
    const corrected = previous.slice();
    const view = new DataView(corrected.buffer);
    view.setUint16(0, view.getUint16(0, true) | (bits & 80), true);
    corrected.set(frame.input.subarray(2, 8), 2);
    entry.inputs.set(slot, corrected);
    requireStatus(this.host.loadState(anchor), "sim_load_state(rewind)");
    for (let tick = restoreTick; tick < this.tick; tick++) {
      const historical = this.history.get(tick);
      if (!historical) throw new Error("Incomplete rewind history");
      // Only the insertion boundary needs a fresh saved anchor. Later states
      // are invalidated, not serialized/hash-copied on every replayed tick.
      // A subsequent overlapping shot replays from the nearest valid anchor.
      if (tick === frame.tick && !historical.state) historical.state = this.save();
      else if (tick > frame.tick) historical.state = undefined;
      const render = this.host.renderView();
      if (typeof render === "number") throw new Error(`sim_render_view failed: ${render}`);
      for (const owner of historical.inputs.keys()) historical.weapons.set(owner, render.sprite(owner - 1).weapon);
      for (const [owner, input] of historical.inputs) this.apply(owner, tick, input);
      const stepStart = this.profile ? performance.now() : 0;
      requireStatus(this.host.step(1), "sim_step(rewind)");
      if (this.profile) this.profile.stepMs += performance.now() - stepStart;
      if (tick + 1 > this.tick - REWIND_TICKS) this.pendingEvents.set(tick + 1, this.events());
      else this.events(); // Already committed prefix: drain, never confirm twice.
    }
    this.lastRewindTick = this.tick; player.lastRewind = this.tick;
    this.replayTicks += this.tick - restoreTick; this.replayMs.push(performance.now() - start);
    this.records.push({ type: "correct", tick: frame.tick, slot, input: corrected });
    this.records.push({ type: "hash", tick: this.tick, hash: this.hash() });
    for (const recipient of this.players.values()) if (recipient.syncTick !== undefined && recipient.syncTick > frame.tick) {
      recipient.syncTick = undefined; recipient.nextStateTick = this.tick;
    }
    return true;
  }

  private hash(): bigint {
    const start = this.profile ? performance.now() : 0;
    const hash = BigInt.asUintN(64, this.host.exports.sim_hash_state());
    if (this.profile) this.profile.hashMs += performance.now() - start;
    return hash;
  }

  private flushRecords(): void {
    if (!this.records.length) return;
    const recipients = [...this.players].filter(([, player]) => player.syncTick !== undefined).map(([slot, player]) => ({ slot, lastConsumedInputSeq: player.inputs.lastConsumedSequence }));
    if (recipients.length) {
      const start = this.profile ? performance.now() : 0;
      const records = encodeTickRecords(this.records);
      if (this.profile) { this.profile.recordsMs += performance.now() - start; this.profile.recordEncodes++; this.profile.recipients += recipients.length; }
      this.emit({ type: "ticks", serverTick: this.tick, records, recipients });
    }
    this.records = [];
  }

  private commitEvents(throughTick = this.tick - REWIND_TICKS): void {
    for (const [tick, bytes] of this.pendingEvents) {
      if (tick > throughTick) continue;
      this.pendingEvents.delete(tick);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let batch: ReliableEvent[] = [];
      const flush = () => {
        if (!batch.length) return;
        for (const [slot, player] of this.players) {
          if (player.events.size + batch.length > 1024) { this.emit({ type: "reject", slot, reason: "Unacknowledged event backlog exceeded; reconnect required" }); continue; }
          for (const event of batch) player.events.set(event.id, event);
          player.lastSentEvent = batch[batch.length - 1]!.id;
          this.emit({ type: "send", slot, serverTick: this.tick, message: { type: "events", events: batch } });
        }
        batch = [];
      };
      for (let offset = 0; offset < bytes.length;) {
        if (bytes.length - offset < 20) throw new Error("Truncated sim event");
        const kind = view.getUint32(offset, true), length = view.getUint32(offset + 16, true);
        if (length > 65535 || length > bytes.length - offset - 20) throw new Error("Invalid sim event payload");
        if (kind >= SIM_GAMEPLAY_EVENTS.DEATH && kind <= SIM_GAMEPLAY_EVENTS.MATCH_END) {
          if (this.eventId === 0xffffffff) throw new Error("Event ID space exhausted");
          batch.push({ id: ++this.eventId, tick: view.getUint32(offset + 4, true), header: bytes.slice(offset, offset + 20), payload: bytes.slice(offset + 20, offset + 20 + length) });
          if (batch.length === 15) flush();
        }
        offset += 20 + length;
      }
      flush();
    }
  }
  private retransmitEvents(): void {
    for (const [slot, player] of this.players) {
      const events = [...player.events.values()].slice(0, 15);
      if (events.length) this.emit({ type: "send", slot, serverTick: this.tick, message: { type: "events", events } });
    }
  }
  takeWorkProfile(): TickWorkProfile | undefined {
    const profile = this.profile;
    if (profile) { profile.tick = this.tick; this.profile = emptyProfile(); }
    return profile;
  }
  takeLagMetrics(): { replayMs: number[]; replayTicks: number; rejectedShots: number; uncompensatedShots: number; replayBudgetFallbacks: number; inputBufferOccupancy: number[]; inputBufferLeadTicks: number[] } {
    const result = { replayMs: this.replayMs, replayTicks: this.replayTicks, rejectedShots: this.rejectedShots, uncompensatedShots: this.uncompensatedShots, replayBudgetFallbacks: this.replayBudgetFallbacks, inputBufferOccupancy: this.inputBufferOccupancy, inputBufferLeadTicks: this.inputBufferLeadTicks };
    this.replayMs = []; this.replayTicks = 0; this.rejectedShots = 0; this.uncompensatedShots = 0; this.replayBudgetFallbacks = 0;
    this.inputBufferOccupancy = []; this.inputBufferLeadTicks = [];
    return result;
  }
  dispose(): void {
    this.players.clear(); this.history.clear(); this.pendingEvents.clear();
    this.host.exports.sim_free(this.inputPtr); this.host.dispose();
  }
}
