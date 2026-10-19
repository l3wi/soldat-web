import { RENDER_LAYOUT, SPRITE_FLAGS, requireStatus, type RenderView, type SimHost } from "@soldat-web/sim-host";
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
const RTT_BOOTSTRAP_SAMPLES = 2;
// One uncorroborated sample must fit the existing six-tick clock-error reserve.
const SINGLE_PROBE_BUDGET_MS = MAX_JITTER_MARGIN_TICKS * STEP_MS;
// Keep a bounded second of nominal two-tick relays, including a stalled burst.
const POSE_HISTORY = 32;
/** Holding a remote control must never repeat a grenade/switch/reload/etc edge. */
export function heldInput(input: Uint8Array): Uint8Array {
  const held = new Uint8Array(input); held[0] = held[0]! & 0x3f; held[1] = 0; return held;
}
export interface OnlineMetrics {
  status: string; slot: number; serverTick: number; predictedTick: number; viewTick: number;
  rttMs: number; stateAgeMs: number;
  /** Target reserve at receipt, derived from native cadence and bounded arrival jitter, not RTT. */
  interpolationMs: number;
  correction: number; corrections: number; replayTicks: number; resyncs: number;
  confirmedTick: number; hashTick: number; confirmedHash: string; loadedHash: string;
  hashMatches: number; hashMismatches: number; ticks: number; records: number; bytes: number; events: number;
  pendingInputs: number; anchorBytes: number; confirmedMs: number; reconcileMs: number;
  rollbacks: number; reloads: number; skippedReloads: number;
  lastConsumedInputSeq: number; replayLength: number; duplicateEvents: number; eventGaps: number;
  predictionLeadTicks: number; targetPredictionLeadTicks: number; rttDeviationMs: number; predictionClockRate: number;
  /** Received native-time estimate, not a synchronized server wall clock. */
  playoutPhase: number; playoutReserveMs: number; playoutRate: number;
  /** Forward seeks after undersupply or retained-history eviction, never RTT corrections. */
  playoutUnderruns: number; playoutRebases: number; playoutBuffering: boolean;
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
interface Pose { tick: number; timeMs: number; roundEpoch: number; generations: Uint32Array; sprites: WorldSprite[] }
interface RootPose {
  x: number; y: number; active: boolean; flags: number; team: number; ceaseFireCounter: number;
  roundEpoch: number; generation: number;
}
function sameLife(left: RootPose | WorldSprite, right: RootPose | WorldSprite): boolean {
  return left.active && right.active && left.team === right.team &&
    ((left.flags ^ right.flags) & SPRITE_FLAGS.dead) === 0 &&
    right.ceaseFireCounter <= left.ceaseFireCounter;
}
function captureRoot(out: RootPose, sprite: WorldSprite, roundEpoch: number, generation: number): void {
  out.x = sprite.x; out.y = sprite.y; out.active = sprite.active; out.flags = sprite.flags;
  out.team = sprite.team; out.ceaseFireCounter = sprite.ceaseFireCounter;
  out.roundEpoch = roundEpoch; out.generation = generation;
}
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
  private correctionAt = 0;
  private lastPingAt = -Infinity;
  private nextStartupProbeAt = -Infinity;
  private ping: bigint | undefined;
  private readonly rttDeviations = new Float64Array(RTT_WINDOW);
  private readonly sortedDeviations = new Float64Array(RTT_WINDOW);
  private rttSamples = 0;
  private clockPhase = 0;
  private clockAt = 0;
  private predictionClockPrimed = false;
  private waiting = true;
  private resyncRequested = false;
  private correctionX = 0;
  private correctionY = 0;
  private readonly correctionPose: Float32Array;
  private readonly beforePose: Float32Array;
  private readonly previousLocal: RootPose;
  private readonly confirmedPreviousLocal: RootPose;
  private readonly generations = new Uint32Array(RENDER_LAYOUT.slots);
  private readonly remoteLifeTicks = new Uint32Array(RENDER_LAYOUT.slots);
  private confirmedRenderData?: DataView;
  private localGeneration = 0;
  private localRoundEpoch = 0;
  private interpolateLocal = false;
  private presentationGeneration = 0;
  private receivedTimeMs = 0;
  private playoutTimeMs = 0;
  private playoutAt = 0;
  private playoutReceivedAt = 0;
  private playoutCadenceTicks = 2;
  private playoutJitterMs = 0;
  private recoveringPlayout = false;
  private inputPtr: number;
  private eventPtr: number;
  private readonly eventCapacity = 1_048_576;
  private fraction = 1;
  private disposed = false;
  private readonly options: OnlineOptions;
  private controlState: ControlState = { host: false, admin: false, paused: false, muted: false, vote: null };
  get control(): Readonly<ControlState> { return this.controlState; }
  get paused(): boolean { return this.controlState.paused; }
  /** Local soldier, camera and predicted cosmetics share this render phase. */
  get presentationFraction(): number { return this.interpolateLocal ? this.fraction : 1; }
  /** Changes only at presentation discontinuities, never at ordinary rollback. */
  get presentationEpoch(): number { return this.presentationGeneration; }
  constructor(options: OnlineOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.predictionWorld = new SimWorldView(options.prediction);
    this.confirmedWorld = new SimWorldView(options.confirmed);
    this.world = { sprites: this.predictionWorld.sprites.map(copySprite), tick: 0, sync() {} };
    const local = this.predictionWorld.sprites[options.slot - 1]!;
    this.previousLocal = { x: local.x, y: local.y, active: local.active, flags: local.flags, team: local.team,
      ceaseFireCounter: local.ceaseFireCounter, roundEpoch: this.predictionWorld.renderView.globals.roundEpoch, generation: 0 };
    this.confirmedPreviousLocal = { ...this.previousLocal };
    this.localRoundEpoch = this.previousLocal.roundEpoch;
    this.correctionPose = new Float32Array(local.current.length);
    this.beforePose = new Float32Array(local.current.length);
    this.inputPtr = requireStatus(options.prediction.exports.sim_alloc(12), "sim_alloc(online input)");
    this.eventPtr = requireStatus(options.prediction.exports.sim_alloc(this.eventCapacity), "sim_alloc(online events)");
    if (!this.inputPtr || !this.eventPtr) throw new Error("Online buffer allocation failed");
    this.confirmedInputPtr = requireStatus(options.confirmed.exports.sim_alloc(12), "sim_alloc(confirmed input)");
    if (!this.confirmedInputPtr) throw new Error("Confirmed input allocation failed");
    this.metrics = { status: "awaiting state", slot: options.slot, serverTick: 0, predictedTick: 0, viewTick: 0,
      rttMs: 0, stateAgeMs: 0, interpolationMs: STEP_MS * 3, correction: 0, corrections: 0,
      replayTicks: 0, resyncs: 0, confirmedTick: 0, hashTick: 0, confirmedHash: "", loadedHash: "",
      hashMatches: 0, hashMismatches: 0, ticks: 0, records: 0, bytes: 0, events: 0, pendingInputs: 0, anchorBytes: 0, confirmedMs: 0, reconcileMs: 0,
      rollbacks: 0, reloads: 0, skippedReloads: 0,
      lastConsumedInputSeq: 0, replayLength: 0, duplicateEvents: 0, eventGaps: 0,
      predictionLeadTicks: 2, targetPredictionLeadTicks: 2, rttDeviationMs: 0, predictionClockRate: 1,
      playoutPhase: 0, playoutReserveMs: 0, playoutRate: 0, playoutUnderruns: 0, playoutRebases: 0, playoutBuffering: true };
  }
  /** Ordered map bootstrap boundary: retain input sequence/event identity, discard the old-map timeline. */
  resetRound(): void {
    this.waiting = true; this.resyncRequested = false; this.metrics.status = "loading next round";
    this.ring.fill(undefined); this.recent.length = 0;
    this.anchors.clear(); this.timeline.clear(); this.predictedInputs.clear(); this.poses.length = 0;
    this.receivedTimeMs = 0; this.resetPlayout(this.now());
    this.remote = []; this.clearCorrection(); this.interpolateLocal = false; this.presentationGeneration++;
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
  private get stepMilliseconds(): number {
    return STEP_MS / this.confirmedRender().getFloat32(RENDER_LAYOUT.globalsOffset + RENDER_LAYOUT.globals.tickScale, true);
  }
  private get timingReady(): boolean {
    return this.predictionClockPrimed || this.rttSamples >= RTT_BOOTSTRAP_SAMPLES ||
      (this.rttSamples > 0 && this.metrics.rttMs <= SINGLE_PROBE_BUDGET_MS);
  }
  /** Startup probes seed the clock before steady-state filtering can retain an admission stall. */
  private get predictionRttMs(): number {
    return this.timingReady ? this.metrics.rttMs : 0;
  }
  private targetLeadTicks(stepMilliseconds: number): number {
    return Math.min(INPUT_HISTORY - PREDICTION_SAFETY_TICKS, this.predictionRttMs / 2 / stepMilliseconds +
      Math.min(MAX_JITTER_MARGIN_TICKS, this.metrics.rttDeviationMs / 2 / stepMilliseconds) + 2);
  }
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
          // A pause is a presentation boundary, not hours of playback debt.
          const latest = this.poses[this.poses.length - 1];
          if (latest) this.poses.splice(0, this.poses.length - 1);
          this.resetPlayout(this.clockAt);
          if (message.state.paused && this.anchors.size) {
            requireStatus(this.options.prediction.loadState(this.saved()), "prediction pause restore");
            this.predictionWorld.sync(); this.metrics.predictedTick = this.metrics.confirmedTick;
            this.clearCorrection(); this.fraction = 1; this.interpolateLocal = false; this.presentationGeneration++;
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
        const at = this.now(), rtt = Math.max(0, at - Number(message.timestamp) / 1000);
        const m = this.metrics;
        const calibrating = !this.predictionClockPrimed;
        this.rttDeviations[this.rttSamples % RTT_WINDOW] = calibrating ? 0 : Math.abs(rtt - m.rttMs);
        m.rttMs = this.rttSamples === 0 ? rtt : calibrating ? Math.min(m.rttMs, rtt) : m.rttMs * 0.8 + rtt * 0.2;
        this.rttSamples++;
        const count = Math.min(this.rttSamples, RTT_WINDOW);
        this.sortedDeviations.set(this.rttDeviations);
        this.sortedDeviations.fill(Infinity, count); this.sortedDeviations.sort();
        m.rttDeviationMs = this.sortedDeviations[Math.ceil(count * 0.95) - 1]!;
        m.targetPredictionLeadTicks = this.targetLeadTicks(this.stepMilliseconds);
        this.ping = undefined;
        // Replies are limited to one per 250 ms. Waiting after a received
        // reply also covers asymmetric transit and a delayed first response.
        this.nextStartupProbeAt = at + 250 + STEP_MS;
      }
      return;
    }
    if (message.type === "disconnect") throw new Error(`Server disconnected (${message.code}): ${message.reason}`);
    if (message.type === "events") {
      let highestHandled = 0;
      for (const event of message.events) {
        if (event.id > this.lastEvent) {
          this.options.onEvent?.(event);
          if (this.lastEvent) this.metrics.eventGaps += Math.max(0, event.id - this.lastEvent - 1);
          this.lastEvent = event.id; this.metrics.events++;
        } else this.metrics.duplicateEvents++;
        highestHandled = Math.max(highestHandled, event.id);
      }
      // Only a completely handled batch is acknowledged. If a callback throws,
      // its event and the unprocessed suffix remain retryable; successful prior
      // callbacks have already advanced lastEvent and will not run twice.
      if (highestHandled) this.options.send({ type: "eventAck", eventId: highestHandled });
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
    this.metrics.playoutRate = 0; this.metrics.playoutBuffering = true; this.playoutAt = this.now();
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
    this.receivedTimeMs = 0;
    this.anchors.set(message.tick, message.bytes.slice());
    if (!this.verify(message.tick, message.hash)) return;
    this.options.onStateReset?.();
    this.remote = [];
    this.resyncRequested = false;
    this.finish(message.lastConsumedInputSeq, true, true);
  }
  private stepConfirmed(record: StepRecord, notifyMembership = true, capturePreviousRoot = false): void {
    const host = this.options.confirmed;
    // Scheduling duration belongs to the forward received timeline. Replaying a
    // correction cannot add elapsed time or move the remote playout clock.
    const durationMs = notifyMembership ? this.stepMilliseconds : 0;
    if (record.tick !== this.metrics.confirmedTick) throw new Error(`Out-of-order confirmed step ${record.tick}`);
    for (const bytes of record.commands) {
      // Preserve the exact JSON bytes; negative command status can be the
      // authoritative simulation's normal limbo rejection too.
      const pointer = requireStatus(host.exports.sim_alloc(bytes.length), "sim_alloc(command)");
      if (!pointer) throw new Error("Command allocation failed");
      try {
        new Uint8Array(host.exports.memory.buffer, pointer, bytes.length).set(bytes);
        const status = host.exports.sim_command(record.tick, pointer, bytes.length);
        if (status >= 0) {
          const command = JSON.parse(new TextDecoder().decode(bytes)) as { kind?: string; slot?: number };
          if (typeof command.slot === "number" && command.slot >= 1 && command.slot <= this.generations.length) {
            if (notifyMembership && (command.kind === "join" || command.kind === "leave" || command.kind === "spawn" || command.kind === "team")) this.generations[command.slot - 1]!++;
            if (notifyMembership && command.kind === "leave") this.options.onSlotLeave?.(command.slot);
          }
        }
      } finally { host.exports.sim_free(pointer); }
    }
    for (const { slot, input } of record.inputs) {
      new Uint8Array(host.exports.memory.buffer, this.confirmedInputPtr, 12).set(input);
      requireStatus(host.exports.sim_set_input(slot, record.tick, this.confirmedInputPtr), "sim_set_input(confirmed)");
    }
    if (capturePreviousRoot) this.captureConfirmedRoot();
    requireStatus(host.step(REPLAY), "sim_step(confirmed)");
    host.events(); // No confirmed presentation is ever sent to the UI.
    this.metrics.confirmedTick++;
    this.receivedTimeMs += durationMs;
    if (this.metrics.confirmedTick % 8 === 0) this.anchors.set(this.metrics.confirmedTick, this.saved());
  }
  private ticks(message: Extract<Message, { type: "ticks" }>): void {
    const m = this.metrics, started = this.now();
    this.viewTime(started);
    let reload = false;
    let lastStep: StepRecord | undefined;
    for (const record of message.records) if (record.type === "step") lastStep = record;
    for (const record of message.records) {
      m.records++;
      if (record.type === "step") {
        const used = this.predictedInputs.get(record.tick);
        const matching = used && used.length === record.inputs.length && used.every((entry, index) =>
          entry.slot === record.inputs[index]!.slot && entry.input.every((byte, offset) => byte === record.inputs[index]!.input[offset]));
        if (record.commands.length || (record.tick < this.predictionWorld.tick && !matching)) reload = true;
        this.timeline.set(record.tick, record);
        this.stepConfirmed(record, true, record === lastStep); m.ticks++;
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
          this.stepConfirmed(historical, false, tick === target - 1);
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
  private finish(consumed: number, reload: boolean, resetPresentation = false): void {
    const m = this.metrics, started = this.now(), boundary = m.confirmedTick;
    const old = this.predictionWorld.sprites[this.options.slot - 1]!;
    const oldX = old.x, oldY = old.y, oldActive = old.active, oldTick = this.predictionWorld.tick;
    const replacingPrediction = reload || this.waiting || oldTick < boundary;
    const oldFlags = old.flags, oldTeam = old.team, oldCeaseFire = old.ceaseFireCounter;
    const oldGeneration = this.localGeneration, oldRoundEpoch = this.localRoundEpoch;
    const oldFraction = this.presentationFraction, oldDecay = Math.exp(-Math.max(0, started - this.correctionAt) / 80);
    const visibleX = this.previousLocal.x + (old.x - this.previousLocal.x) * oldFraction + this.correctionX * oldDecay;
    const visibleY = this.previousLocal.y + (old.y - this.previousLocal.y) * oldFraction + this.correctionY * oldDecay;
    if (replacingPrediction) for (let point = 0; point < this.beforePose.length; point++) {
      this.beforePose[point] = old.previous[point]! + (old.current[point]! - old.previous[point]!) * oldFraction + this.correctionPose[point]! * oldDecay;
    }
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
    const previousPose = this.poses[this.poses.length - 1];
    if (previousPose) {
      const roundEpoch = this.confirmedWorld.renderView.globals.roundEpoch;
      for (let i = 0; i < this.remoteLifeTicks.length; i++) {
        const before = previousPose.sprites[i]!, after = this.confirmedWorld.sprites[i]!;
        if (previousPose.roundEpoch !== roundEpoch || previousPose.generations[i] !== this.generations[i] ||
          ((before.active || after.active) && !sameLife(before, after))) this.remoteLifeTicks[i] = boundary;
      }
    }
    const receivedAt = this.now(), stepMs = this.stepMilliseconds;
    if (!resetPresentation && previousPose && boundary > previousPose.tick) {
      const expectedMs = this.receivedTimeMs - previousPose.timeMs;
      const elapsedMs = Math.max(0, receivedAt - this.playoutReceivedAt);
      const weight = 1 - Math.exp(-expectedMs / 500);
      this.playoutJitterMs += (Math.min(stepMs * 2, Math.max(0, elapsedMs - expectedMs)) - this.playoutJitterMs) * weight;
      this.playoutCadenceTicks = Math.max(1, Math.min(8, boundary - previousPose.tick));
      this.playoutReceivedAt = receivedAt;
    }
    if (previousPose?.tick === boundary) this.poses.pop();
    this.poses.push({ tick: boundary, timeMs: this.receivedTimeMs, roundEpoch: this.confirmedWorld.renderView.globals.roundEpoch,
      generations: this.generations.slice(), sprites: this.confirmedWorld.sprites.map(copySprite) });
    if (this.poses.length > POSE_HISTORY) this.poses.shift();
    m.interpolationMs = stepMs * (this.playoutCadenceTicks + 1) + Math.min(stepMs * 2, this.playoutJitterMs * 2);
    if (resetPresentation) this.resetPlayout(receivedAt);
    for (let i = 0; i < this.ring.length; i++) {
      const frame = this.ring[i];
      if (frame && (frame.seq <= consumed || frame.tick < boundary)) this.ring[i] = undefined;
    }
    const target = this.waiting ? boundary : Math.max(boundary, oldTick);
    if (target - boundary >= INPUT_HISTORY) { this.resync(); return; }
    if (replacingPrediction) {
      const bytes = this.saved();
      requireStatus(this.options.prediction.loadState(bytes), "prediction confirmed restore");
      m.reloads++;
      this.localGeneration = this.generations[this.options.slot - 1]!;
      Object.assign(this.previousLocal, this.confirmedPreviousLocal);
      for (const tick of this.predictedInputs.keys()) if (tick >= boundary) this.predictedInputs.delete(tick);
      for (let tick = boundary; tick < target; tick++) {
        const frame = this.ring[tick % INPUT_HISTORY];
        if (diagnostic && frame?.tick !== tick) diagnostic.replayGaps.push(tick);
        this.controls(tick, frame?.tick === tick ? frame.input : undefined);
        if (tick === target - 1) {
          this.predictionWorld.sync();
          captureRoot(this.previousLocal, this.predictionWorld.sprites[this.options.slot - 1]!,
            this.predictionWorld.renderView.globals.roundEpoch, this.localGeneration);
        }
        requireStatus(this.options.prediction.step(REPLAY), "sim_step(REPLAY)"); m.replayTicks++;
      }
      this.predictionWorld.sync();
      this.updateLocalInterpolation(resetPresentation || this.waiting);
      const continuous = !resetPresentation && !this.waiting && oldTick === target && oldActive && old.active &&
        oldTeam === old.team && ((oldFlags ^ old.flags) & SPRITE_FLAGS.dead) === 0 &&
        old.ceaseFireCounter <= oldCeaseFire && oldRoundEpoch === this.localRoundEpoch && oldGeneration === this.localGeneration;
      if (continuous) {
        const t = this.presentationFraction;
        this.correctionX = visibleX - (this.previousLocal.x + (old.x - this.previousLocal.x) * t);
        this.correctionY = visibleY - (this.previousLocal.y + (old.y - this.previousLocal.y) * t);
        for (let point = 0; point < this.correctionPose.length; point++) {
          this.correctionPose[point] = this.beforePose[point]! - (old.previous[point]! + (old.current[point]! - old.previous[point]!) * t);
        }
        this.correctionAt = started;
      } else {
        this.clearCorrection();
        if (this.interpolateLocal) this.presentationGeneration++;
      }
    } else m.skippedReloads++;
    const local = this.predictionWorld.sprites[this.options.slot - 1]!;
    m.correction = 0;
    if (!this.waiting && oldTick === target && oldActive && local.active) {
      const dx = oldX - local.x, dy = oldY - local.y;
      m.correction = Math.hypot(dx, dy);
      if (m.correction > 0.001) m.corrections++;
    }
    const at = this.now();
    this.viewTime(at);
    if (this.waiting) {
      this.clockPhase = boundary + Math.min(INPUT_HISTORY - PREDICTION_SAFETY_TICKS, this.predictionRttMs / 2 / this.stepMilliseconds + m.predictionLeadTicks);
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
  private clearCorrection(): void {
    this.correctionX = 0; this.correctionY = 0; this.correctionPose.fill(0);
  }
  /** Refresh the borrowed native render memory without allocating RenderView wrappers per tick. */
  private confirmedRender(): DataView {
    const host = this.options.confirmed, pointer = requireStatus(host.exports.sim_render_view(), "sim_render_view(confirmed)");
    const buffer = host.exports.memory.buffer;
    if (!pointer) throw new Error("Confirmed render view unavailable");
    if (!this.confirmedRenderData || this.confirmedRenderData.buffer !== buffer || this.confirmedRenderData.byteOffset !== pointer) {
      this.confirmedRenderData = new DataView(buffer, pointer, RENDER_LAYOUT.totalBytes);
    }
    return this.confirmedRenderData;
  }
  /** The render ABI has native previous skeletons but no previous root. Retain
   * just the real pre-step root/identity, without copying another world or state. */
  private captureConfirmedRoot(): void {
    const data = this.confirmedRender(), base = RENDER_LAYOUT.headerBytes + (this.options.slot - 1) * RENDER_LAYOUT.spriteBytes;
    const s = RENDER_LAYOUT.sprite, out = this.confirmedPreviousLocal;
    out.flags = data.getUint32(base + s.flags, true); out.active = (out.flags & SPRITE_FLAGS.active) !== 0;
    out.x = data.getFloat32(base + s.posX, true); out.y = data.getFloat32(base + s.posY, true);
    out.team = data.getUint32(base + s.team, true); out.ceaseFireCounter = data.getInt32(base + s.ceaseFireCounter, true);
    out.roundEpoch = data.getUint32(RENDER_LAYOUT.globalsOffset + RENDER_LAYOUT.globals.roundEpoch, true);
    out.generation = this.generations[this.options.slot - 1]!;
  }
  private updateLocalInterpolation(reset = false): void {
    const local = this.predictionWorld.sprites[this.options.slot - 1]!;
    this.localRoundEpoch = this.predictionWorld.renderView.globals.roundEpoch;
    this.interpolateLocal = !reset && sameLife(this.previousLocal, local) &&
      this.previousLocal.roundEpoch === this.localRoundEpoch && this.previousLocal.generation === this.localGeneration;
    if (!this.interpolateLocal) { this.clearCorrection(); this.presentationGeneration++; }
  }
  private resetPlayout(at: number): void {
    const latest = this.poses[this.poses.length - 1], m = this.metrics;
    this.playoutTimeMs = latest?.timeMs ?? 0;
    this.playoutAt = at; this.playoutReceivedAt = at;
    this.playoutCadenceTicks = 2; this.playoutJitterMs = 0;
    this.recoveringPlayout = false;
    m.playoutPhase = latest?.tick ?? m.confirmedTick;
    this.remoteLifeTicks.fill(latest?.tick ?? m.confirmedTick);
    m.viewTick = Math.floor(m.playoutPhase);
    m.playoutReserveMs = 0; m.playoutRate = 0; m.playoutBuffering = true;
    m.interpolationMs = this.stepMilliseconds * 3;
  }
  private viewTime(at: number, publish = false): number {
    const latest = this.poses[this.poses.length - 1], m = this.metrics;
    if (!latest) return m.playoutPhase;
    const elapsed = Math.max(0, at - this.playoutAt);
    this.playoutAt = Math.max(at, this.playoutAt);
    // History eviction may force a forward seek, never an extrapolation or a
    // backwards phase correction. Ordinary arrivals/pongs cannot seek phase.
    if (this.playoutTimeMs < this.poses[0]!.timeMs) m.playoutRebases++;
    this.playoutTimeMs = Math.max(this.poses[0]!.timeMs, Math.min(latest.timeMs, this.playoutTimeMs));
    let reserve = latest.timeMs - this.playoutTimeMs;
    if (this.waiting || this.paused) m.playoutRate = 0;
    else if (m.playoutBuffering) {
      // Initial state and underruns must accumulate a real relay interval plus
      // one native step before restarting. 20 Hz therefore reserves 150 ms,
      // rather than pretending a two-tick relay always takes 33 ms.
      m.playoutRate = 0;
      if (publish && reserve >= m.interpolationMs) {
        // Release only at a render/input-view boundary, after queued ordered
        // receives have drained. A real underrun may return with stale backlog;
        // do not spend seconds at 1.1x to shed an outage. Seek forward once,
        // within received history, only when excess exceeds a whole relay.
        const cadenceMs = this.playoutCadenceTicks * this.stepMilliseconds;
        if (this.recoveringPlayout && reserve > m.interpolationMs + cadenceMs) {
          this.playoutTimeMs = latest.timeMs - m.interpolationMs; m.playoutRebases++;
        }
        this.recoveringPlayout = false;
        m.playoutBuffering = false; m.playoutRate = 1;
      }
    } else {
      const cadenceMs = this.playoutCadenceTicks * this.stepMilliseconds;
      // Normalize the relay sawtooth by receipt age. Only received occupancy
      // steers playback; RTT/2 remains exclusively in prediction scheduling.
      const receiptAge = Math.min(cadenceMs, Math.max(0, at - this.playoutReceivedAt));
      m.playoutRate = Math.max(0.9, Math.min(1.1, 1 + (reserve + receiptAge - m.interpolationMs) / 500));
      const desired = this.playoutTimeMs + elapsed * m.playoutRate;
      this.playoutTimeMs = Math.min(latest.timeMs, desired);
      if (desired > latest.timeMs + 1e-7) {
        m.playoutUnderruns++; m.playoutBuffering = true; m.playoutRate = 0;
        this.recoveringPlayout = true;
      }
    }
    reserve = latest.timeMs - this.playoutTimeMs;
    let left = this.poses[0]!, right = latest;
    for (const pose of this.poses) {
      if (pose.timeMs <= this.playoutTimeMs) left = pose;
      if (pose.timeMs >= this.playoutTimeMs) { right = pose; break; }
    }
    const alpha = left.timeMs === right.timeMs ? 1 : (this.playoutTimeMs - left.timeMs) / (right.timeMs - left.timeMs);
    m.playoutPhase = left.tick + (right.tick - left.tick) * alpha;
    m.playoutReserveMs = reserve;
    return m.playoutPhase;
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
    if (this.ping === undefined && (this.timingReady ? at - this.lastPingAt >= 1000 : at >= this.nextStartupProbeAt)) {
      this.lastPingAt = at; this.ping = BigInt(Math.floor(at * 1000)); this.options.send({ type: "ping", timestamp: this.ping });
    }
    if (this.waiting || this.paused) { this.present(); return; }
    // A reliable stream can keep arriving while all local inputs are rejected.
    // Detect sequence deadlock independently of tick-indexed retirement.
    if (this.seq - Math.max(m.lastConsumedInputSeq, this.resyncSequence) >= INPUT_HISTORY) { this.resync(); return; }
    m.stateAgeMs = at - this.lastStateAt;
    const stepMilliseconds = this.stepMilliseconds;
    if (m.stateAgeMs > INPUT_HISTORY * stepMilliseconds) { this.resync(); return; }
    m.viewTick = Math.floor(this.viewTime(at, true));
    const serverNow = m.serverTick + (m.stateAgeMs + this.predictionRttMs / 2) / stepMilliseconds;
    let elapsed = Math.max(0, at - this.clockAt);
    this.clockAt = at;
    if (!this.predictionClockPrimed && this.timingReady) {
      // Prime once from a bounded sample, or corroborate a slower sample
      // first. One-tick/second lead slewing otherwise leaves cold inputs
      // stale for seconds. Native sampling retains its four-step cap.
      this.predictionClockPrimed = true;
      // The native scale may have changed since the last probe or full state.
      m.targetPredictionLeadTicks = this.targetLeadTicks(stepMilliseconds);
      m.predictionLeadTicks = m.targetPredictionLeadTicks;
      this.clockPhase = Math.max(this.clockPhase, this.predictionWorld.tick,
        Math.min(m.serverTick + INPUT_HISTORY - PREDICTION_SAFETY_TICKS, serverNow + m.predictionLeadTicks));
      elapsed = 0; // serverNow already includes elapsed receipt time.
    }
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
      captureRoot(this.previousLocal, this.predictionWorld.sprites[this.options.slot - 1]!, this.localRoundEpoch, this.localGeneration);
      requireStatus(this.options.prediction.step(), "sim_step(prediction)");
      this.predictionWorld.sync(); this.updateLocalInterpolation(); afterStep?.();
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
    // If catch-up is bounded, show the newest completed native endpoint rather
    // than applying the fraction of a simulation tick we have not reached.
    if (this.predictionWorld.tick < desired) this.fraction = 1;
    this.present();
    m.predictedTick = this.predictionWorld.tick; m.pendingInputs = this.ring.filter(Boolean).length;
  }
  present(fraction = this.presentationFraction): WorldView {
    const at = this.now(), m = this.metrics;
    const decay = Math.exp(-Math.max(0, at - this.correctionAt) / 80);
    const latest = this.poses[this.poses.length - 1];
    if (!latest) return this.world;
    const target = this.viewTime(at, true);
    m.viewTick = Math.floor(target); m.stateAgeMs = at - this.lastStateAt;
    let a = this.poses[0]!, b = latest;
    for (const pose of this.poses) { if (pose.tick <= target) a = pose; if (pose.tick >= target) { b = pose; break; } }
    const alpha = a.tick === b.tick ? 1 : (target - a.tick) / (b.tick - a.tick);
    for (let i = 0; i < this.world.sprites.length; i++) {
      const local = i === this.options.slot - 1;
      // A new life/occupant starts at its first received pose. Holding that
      // boundary until the shared phase catches up avoids both cross-life
      // blending and a later backwards jump into the new life's older pose.
      const lifeTick = this.remoteLifeTicks[i]!;
      let lifePose: Pose | undefined;
      if (!local && lifeTick > target) {
        for (const pose of this.poses) if (pose.tick >= lifeTick) { lifePose = pose; break; }
        lifePose ??= latest;
      }
      const left = local ? this.predictionWorld.sprites[i]! : (lifePose ?? a).sprites[i]!;
      const right = local ? left : (lifePose ?? b).sprites[i]!;
      const out = this.world.sprites[i]!;
      const previous = out.previous, current = out.current;
      Object.assign(out, right, { previous, current });
      const continuous = local ? this.interpolateLocal : sameLife(left, right) &&
        a.roundEpoch === b.roundEpoch && a.generations[i] === b.generations[i];
      const t = continuous ? (local ? Math.max(0, Math.min(1, fraction)) : lifePose ? 1 : alpha) : 1;
      const dx = local ? this.correctionX * decay : 0, dy = local ? this.correctionY * decay : 0;
      const fromX = local ? this.previousLocal.x : left.x, fromY = local ? this.previousLocal.y : left.y;
      out.x = fromX + (right.x - fromX) * t + dx; out.y = fromY + (right.y - fromY) * t + dy;
      for (let p = 0; p < current.length; p++) {
        const from = local ? left.previous[p]! : left.current[p]!;
        current[p] = from + (right.current[p]! - from) * t + (local ? this.correctionPose[p]! * decay : 0);
        previous[p] = current[p]!;
      }
    }
    this.world.tick = m.viewTick;
    this.world.ceaseFireTime = this.confirmedWorld.ceaseFireTime;
    return this.world;
  }
  /** Borrowed local-projectile presentation only. Authoritative restore/replay
   * already reconciles this replica; never merge it into confirmed gameplay. */
  predictedProjectileView(): RenderView | undefined {
    if (this.disposed || this.waiting || this.paused) return undefined;
    return this.predictionWorld.renderView;
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
