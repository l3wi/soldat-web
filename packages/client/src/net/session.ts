import { requireStatus, type RenderView, type SimHost } from "@soldat-web/sim-host";
import { decodeDelta, type InputFrame, type Message, type ReliableEvent } from "@soldat-web/protocol";
import { SimWorldView, type WorldSprite, type WorldView } from "../world.ts";
import { SnapshotBaselines } from "./baselines.ts";

type Snapshot = Extract<Message, { type: "snapshot" }>;
export const INPUT_HISTORY = 128;
export const REPLAY = 1;
const STEP_MS = 1000 / 60;
/** Holding a remote control must never repeat a grenade/switch/reload/etc edge. */
export function heldInput(input: Uint8Array): Uint8Array {
  const held = input.slice(); held[0] = held[0]! & 0x3f; held[1] = 0; return held;
}
export interface OnlineMetrics {
  status: string; slot: number; serverTick: number; predictedTick: number; viewTick: number;
  rttMs: number; loss: number; snapshotAgeMs: number; interpolationMs: number;
  correction: number; corrections: number; replayTicks: number; resyncs: number;
  snapshotId: number; snapshotTick: number; snapshotHash: string; loadedHash: string;
  hashMatches: number; hashMismatches: number; snapshots: number; events: number;
  pendingInputs: number; baselineBytes: number; extractionMs: number; reconcileMs: number;
  lastConsumedInputSeq: number; replayLength: number; duplicateEvents: number; eventGaps: number;
}
export interface OnlineOptions {
  prediction: SimHost; extraction: SimHost; slot: number; send(message: Message): void;
  now?: () => number; onEvent?: (event: ReliableEvent) => void;
  onSnapshot?: (metrics: Readonly<OnlineMetrics>) => void;
  /** Borrowed event records, presentation kinds only; never emitted on REPLAY. */
  onPresentation?: (bytes: Uint8Array) => void;
}
interface Pose { tick: number; sprites: WorldSprite[] }
function copySprite(sprite: WorldSprite): WorldSprite {
  return { ...sprite, previous: sprite.previous.slice(), current: sprite.current.slice() };
}
/** A bounded full-state rollback client. Hosts are real, separately initialized
 * WASM instances; extraction never steps and prediction never invents poses. */
export class OnlineSession {
  readonly predictionWorld: SimWorldView;
  readonly world: { sprites: WorldSprite[]; tick: number; ceaseFireTime?: number; sync(): void };
  readonly metrics: OnlineMetrics;
  private readonly extractionWorld: SimWorldView;
  private readonly now: () => number;
  private readonly ring: (InputFrame | undefined)[] = new Array(INPUT_HISTORY);
  private readonly recent: InputFrame[] = [];
  private readonly baselines = new SnapshotBaselines();
  private readonly poses: Pose[] = [];
  private remote: { slot: number; input: Uint8Array }[] = [];
  private seq = 0;
  private resyncSequence = 0;
  private lastEvent = 0;
  private lastSnapshotAt = 0;
  private lastPresentAt = 0;
  private lastPingAt = -Infinity;
  private ping: bigint | undefined;
  private waiting = true;
  private resyncRequested = false;
  private correctionX = 0;
  private correctionY = 0;
  private jitter = 0;
  private inputPtr: number;
  private eventPtr: number;
  private readonly eventCapacity = 1_048_576;
  private gapSnapshots = 0;
  private fraction = 1;
  private disposed = false;
  private readonly options: OnlineOptions;
  constructor(options: OnlineOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.predictionWorld = new SimWorldView(options.prediction);
    this.extractionWorld = new SimWorldView(options.extraction);
    this.world = { sprites: this.predictionWorld.sprites.map(copySprite), tick: 0, sync() {} };
    this.inputPtr = requireStatus(options.prediction.exports.sim_alloc(12), "sim_alloc(online input)");
    this.eventPtr = requireStatus(options.prediction.exports.sim_alloc(this.eventCapacity), "sim_alloc(online events)");
    if (!this.inputPtr || !this.eventPtr) throw new Error("Online buffer allocation failed");
    this.metrics = { status: "awaiting snapshot", slot: options.slot, serverTick: 0, predictedTick: 0, viewTick: 0,
      rttMs: 0, loss: 0, snapshotAgeMs: 0, interpolationMs: 50, correction: 0, corrections: 0,
      replayTicks: 0, resyncs: 0, snapshotId: 0, snapshotTick: 0, snapshotHash: "", loadedHash: "",
      hashMatches: 0, hashMismatches: 0, snapshots: 0, events: 0, pendingInputs: 0, baselineBytes: 0, extractionMs: 0, reconcileMs: 0,
      lastConsumedInputSeq: 0, replayLength: 0, duplicateEvents: 0, eventGaps: 0 };
  }
  receive(message: Message): void {
    if (this.disposed) return;
    if (message.type === "ping") { this.options.send({ type: "pong", timestamp: message.timestamp }); return; }
    if (message.type === "pong") {
      if (this.ping === message.timestamp) {
        const rtt = Math.max(0, this.now() - Number(message.timestamp) / 1000);
        this.metrics.rttMs = this.metrics.rttMs ? this.metrics.rttMs * 0.8 + rtt * 0.2 : rtt;
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
    if (message.type === "snapshot") this.snapshot(message);
  }
  private resync(baselineId = 0): void {
    if (!this.resyncRequested) {
      this.resyncRequested = true; this.metrics.resyncs++;
      this.options.send({ type: "resync", baselineId });
    }
    this.waiting = true; this.metrics.status = "resynchronizing";
    this.resyncSequence = this.seq;
    this.ring.fill(undefined); this.recent.length = 0; this.metrics.pendingInputs = 0;
  }
  private snapshot(message: Snapshot): void {
    const m = this.metrics;
    if (message.snapshotId <= m.snapshotId) return;
    // All deltas already queued before the recovery request belong to the old
    // baseline epoch. Only the requested fullstate can reopen prediction.
    if (this.resyncRequested && message.baselineId !== 0) return;
    const baseline = this.baselines.get(message.baselineId);
    if (message.baselineId && !baseline) {
      this.resync(message.baselineId); return;
    }
    const started = this.now();
    const state = decodeDelta(message.state, baseline);
    const old = this.predictionWorld.sprites[this.options.slot - 1]!;
    const oldX = old.x, oldY = old.y, oldTick = this.predictionWorld.tick;
    requireStatus(this.options.extraction.loadState(state), "snapshot extraction load");
    const extractedHash = this.options.extraction.hash();
    requireStatus(this.options.prediction.loadState(state), "prediction restore");
    const hash = this.options.prediction.hash(), expected = message.stateHash.toString(16).padStart(16, "0");
    m.snapshotHash = expected; m.loadedHash = hash; m.snapshotTick = message.serverTick;
    if (hash !== expected || extractedHash !== expected) {
      m.hashMismatches++; this.resync();
      throw new Error(`Authoritative snapshot hash mismatch at tick ${message.serverTick}: ${hash}/${extractedHash} != ${expected}`);
    }
    m.hashMatches++;
    this.extractionWorld.sync();
    if (this.extractionWorld.tick !== message.serverTick) throw new Error("Snapshot/render tick mismatch");
    this.poses.push({ tick: message.serverTick, sprites: this.extractionWorld.sprites.map(copySprite) });
    if (this.poses.length > 16) this.poses.shift();
    m.extractionMs = this.now() - started;
    if (this.resyncRequested) this.baselines.clear();
    const acknowledge = this.baselines.retain(message.snapshotId, message.baselineId, state);
    m.baselineBytes = this.baselines.bytes;
    this.remote = message.inputs.map(entry => ({ slot: entry.slot, input: heldInput(entry.input) }));
    for (let i = 0; i < this.ring.length; i++) {
      const frame = this.ring[i];
      if (frame && (frame.seq <= message.lastConsumedInputSeq || frame.tick < message.serverTick)) this.ring[i] = undefined;
    }
    this.predictionWorld.sync();
    const target = this.waiting ? message.serverTick : Math.max(message.serverTick, oldTick);
    if (target - message.serverTick > INPUT_HISTORY) { this.resync(); return; }
    for (let tick = message.serverTick; tick < target; tick++) {
      const frame = this.ring[tick % INPUT_HISTORY];
      this.controls(tick, frame?.tick === tick ? frame.input : undefined);
      requireStatus(this.options.prediction.step(REPLAY), "sim_step(REPLAY)"); m.replayTicks++;
    }
    this.predictionWorld.sync();
    const local = this.predictionWorld.sprites[this.options.slot - 1]!;
    if (!this.waiting && oldTick === target && old.active && local.active) {
      const dx = oldX - local.x, dy = oldY - local.y;
      m.correction = Math.hypot(dx, dy);
      if (m.correction > 0.001) { m.corrections++; this.correctionX += dx; this.correctionY += dy; }
    }
    const at = this.now();
    if (m.snapshots) {
      const elapsed = at - this.lastSnapshotAt, expectedMs = (message.serverTick - m.serverTick) * STEP_MS;
      this.jitter = this.jitter * 0.9 + Math.abs(elapsed - expectedMs) * 0.1;
      const desiredDelay = Math.max(33, Math.min(100, 33 + this.jitter * 2));
      m.interpolationMs += (desiredDelay - m.interpolationMs) * 0.1;
      this.gapSnapshots += Math.max(0, message.snapshotId - m.snapshotId - 1);
    }
    m.snapshotId = message.snapshotId; m.serverTick = message.serverTick; m.snapshots++;
    m.loss = this.gapSnapshots / Math.max(1, this.gapSnapshots + m.snapshots);
    this.lastSnapshotAt = at; this.waiting = false; this.resyncRequested = false; m.status = "online";
    m.predictedTick = this.predictionWorld.tick; m.pendingInputs = this.ring.filter(Boolean).length;
    if (m.snapshots === 1) m.viewTick = message.serverTick;
    m.lastConsumedInputSeq = message.lastConsumedInputSeq; m.replayLength = target - message.serverTick;
    m.reconcileMs = this.now() - started;
    if (acknowledge) this.options.send({ type: "snapshotAck", snapshotId: message.snapshotId });
    this.options.onSnapshot?.(m);
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
  }
  /** Called per display frame. Clock debt never becomes variable simulation dt. */
  advance(sample: () => Uint8Array, beforeStep?: () => void, afterStep?: () => void): void {
    if (this.disposed) return;
    const at = this.now(), m = this.metrics;
    if (at - this.lastPingAt >= 1000) {
      this.lastPingAt = at; this.ping = BigInt(Math.floor(at * 1000)); this.options.send({ type: "ping", timestamp: this.ping });
    }
    if (this.waiting) return;
    // Snapshots can keep arriving while every input is rejected (for example,
    // an initial TCP backlog can exhaust the bounded sequence jump). Tick-
    // indexed ring retirement alone cannot detect this sequence deadlock.
    if (this.seq - Math.max(m.lastConsumedInputSeq, this.resyncSequence) >= INPUT_HISTORY) { this.resync(); return; }
    m.snapshotAgeMs = at - this.lastSnapshotAt;
    if (m.snapshotAgeMs > INPUT_HISTORY * STEP_MS) { this.resync(); return; }
    this.present();
    const serverNow = m.serverTick + (m.snapshotAgeMs + m.rttMs / 2) / STEP_MS;
    const phase = Math.min(m.serverTick + 16, serverNow + m.rttMs / 2 / STEP_MS + 2);
    const desired = Math.min(Math.floor(phase), m.viewTick + 18);
    this.fraction = phase >= m.serverTick + 16 ? 1 : phase - desired;
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
      m.serverTick + (at - this.lastSnapshotAt + m.rttMs / 2 - m.interpolationMs) / STEP_MS));
    m.viewTick = Math.floor(target); m.snapshotAgeMs = at - this.lastSnapshotAt;
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
    this.world.ceaseFireTime = this.extractionWorld.ceaseFireTime;
    return this.world;
  }
  /** Latest authoritative (not predicted) bullets/Things, borrowed until the
   * next snapshot load. Consume synchronously and never write these arrays. */
  authoritativeRenderView(): RenderView {
    const view = this.options.extraction.renderView();
    if (typeof view === "number") throw new Error(`Authoritative render view unavailable: ${view}`);
    return view;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.prediction.exports.sim_free(this.inputPtr); this.options.prediction.exports.sim_free(this.eventPtr);
    this.options.prediction.dispose(); this.options.extraction.dispose();
    this.baselines.clear(); this.poses.length = 0; this.ring.fill(undefined); this.metrics.status = "closed";
  }
}
