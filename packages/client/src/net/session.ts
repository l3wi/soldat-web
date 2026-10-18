import { requireStatus, type RenderView, type SimHost } from "@soldat-web/sim-host";
import { validateChat, validateFeature, isServerFeature, isClientFeature, type ControlState, type FeatureClientMessage, type FeatureServerMessage, type ChatChannel, type ChatDelivery, type InputFrame, type Message, type ReliableEvent, type TickRecord } from "@soldat-web/protocol";
import { SimWorldView, type WorldSprite, type WorldView } from "../world.ts";

type StepRecord = Extract<TickRecord, { type: "step" }>;
export const INPUT_HISTORY = 128;
export const REPLAY = 1;
const STEP_MS = 1000 / 60;
const PREDICTION_SAFETY_TICKS = 8;
// The server queues eight early ticks; reserve two for clock-estimate error.
const MAX_JITTER_MARGIN_TICKS = 6;
const RTT_WINDOW = 32;
/** Holding a remote control must never repeat a grenade/switch/reload/etc edge. */
export function heldInput(input: Uint8Array): Uint8Array {
  const held = new Uint8Array(input); held[0] = held[0]! & 0x3f; held[1] = 0; return held;
}
export interface OnlineMetrics {
  status: string; slot: number; serverTick: number; predictedTick: number; viewTick: number;
  rttMs: number; loss: number; stateAgeMs: number; interpolationMs: number;
  correction: number; corrections: number; replayTicks: number; resyncs: number;
  confirmedTick: number; hashTick: number; confirmedHash: string; loadedHash: string;
  hashMatches: number; hashMismatches: number; ticks: number; records: number; bytes: number; events: number;
  pendingInputs: number; anchorBytes: number; confirmedMs: number; reconcileMs: number;
  rollbacks: number; reloads: number; skippedReloads: number;
  lastConsumedInputSeq: number; replayLength: number; duplicateEvents: number; eventGaps: number;
  predictionLeadTicks: number; targetPredictionLeadTicks: number; rttDeviationMs: number; predictionClockRate: number;
}
export interface CorrectionSprite {
  slot: number; active: boolean; x: number; y: number; health: number; flags: number; fuel: number;
}
export interface CorrectionDiagnostic {
  slot: number; correction: number; previousServerTick: number; serverTick: number; predictedTick: number;
  viewTick: number; stateAgeMs: number; rttMs: number; previousConsumedInputSeq: number; consumedInputSeq: number;
  sequence: number; replayGaps: number[];
  before: CorrectionSprite[]; authoritative: CorrectionSprite[]; after: CorrectionSprite[];
  ring: { seq: number; tick: number; viewTick: number; bits: number; input: number[] }[];
  previousInputs: { slot: number; bits: number; input: number[] }[];
  authoritativeInputs: { slot: number; bits: number; input: number[] }[];
}
function correctionSprites(sprites: readonly WorldSprite[]): CorrectionSprite[] {
  return sprites.filter(sprite => sprite.active).map(({ slot, active, x, y, health, flags, fuel }) =>
    ({ slot, active, x, y, health, flags, fuel }));
}
function diagnosticInput(input: Uint8Array): { bits: number; input: number[] } {
  return { bits: input[0]! | (input[1]! << 8), input: Array.from(input) };
}
export interface OnlineOptions {
  prediction: SimHost; confirmed: SimHost; slot: number; send(message: Message): void;
  now?: () => number; onEvent?: (event: ReliableEvent) => void;
  onTicks?: (metrics: Readonly<OnlineMetrics>) => void;
  onChat?: (message: ChatDelivery) => void;
  onNotice?: (text: string) => void;
  onFeature?: (message: FeatureServerMessage) => void;
  onSlotLeave?: (slot: number) => void;
  /** Full states cannot prove occupant continuity across skipped tick records. */
  onStateReset?: () => void;
  /** Opt-in reconciliation evidence; no diagnostic copies are made when absent. */
  onCorrection?: (diagnostic: Readonly<CorrectionDiagnostic>) => void;
  /** Borrowed event records, presentation kinds only; never emitted on REPLAY. */
  onPresentation?: (bytes: Uint8Array) => void;
  /** Complete borrowed live-step batch, once per forward tick; never REPLAY. */
  onLiveStep?: (tick: number, bytes: Uint8Array) => void;
}
interface Pose { tick: number; sprites: WorldSprite[] }
function copySprite(sprite: WorldSprite): WorldSprite {
  return { ...sprite, previous: sprite.previous.slice(), current: sprite.current.slice() };
}
/** Two AI-on instances: confirmed follows the ordered server timeline while
 * prediction holds remote human controls and replays local unacknowledged intent. */
export class OnlineSession {
  readonly predictionWorld: SimWorldView;
  readonly world: { sprites: WorldSprite[]; tick: number; ceaseFireTime?: number; sync(): void };
  readonly metrics: OnlineMetrics;
  private readonly confirmedWorld: SimWorldView;
  private readonly now: () => number;
  private readonly ring: (InputFrame | undefined)[] = new Array(INPUT_HISTORY);
  private readonly recent: InputFrame[] = [];
  private readonly anchors = new Map<number, Uint8Array>();
  private readonly timeline = new Map<number, StepRecord>();
  private readonly predictedInputs = new Map<number, { slot: number; input: Uint8Array }[]>();
  private confirmedInputPtr: number;
  private readonly poses: Pose[] = [];
  private remote: { slot: number; input: Uint8Array }[] = [];
  private seq = 0;
  private resyncSequence = 0;
  private lastEvent = 0;
  private lastStateAt = 0;
  private lastPresentAt = 0;
  private lastPingAt = -Infinity;
  private ping: bigint | undefined;
  private readonly rttDeviations = new Float64Array(RTT_WINDOW);
  private readonly sortedDeviations = new Float64Array(RTT_WINDOW);
  private rttSamples = 0;
  private clockPhase = 0;
  private clockAt = 0;
  private waiting = true;
  private resyncRequested = false;
  private correctionX = 0;
  private correctionY = 0;
  private jitter = 0;
  private inputPtr: number;
  private eventPtr: number;
  private readonly eventCapacity = 1_048_576;
  private fraction = 1;
  private disposed = false;
  private readonly options: OnlineOptions;
  private controlState: ControlState = { host: false, admin: false, paused: false, muted: false, vote: null };
  get control(): Readonly<ControlState> { return this.controlState; }
  get paused(): boolean { return this.controlState.paused; }
  constructor(options: OnlineOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.predictionWorld = new SimWorldView(options.prediction);
    this.confirmedWorld = new SimWorldView(options.confirmed);
    this.world = { sprites: this.predictionWorld.sprites.map(copySprite), tick: 0, sync() {} };
    this.inputPtr = requireStatus(options.prediction.exports.sim_alloc(12), "sim_alloc(online input)");
    this.eventPtr = requireStatus(options.prediction.exports.sim_alloc(this.eventCapacity), "sim_alloc(online events)");
    if (!this.inputPtr || !this.eventPtr) throw new Error("Online buffer allocation failed");
    this.confirmedInputPtr = requireStatus(options.confirmed.exports.sim_alloc(12), "sim_alloc(confirmed input)");
    if (!this.confirmedInputPtr) throw new Error("Confirmed input allocation failed");
    this.metrics = { status: "awaiting state", slot: options.slot, serverTick: 0, predictedTick: 0, viewTick: 0,
      rttMs: 0, loss: 0, stateAgeMs: 0, interpolationMs: 50, correction: 0, corrections: 0,
      replayTicks: 0, resyncs: 0, confirmedTick: 0, hashTick: 0, confirmedHash: "", loadedHash: "",
      hashMatches: 0, hashMismatches: 0, ticks: 0, records: 0, bytes: 0, events: 0, pendingInputs: 0, anchorBytes: 0, confirmedMs: 0, reconcileMs: 0,
      rollbacks: 0, reloads: 0, skippedReloads: 0,
      lastConsumedInputSeq: 0, replayLength: 0, duplicateEvents: 0, eventGaps: 0,
      predictionLeadTicks: 2, targetPredictionLeadTicks: 2, rttDeviationMs: 0, predictionClockRate: 1 };
  }
  /** Ordered map bootstrap boundary: retain input sequence/event identity, discard the old-map timeline. */
  resetRound(): void {
    this.waiting = true; this.resyncRequested = false; this.metrics.status = "loading next round";
    this.ring.fill(undefined); this.recent.length = 0;
    this.anchors.clear(); this.timeline.clear(); this.predictedInputs.clear(); this.poses.length = 0;
    this.remote = []; this.correctionX = 0; this.correctionY = 0;
    this.metrics.pendingInputs = 0; this.metrics.anchorBytes = 0;
    this.resyncSequence = this.seq;
  }

  sendChat(channel: ChatChannel, text: string): void {
    validateChat(channel, text);
    if (this.disposed || this.metrics.status !== "online") throw new Error("Online connection unavailable");
    this.options.send({ type: "chat", channel, text });
  }
  sendFeature(message: FeatureClientMessage): void {
    validateFeature(message);
    if (!isClientFeature(message)) throw new Error("Server feature cannot be sent by a client");
    if (this.disposed) throw new Error("Online connection unavailable");
    this.options.send(message);
  }
  private get stepMilliseconds(): number { return STEP_MS / this.authoritativeRenderView().globals.tickScale; }
  receive(message: Message): void {
    if (this.disposed) return;
    if (isClientFeature(message)) throw new Error("Client-originated feature received from server");
    if (isServerFeature(message)) {
      if (message.type === "control-state") {
        const changed = message.state.paused !== this.controlState.paused;
        this.controlState = message.state;
        if (changed) {
          this.ring.fill(undefined); this.recent.length = 0; this.predictedInputs.clear();
          this.metrics.pendingInputs = 0; this.resyncSequence = this.seq;
          this.clockAt = this.now(); this.lastStateAt = this.clockAt;
          this.clockPhase = this.metrics.confirmedTick + this.metrics.predictionLeadTicks;
          if (message.state.paused && this.anchors.size) {
            requireStatus(this.options.prediction.loadState(this.saved()), "prediction pause restore");
            this.predictionWorld.sync(); this.metrics.predictedTick = this.metrics.confirmedTick;
            this.correctionX = 0; this.correctionY = 0; this.fraction = 1;
          }
        }
      }
      this.options.onFeature?.(message);
      return;
    }
    if (message.type === "chat-message") { this.options.onChat?.(message); return; }
    if (message.type === "notice") { this.options.onNotice?.(message.text); return; }
    if (message.type === "ping") { this.options.send({ type: "pong", timestamp: message.timestamp }); return; }
    if (message.type === "pong") {
      if (this.ping === message.timestamp) {
        const rtt = Math.max(0, this.now() - Number(message.timestamp) / 1000);
        const m = this.metrics;
        this.rttDeviations[this.rttSamples++ % RTT_WINDOW] = m.rttMs ? Math.abs(rtt - m.rttMs) : 0;
        m.rttMs = m.rttMs ? m.rttMs * 0.8 + rtt * 0.2 : rtt;
        const count = Math.min(this.rttSamples, RTT_WINDOW);
        this.sortedDeviations.set(this.rttDeviations);
        this.sortedDeviations.fill(Infinity, count); this.sortedDeviations.sort();
        m.rttDeviationMs = this.sortedDeviations[Math.ceil(count * 0.95) - 1]!;
        m.targetPredictionLeadTicks = Math.min(INPUT_HISTORY - PREDICTION_SAFETY_TICKS,
          m.rttMs / 2 / this.stepMilliseconds + Math.min(MAX_JITTER_MARGIN_TICKS, m.rttDeviationMs / 2 / this.stepMilliseconds) + 2);
        this.ping = undefined;
      }
      return;
    }
    if (message.type === "disconnect") throw new Error(`Server disconnected (${message.code}): ${message.reason}`);
    if (message.type === "events") {
      for (const event of message.events) {
        if (event.id > this.lastEvent) {
          if (this.lastEvent) this.metrics.eventGaps += Math.max(0, event.id - this.lastEvent - 1);
          this.options.onEvent?.(event); this.lastEvent = event.id; this.metrics.events++;
        } else this.metrics.duplicateEvents++;
        this.options.send({ type: "eventAck", eventId: event.id });
      }
      return;
    }
    if (message.type === "state") this.state(message);
    if (message.type === "ticks" && !this.waiting) this.ticks(message);
  }
  private resync(): void {
    if (!this.resyncRequested) {
      this.resyncRequested = true; this.metrics.resyncs++;
      this.options.send({ type: "resync" });
    }
    this.waiting = true; this.metrics.status = "resynchronizing";
    this.resyncSequence = this.seq;
    this.ring.fill(undefined); this.recent.length = 0; this.metrics.pendingInputs = 0;
  }
  private saved(): Uint8Array {
    const bytes = this.options.confirmed.saveState();
    if (typeof bytes === "number") throw new Error(`Confirmed save failed: ${bytes}`);
    return bytes;
  }
  private verify(tick: number, hash: bigint): boolean {
    const m = this.metrics;
    if (tick !== m.confirmedTick) throw new Error(`Hash boundary ${tick} != confirmed ${m.confirmedTick}`);
    const actual = this.options.confirmed.hash(), expected = hash.toString(16).padStart(16, "0");
    m.hashTick = tick; m.confirmedHash = expected; m.loadedHash = actual;
    if (actual !== expected) {
      m.hashMismatches++; this.resync(); return false;
    }
    m.hashMatches++; return true;
  }
  private state(message: Extract<Message, { type: "state" }>): void {
    if (this.paused) {
      this.waiting = true; this.ring.fill(undefined); this.recent.length = 0;
      this.metrics.pendingInputs = 0; this.resyncSequence = this.seq;
    }
    requireStatus(this.options.confirmed.loadState(message.bytes), "confirmed state load");
    this.metrics.confirmedTick = message.tick;
    this.anchors.clear(); this.timeline.clear(); this.predictedInputs.clear(); this.poses.length = 0;
    this.anchors.set(message.tick, message.bytes.slice());
    if (!this.verify(message.tick, message.hash)) return;
    this.options.onStateReset?.();
    this.remote = [];
    this.resyncRequested = false;
    this.finish(message.lastConsumedInputSeq, true);
  }
  private stepConfirmed(record: StepRecord, notifyMembership = true): void {
    const host = this.options.confirmed;
    if (record.tick !== this.metrics.confirmedTick) throw new Error(`Out-of-order confirmed step ${record.tick}`);
    for (const bytes of record.commands) {
      // Preserve the exact JSON bytes; negative command status can be the
      // authoritative simulation's normal limbo rejection too.
      const pointer = requireStatus(host.exports.sim_alloc(bytes.length), "sim_alloc(command)");
      if (!pointer) throw new Error("Command allocation failed");
      try {
        new Uint8Array(host.exports.memory.buffer, pointer, bytes.length).set(bytes);
        const status = host.exports.sim_command(record.tick, pointer, bytes.length);
        if (notifyMembership && status >= 0 && this.options.onSlotLeave) {
          const command = JSON.parse(new TextDecoder().decode(bytes)) as { kind?: string; slot?: number };
          if (command.kind === "leave" && typeof command.slot === "number") this.options.onSlotLeave(command.slot);
        }
      } finally { host.exports.sim_free(pointer); }
    }
    for (const { slot, input } of record.inputs) {
      new Uint8Array(host.exports.memory.buffer, this.confirmedInputPtr, 12).set(input);
      requireStatus(host.exports.sim_set_input(slot, record.tick, this.confirmedInputPtr), "sim_set_input(confirmed)");
    }
    requireStatus(host.step(REPLAY), "sim_step(confirmed)");
    host.events(); // No confirmed presentation is ever sent to the UI.
    this.metrics.confirmedTick++;
    if (this.metrics.confirmedTick % 8 === 0) this.anchors.set(this.metrics.confirmedTick, this.saved());
  }
  private ticks(message: Extract<Message, { type: "ticks" }>): void {
    const m = this.metrics, started = this.now();
    let reload = false;
    for (const record of message.records) {
      m.records++;
      if (record.type === "step") {
        const used = this.predictedInputs.get(record.tick);
        const matching = used && used.length === record.inputs.length && used.every((entry, index) =>
          entry.slot === record.inputs[index]!.slot && entry.input.every((byte, offset) => byte === record.inputs[index]!.input[offset]));
        if (record.commands.length || (record.tick < this.predictionWorld.tick && !matching)) reload = true;
        this.timeline.set(record.tick, record);
        this.stepConfirmed(record); m.ticks++;
        this.remote = record.inputs.map(({ slot, input }) => ({ slot, input: heldInput(input) }));
      } else if (record.type === "correct") {
        const step = this.timeline.get(record.tick);
        let anchorTick = -1;
        for (const tick of this.anchors.keys()) if (tick <= record.tick && tick > anchorTick) anchorTick = tick;
        const anchor = this.anchors.get(anchorTick);
        const entry = step?.inputs.find(input => input.slot === record.slot);
        if (!anchor || !entry) { this.resync(); return; }
        entry.input = record.input.slice();
        const target = m.confirmedTick;
        requireStatus(this.options.confirmed.loadState(anchor), "confirmed correction restore");
        for (const tick of this.anchors.keys()) if (tick > anchorTick) this.anchors.delete(tick);
        m.confirmedTick = anchorTick;
        for (let tick = anchorTick; tick < target; tick++) {
          const historical = this.timeline.get(tick);
          if (!historical) { this.resync(); return; }
          this.stepConfirmed(historical, false);
        }
        const latest = this.timeline.get(target - 1);
        if (latest) this.remote = latest.inputs.map(({ slot, input }) => ({ slot, input: heldInput(input) }));
        m.rollbacks++; reload = true;
      } else if (!this.verify(record.tick, record.hash)) return;
    }
    // Retain the anchor immediately before the 32-tick window as well as all
    // newer ones, so any legal 12-tick rewind has complete replay coverage.
    const cutoff = m.confirmedTick - 40;
    for (const tick of this.anchors.keys()) if (tick < cutoff) this.anchors.delete(tick);
    const oldest = Math.min(...this.anchors.keys());
    for (const tick of this.timeline.keys()) if (tick < oldest) this.timeline.delete(tick);
    for (const tick of this.predictedInputs.keys()) if (tick < oldest) this.predictedInputs.delete(tick);
    m.confirmedMs = this.now() - started;
    this.finish(message.lastConsumedInputSeq, reload);
  }
  private finish(consumed: number, reload: boolean): void {
    const m = this.metrics, started = this.now(), boundary = m.confirmedTick;
    const old = this.predictionWorld.sprites[this.options.slot - 1]!;
    const oldX = old.x, oldY = old.y, oldActive = old.active, oldTick = this.predictionWorld.tick;
    const diagnostic: CorrectionDiagnostic | undefined = this.options.onCorrection ? {
      slot: this.options.slot, correction: 0, previousServerTick: m.serverTick, serverTick: boundary,
      predictedTick: oldTick, viewTick: m.viewTick, stateAgeMs: this.now() - this.lastStateAt,
      rttMs: m.rttMs, previousConsumedInputSeq: m.lastConsumedInputSeq, consumedInputSeq: consumed,
      sequence: this.seq, replayGaps: [], before: correctionSprites(this.predictionWorld.sprites),
      authoritative: [], after: [],
      ring: this.ring.filter((frame): frame is InputFrame => !!frame).map(frame => ({ seq: frame.seq, tick: frame.tick, viewTick: frame.viewTick, ...diagnosticInput(frame.input) })).sort((a, b) => a.tick - b.tick),
      previousInputs: (this.predictedInputs.get(boundary) ?? []).map(entry => ({ slot: entry.slot, ...diagnosticInput(entry.input) })),
      authoritativeInputs: this.remote.map(entry => ({ slot: entry.slot, ...diagnosticInput(entry.input) })),
    } : undefined;
    this.confirmedWorld.sync();
    if (diagnostic) diagnostic.authoritative = correctionSprites(this.confirmedWorld.sprites);
    this.poses.push({ tick: boundary, sprites: this.confirmedWorld.sprites.map(copySprite) });
    if (this.poses.length > 16) this.poses.shift();
    for (let i = 0; i < this.ring.length; i++) {
      const frame = this.ring[i];
      if (frame && (frame.seq <= consumed || frame.tick < boundary)) this.ring[i] = undefined;
    }
    const target = this.waiting ? boundary : Math.max(boundary, oldTick);
    if (target - boundary >= INPUT_HISTORY) { this.resync(); return; }
    if (reload || this.waiting || oldTick < boundary) {
      const bytes = this.saved();
      requireStatus(this.options.prediction.loadState(bytes), "prediction confirmed restore");
      m.reloads++;
      for (const tick of this.predictedInputs.keys()) if (tick >= boundary) this.predictedInputs.delete(tick);
      for (let tick = boundary; tick < target; tick++) {
        const frame = this.ring[tick % INPUT_HISTORY];
        if (diagnostic && frame?.tick !== tick) diagnostic.replayGaps.push(tick);
        this.controls(tick, frame?.tick === tick ? frame.input : undefined);
        requireStatus(this.options.prediction.step(REPLAY), "sim_step(REPLAY)"); m.replayTicks++;
      }
      this.predictionWorld.sync();
    } else m.skippedReloads++;
    const local = this.predictionWorld.sprites[this.options.slot - 1]!;
    m.correction = 0;
    if (!this.waiting && oldTick === target && oldActive && local.active) {
      const dx = oldX - local.x, dy = oldY - local.y;
      m.correction = Math.hypot(dx, dy);
      if (m.correction > 0.001) { m.corrections++; this.correctionX += dx; this.correctionY += dy; }
    }
    const at = this.now();
    if (!this.waiting) {
      const elapsed = at - this.lastStateAt, expectedMs = (boundary - m.serverTick) * this.stepMilliseconds;
      this.jitter = this.jitter * 0.9 + Math.abs(elapsed - expectedMs) * 0.1;
      m.interpolationMs += (Math.max(33, Math.min(100, 33 + this.jitter * 2)) - m.interpolationMs) * 0.1;
    }
    if (this.waiting) {
      this.clockPhase = boundary + Math.min(INPUT_HISTORY - PREDICTION_SAFETY_TICKS, m.rttMs / 2 / this.stepMilliseconds + m.predictionLeadTicks);
      this.clockAt = at; m.viewTick = boundary;
    } else this.clockPhase = Math.max(this.clockPhase, this.predictionWorld.tick);
    m.serverTick = boundary;
    this.lastStateAt = at; this.waiting = false; this.resyncRequested = false; m.status = "online";
    m.predictedTick = this.predictionWorld.tick; m.pendingInputs = this.ring.filter(Boolean).length;
    m.lastConsumedInputSeq = consumed; m.replayLength = target - boundary;
    m.anchorBytes = [...this.anchors.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    m.reconcileMs = this.now() - started;
    this.options.onTicks?.(m);
    if (diagnostic && m.correction > 0.001) {
      diagnostic.correction = m.correction; diagnostic.after = correctionSprites(this.predictionWorld.sprites);
      this.options.onCorrection!(diagnostic);
    }
  }
  private controls(tick: number, local?: Uint8Array): void {
    const host = this.options.prediction;
    for (const entry of this.remote) {
      if (entry.slot === this.options.slot && local) continue;
      new Uint8Array(host.exports.memory.buffer, this.inputPtr, 12).set(entry.input);
      requireStatus(host.exports.sim_set_input(entry.slot, tick, this.inputPtr), "sim_set_input(held)");
    }
    if (local) {
      new Uint8Array(host.exports.memory.buffer, this.inputPtr, 12).set(local);
      requireStatus(host.exports.sim_set_input(this.options.slot, tick, this.inputPtr), "sim_set_input(local)");
    }
    this.predictedInputs.set(tick, this.remote.map(entry => ({ slot: entry.slot, input: entry.slot === this.options.slot && local ? local.slice() : entry.input.slice() })));
    if (local && !this.remote.some(entry => entry.slot === this.options.slot)) this.predictedInputs.get(tick)!.push({ slot: this.options.slot, input: local.slice() });
    this.predictedInputs.get(tick)!.sort((a, b) => a.slot - b.slot);
  }
  /** Called per display frame. Clock debt never becomes variable simulation dt. */
  advance(sample: () => Uint8Array, beforeStep?: () => void, afterStep?: () => void): void {
    if (this.disposed) return;
    const at = this.now(), m = this.metrics;
    if (at - this.lastPingAt >= 1000) {
      this.lastPingAt = at; this.ping = BigInt(Math.floor(at * 1000)); this.options.send({ type: "ping", timestamp: this.ping });
    }
    if (this.waiting || this.paused) return;
    // A reliable stream can keep arriving while all local inputs are rejected.
    // Detect sequence deadlock independently of tick-indexed retirement.
    if (this.seq - Math.max(m.lastConsumedInputSeq, this.resyncSequence) >= INPUT_HISTORY) { this.resync(); return; }
    m.stateAgeMs = at - this.lastStateAt;
    const stepMilliseconds = this.stepMilliseconds;
    if (m.stateAgeMs > INPUT_HISTORY * stepMilliseconds) { this.resync(); return; }
    this.present();
    const serverNow = m.serverTick + (m.stateAgeMs + m.rttMs / 2) / stepMilliseconds;
    const elapsed = Math.max(0, at - this.clockAt);
    this.clockAt = at;
    // Increase lead slowly; shed surplus lead faster. Clock corrections change
    // tick rate by at most 10%, never skip a sampled tick or invent view time.
    const leadDelta = m.targetPredictionLeadTicks - m.predictionLeadTicks;
    m.predictionLeadTicks += Math.max(-elapsed * 0.004, Math.min(elapsed * 0.001, leadDelta));
    const targetPhase = serverNow + m.predictionLeadTicks;
    const naturalPhase = this.clockPhase + elapsed / stepMilliseconds;
    m.predictionClockRate = Math.max(0.9, Math.min(1.1, 1 + (targetPhase - naturalPhase) / 60));
    this.clockPhase = Math.max(this.predictionWorld.tick, Math.min(m.serverTick + INPUT_HISTORY - PREDICTION_SAFETY_TICKS,
      this.clockPhase + elapsed / stepMilliseconds * m.predictionClockRate));
    const desired = Math.floor(this.clockPhase);
    this.fraction = this.clockPhase - desired;
    for (let count = 0; this.predictionWorld.tick < desired && count < 4; count++) {
      const tick = this.predictionWorld.tick, index = tick % INPUT_HISTORY;
      if (this.ring[index]) { this.resync(); return; }
      const input = sample().slice();
      const frame: InputFrame = { seq: ++this.seq, tick, viewTick: Math.min(tick, m.viewTick), input };
      this.ring[index] = frame; this.recent.unshift(frame); this.recent.length = Math.min(3, this.recent.length);
      this.options.send({ type: "input", frames: this.recent.slice() });
      this.controls(tick, input); beforeStep?.();
      requireStatus(this.options.prediction.step(), "sim_step(prediction)");
      this.predictionWorld.sync(); afterStep?.();
      // Server sends gameplay events; predicted presentation is immediate and
      // replay-suppressed. Never expose speculative gameplay as authoritative.
      const bytes = requireStatus(this.options.prediction.exports.sim_events(this.eventPtr, this.eventCapacity), "sim_events(prediction drain)");
      if (bytes > this.eventCapacity) throw new Error("Prediction event capacity exceeded");
      this.options.onLiveStep?.(this.predictionWorld.tick, new Uint8Array(this.options.prediction.exports.memory.buffer, this.eventPtr, bytes));
      if (bytes && this.options.onPresentation) {
        const data = new Uint8Array(this.options.prediction.exports.memory.buffer, this.eventPtr, bytes);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let offset = 0; offset < bytes;) {
          if (offset + 20 > bytes) throw new Error("Truncated prediction event header");
          const length = 20 + view.getUint32(offset + 16, true);
          if (offset + length > bytes) throw new Error("Truncated prediction event payload");
          if (view.getUint32(offset, true) & 0x80000000) this.options.onPresentation(data.subarray(offset, offset + length));
          offset += length;
        }
      }
    }
    m.predictedTick = this.predictionWorld.tick; m.pendingInputs = this.ring.filter(Boolean).length;
  }
  present(fraction = this.fraction): WorldView {
    const at = this.now(), m = this.metrics;
    const decay = Math.exp(-Math.max(0, at - this.lastPresentAt) / 80);
    this.lastPresentAt = at; this.correctionX *= decay; this.correctionY *= decay;
    const latest = this.poses[this.poses.length - 1];
    if (!latest) return this.world;
    const target = Math.max(this.poses[0]!.tick, Math.min(latest.tick,
      m.serverTick + (at - this.lastStateAt + m.rttMs / 2 - m.interpolationMs) / this.stepMilliseconds));
    m.viewTick = Math.floor(target); m.stateAgeMs = at - this.lastStateAt;
    let a = this.poses[0]!, b = latest;
    for (const pose of this.poses) { if (pose.tick <= target) a = pose; if (pose.tick >= target) { b = pose; break; } }
    const alpha = a.tick === b.tick ? 1 : (target - a.tick) / (b.tick - a.tick);
    for (let i = 0; i < this.world.sprites.length; i++) {
      const local = i === this.options.slot - 1;
      const left = local ? this.predictionWorld.sprites[i]! : a.sprites[i]!;
      const right = local ? left : b.sprites[i]!;
      const out = this.world.sprites[i]!;
      const previous = out.previous, current = out.current;
      Object.assign(out, right, { previous, current });
      const t = local ? Math.max(0, Math.min(1, fraction)) : alpha;
      const dx = local ? this.correctionX : 0, dy = local ? this.correctionY : 0;
      out.x = left.x + (right.x - left.x) * t + dx; out.y = left.y + (right.y - left.y) * t + dy;
      for (let p = 0; p < current.length; p++) {
        const from = local ? left.previous[p]! : left.current[p]!;
        current[p] = from + (right.current[p]! - from) * t + (p % 2 ? dy : dx);
        previous[p] = current[p]!;
      }
    }
    this.world.tick = m.viewTick;
    this.world.ceaseFireTime = this.confirmedWorld.ceaseFireTime;
    return this.world;
  }
  /** Latest authoritative (not predicted) bullets/Things, borrowed until the
   * next confirmed step. Consume synchronously and never write these arrays. */
  authoritativeRenderView(): RenderView {
    const view = this.options.confirmed.renderView();
    if (typeof view === "number") throw new Error(`Authoritative render view unavailable: ${view}`);
    return view;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.prediction.exports.sim_free(this.inputPtr); this.options.prediction.exports.sim_free(this.eventPtr);
    this.options.confirmed.exports.sim_free(this.confirmedInputPtr);
    this.options.prediction.dispose(); this.options.confirmed.dispose();
    this.anchors.clear(); this.timeline.clear(); this.predictedInputs.clear(); this.poses.length = 0; this.ring.fill(undefined); this.metrics.status = "closed";
  }
}
