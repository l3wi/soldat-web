import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { encodeDelta, type InputFrame, type ReliableEvent } from "@soldat-web/protocol";
import { loadSim, loadSimContent, requireStatus, SIM_GAMEPLAY_EVENTS } from "@soldat-web/sim-host";
import type { SimHost, SimManifest } from "@soldat-web/sim-host";
import { PlayerInputBuffer, type FireAdmission } from "./input-buffer.ts";
import type { MatchConfiguration, WorkerRequest, WorkerResponse, TickWorkProfile } from "./worker-messages.ts";

interface Player {
  inputs: PlayerInputBuffer;
  baselineId: number;
  baseline: Uint8Array | undefined;
  sent: Map<number, Uint8Array>;
  events: Map<number, ReliableEvent>;
  lastEventAck: number;
  lastSentEvent: number;
  rttMs: number;
  lastRewind: number;
}
interface History {
  state: Uint8Array | undefined;
  inputs: Map<number, Uint8Array>;
  weapons: Map<number, number>;
}
const HISTORY_TICKS = 30;
const REWIND_TICKS = 12;
const emptyProfile = (): TickWorkProfile => ({ tick: 0, stepMs: 0, saveMs: 0, hashMs: 0, deltaMs: 0, postMs: 0, deltaEncodes: 0, recipients: 0, ...(process.env.NET_G4_INPUT_DIAGNOSTICS === "1" ? { controls: [] } : {}) });

/** One worker, one instance. History and all uncommitted effects share its timeline. */
export class AuthoritativeMatch {
  private readonly players = new Map<number, Player>();
  private readonly history = new Map<number, History>();
  private readonly pendingEvents = new Map<number, Uint8Array>();
  private readonly lastInputs = new Map<number, Uint8Array>();
  private snapshotId = 0;
  private eventId = 0;
  private lastRewindTick = -1;
  private inputPtr: number;
  private replayMs: number[] = [];
  private replayTicks = 0;
  private rejectedShots = 0;
  private uncompensatedShots = 0;
  private inputBufferOccupancy: number[] = [];
  private inputBufferLeadTicks: number[] = [];
  private profile = process.env.NET_G4_PROFILE === "1" ? emptyProfile() : undefined;
  private readonly host: SimHost;
  private readonly emit: (response: WorkerResponse) => void;
  tick = 0;

  private constructor(host: SimHost, emit: (response: WorkerResponse) => void) {
    this.host = host;
    this.emit = this.profile ? response => {
      const start = performance.now(); emit(response);
      this.profile!.postMs += performance.now() - start;
    } : emit;
    this.inputPtr = requireStatus(host.exports.sim_alloc(12), "sim_alloc(input)");
    if (!this.inputPtr) throw new Error("Input allocation failed");
  }

  static async start(config: MatchConfiguration, emit: (response: WorkerResponse) => void): Promise<AuthoritativeMatch> {
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
      requireStatus(host.init(config.rules, Number(seed & 0xffffffffn), Number(seed >> 32n), 0), "sim_init");
      requireStatus(host.loadMap(config.map), "sim_load_map");
      return new AuthoritativeMatch(host, emit);
    } catch (error) { host.dispose(); throw error; }
  }

  receive(message: WorkerRequest, now: bigint): void {
    if (message.type === "stop") return;
    if (message.type === "join") {
      if (!Number.isInteger(message.slot) || message.slot < 1 || message.slot > 32 || this.players.has(message.slot)) throw new Error("Invalid player slot");
      requireStatus(this.host.command(this.tick, { kind: "join", slot: message.slot, control: "authoritative", weapon: message.weapon, secondaryWeapon: message.secondaryWeapon }), "sim_command(join)");
      requireStatus(this.host.command(this.tick, { kind: "weapon-choice", slot: message.slot, weapon: message.weapon, secondaryWeapon: message.secondaryWeapon }), "sim_command(weapon-choice)");
      this.captureCommandEvents();
      this.players.set(message.slot, { inputs: new PlayerInputBuffer(now), baselineId: 0, baseline: undefined, sent: new Map(), events: new Map(), lastEventAck: this.eventId, lastSentEvent: this.eventId, rttMs: 0, lastRewind: -6 });
      // Never rewind across membership commands (their ownership is not input).
      this.history.clear();
      this.emit({ type: "joined", slot: message.slot, serverTick: this.tick });
      return;
    }
    const player = this.players.get(message.slot);
    if (message.type === "leave") {
      if (player) {
        requireStatus(this.host.command(this.tick, { kind: "leave", slot: message.slot }), "sim_command(leave)");
        this.captureCommandEvents();
        this.players.delete(message.slot); this.lastInputs.delete(message.slot); this.history.clear();
      }
      this.emit({ type: "left", slot: message.slot });
      return;
    }
    if (!player) return;
    switch (message.type) {
      case "input": {
        const rejected = player.inputs.offer(message.frames, this.tick, now, frame => this.admitFire(message.slot, player, frame));
        if (rejected.includes("rate")) this.emit({ type: "reject", slot: message.slot, reason: "Input rate limit exceeded" });
        break;
      }
      case "rtt": player.rttMs = Math.max(0, Math.min(1000, message.milliseconds)); break;
      case "snapshotAck": {
        if (message.snapshotId <= player.baselineId) break;
        const baseline = player.sent.get(message.snapshotId);
        if (!baseline) {
          if (message.snapshotId > this.snapshotId) this.emit({ type: "reject", slot: message.slot, reason: "Unknown snapshot acknowledgement" });
          break;
        }
        const synchronized = player.baselineId === 0;
        player.baselineId = message.snapshotId; player.baseline = baseline;
        for (const id of player.sent.keys()) if (id <= message.snapshotId) player.sent.delete(id);
        if (synchronized) this.emit({ type: "baseline", slot: message.slot, snapshotId: message.snapshotId });
        break;
      }
      case "eventAck":
        if (message.eventId <= player.lastEventAck) break;
        if (!player.events.has(message.eventId)) { this.emit({ type: "reject", slot: message.slot, reason: "Unknown event acknowledgement" }); break; }
        player.lastEventAck = message.eventId;
        for (const id of player.events.keys()) if (id <= message.eventId) player.events.delete(id);
        break;
      case "resync":
        player.inputs.resync(this.tick);
        if (player.baselineId === 0 && player.sent.size !== 0) break;
        player.baselineId = 0; player.baseline = undefined; player.sent.clear();
        break;
    }
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

  step(): void {
    if (this.tick === 0xffffffff) throw new Error("Network tick space exhausted; restart match");
    if (!this.players.size) { this.tick = requireStatus(this.host.step(), "sim_step"); this.events(); return; }
    const inputs = new Map<number, Uint8Array>(), weapons = new Map<number, number>();
    const render = this.host.renderView();
    if (typeof render === "number") throw new Error(`sim_render_view failed: ${render}`);
    for (const [slot, player] of this.players) {
      this.inputBufferOccupancy.push(player.inputs.size);
      this.inputBufferLeadTicks.push(player.inputs.leadTicks(this.tick));
      const consumed = player.inputs.consume(this.tick), input = consumed.input.slice();
      this.profile?.controls?.push({ slot, seq: consumed.seq, repeated: consumed.repeated, bits: new DataView(input.buffer, input.byteOffset, 12).getUint16(0, true), rejected: { ...player.inputs.rejected } });
      inputs.set(slot, input); weapons.set(slot, render.sprite(slot - 1).weapon);
    }
    this.history.set(this.tick, { state: this.save(), inputs, weapons });
    while (this.history.size > HISTORY_TICKS + 1) this.history.delete(this.history.keys().next().value!);
    for (const [slot, input] of inputs) { this.apply(slot, this.tick, input); this.lastInputs.set(slot, input); }
    const stepStart = this.profile ? performance.now() : 0;
    const advanced = requireStatus(this.host.step(), "sim_step");
    if (this.profile) this.profile.stepMs += performance.now() - stepStart;
    if (advanced !== this.tick + 1) throw new Error(`Unexpected sim tick ${advanced}`);
    this.tick = advanced;
    this.pendingEvents.set(this.tick, this.events());
    this.commitEvents();
    if (this.tick % 2 === 0) this.snapshot();
    if (this.tick % 30 === 0) this.retransmitEvents();
  }

  private admitFire(slot: number, player: Player, frame: InputFrame): FireAdmission {
    const allowance = Math.min(REWIND_TICKS, Math.ceil(player.rttMs * 0.03) + 2);
    const viewAllowance = Math.min(18, Math.ceil(player.rttMs * 0.06) + 8);
    const late = frame.tick < this.tick;
    if (this.tick - frame.tick > allowance || frame.tick - frame.viewTick > viewAllowance || (late && !this.history.has(frame.tick))) {
      this.uncompensatedShots++;
      return "present";
    }
    if (!late) return "present";
    return this.rewindFire(slot, player, frame) ? "rewound" : "reject";
  }

  /** Insert intent only; original historical guns derive muzzle, cooldown, ammo and hits. */
  private rewindFire(slot: number, player: Player, frame: InputFrame): boolean {
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
    if (!anchor) throw new Error("Missing retained rewind state");
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
    const latest = this.history.get(this.tick - 1)!;
    for (const [owner, input] of latest.inputs) this.lastInputs.set(owner, input);
    this.lastRewindTick = this.tick; player.lastRewind = this.tick;
    this.replayTicks += this.tick - restoreTick; this.replayMs.push(performance.now() - start);
    return true;
  }

  private snapshot(): void {
    if (this.snapshotId === 0xffffffff) throw new Error("Snapshot ID space exhausted");
    const state = this.save(), hashStart = this.profile ? performance.now() : 0;
    const stateHash = BigInt.asUintN(64, this.host.exports.sim_hash_state());
    if (this.profile) this.profile.hashMs += performance.now() - hashStart;
    const id = ++this.snapshotId;
    const inputs = [...this.lastInputs].sort((a, b) => a[0] - b[0]).map(([slot, input]) => ({ slot, input }));
    // Recipients acknowledging the same immutable snapshot share its bytes.
    // Encode once per distinct baseline, not once per player. Each IPC post
    // still owns its structured-cloned packet; no ACK or state is fabricated.
    const deltas = new Map<Uint8Array | undefined, Uint8Array>();
    for (const [slot, player] of this.players) {
      // A missing/never-acked baseline is an explicit full-state recovery.
      if (player.sent.size >= 128) { player.baselineId = 0; player.baseline = undefined; player.sent.clear(); }
      // WSS already delivers this fullstate reliably. Requeueing 30 copies/s
      // before its ACK only multiplies TCP HOL and can starve the handshake.
      if (player.baselineId === 0 && player.sent.size !== 0) continue;
      player.sent.set(id, state);
      let delta = deltas.get(player.baseline);
      if (!delta) {
        const deltaStart = this.profile ? performance.now() : 0;
        delta = encodeDelta(state, player.baseline);
        deltas.set(player.baseline, delta);
        if (this.profile) { this.profile.deltaMs += performance.now() - deltaStart; this.profile.deltaEncodes++; }
      }
      if (this.profile) this.profile.recipients++;
      this.emit({ type: "send", slot, serverTick: this.tick, message: { type: "snapshot", serverTick: this.tick, lastConsumedInputSeq: player.inputs.lastConsumedSequence, snapshotId: id, baselineId: player.baselineId, stateHash, inputs, state: delta } });
    }
  }

  private commitEvents(): void {
    for (const [tick, bytes] of this.pendingEvents) {
      if (tick > this.tick - REWIND_TICKS) continue;
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
  takeLagMetrics(): { replayMs: number[]; replayTicks: number; rejectedShots: number; uncompensatedShots: number; inputBufferOccupancy: number[]; inputBufferLeadTicks: number[] } {
    const result = { replayMs: this.replayMs, replayTicks: this.replayTicks, rejectedShots: this.rejectedShots, uncompensatedShots: this.uncompensatedShots, inputBufferOccupancy: this.inputBufferOccupancy, inputBufferLeadTicks: this.inputBufferLeadTicks };
    this.replayMs = []; this.replayTicks = 0; this.rejectedShots = 0; this.uncompensatedShots = 0;
    this.inputBufferOccupancy = []; this.inputBufferLeadTicks = [];
    return result;
  }
  dispose(): void {
    this.players.clear(); this.history.clear(); this.pendingEvents.clear();
    this.host.exports.sim_free(this.inputPtr); this.host.dispose();
  }
}
