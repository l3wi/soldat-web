import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { encodeDelta } from "@soldat-web/protocol";
import type { ReliableEvent } from "@soldat-web/protocol";
import { CONTROL_NAMES, loadSim, loadSimContent, requireStatus } from "@soldat-web/sim-host";
import type { Control, SimHost, SimManifest } from "@soldat-web/sim-host";
import { PlayerInputBuffer } from "./input-buffer.ts";
import type { MatchConfiguration, WorkerRequest, WorkerResponse } from "./worker-messages.ts";

interface Player {
  inputs: PlayerInputBuffer;
  baselineId: number;
  baseline: Uint8Array | undefined;
  sent: Map<number, Uint8Array>;
  events: Map<number, ReliableEvent>;
  lastEventAck: number;
  lastSentEvent: number;
}

export class AuthoritativeMatch {
  private readonly players = new Map<number, Player>();
  private snapshotId = 0;
  private eventId = 0;
  tick = 0;

  private readonly host: SimHost;
  private readonly emit: (response: WorkerResponse) => void;
  private constructor(host: SimHost, emit: (response: WorkerResponse) => void) {
    this.host = host;
    this.emit = emit;
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
      // Phase-1 host rejects unsupported AI/keyed RNG/mode flags instead of faking a match.
      requireStatus(host.init(config.rules, Number(seed & 0xffffffffn), Number(seed >> 32n), 0), "sim_init");
      requireStatus(host.loadMap(config.map), "sim_load_map");
      const state = host.saveState();
      if (typeof state === "number") throw new Error(`sim_save_state unavailable: ${state}`);
      return new AuthoritativeMatch(host, emit);
    } catch (error) { host.dispose(); throw error; }
  }

  receive(message: WorkerRequest, now: bigint): void {
    if (message.type === "stop") return;
    if (message.type === "join") {
      if (!Number.isInteger(message.slot) || message.slot < 1 || message.slot > 32 || this.players.has(message.slot)) throw new Error("Invalid player slot");
      requireStatus(this.host.command(this.tick, { kind: "join", slot: message.slot }), "sim_command(join)");
      this.players.set(message.slot, { inputs: new PlayerInputBuffer(now), baselineId: 0, baseline: undefined, sent: new Map(), events: new Map(), lastEventAck: 0, lastSentEvent: 0 });
      this.emit({ type: "joined", slot: message.slot, serverTick: this.tick });
      return;
    }
    const player = this.players.get(message.slot);
    if (message.type === "leave") {
      if (player) {
        requireStatus(this.host.command(this.tick, { kind: "leave", slot: message.slot }), "sim_command(leave)");
        this.players.delete(message.slot);
      }
      this.emit({ type: "left", slot: message.slot });
      return;
    }
    if (!player) return;
    switch (message.type) {
      case "input": {
        const rejected = player.inputs.offer(message.frames, this.tick, now);
        if (rejected.includes("rate")) this.emit({ type: "reject", slot: message.slot, reason: "Input rate limit exceeded" });
        break;
      }
      case "snapshotAck": {
        if (message.snapshotId <= player.baselineId) break;
        const baseline = player.sent.get(message.snapshotId);
        if (!baseline) {
          // A slow ACK may outlive retained candidates; keep sending against the existing baseline.
          if (message.snapshotId > this.snapshotId) this.emit({ type: "reject", slot: message.slot, reason: "Unknown snapshot acknowledgement" });
          break;
        }
        player.baselineId = message.snapshotId;
        player.baseline = baseline;
        for (const id of player.sent.keys()) if (id <= message.snapshotId) player.sent.delete(id);
        break;
      }
      case "eventAck":
        if (message.eventId <= player.lastEventAck) break;
        if (message.eventId > player.lastSentEvent) { this.emit({ type: "reject", slot: message.slot, reason: "Unknown event acknowledgement" }); break; }
        player.lastEventAck = message.eventId;
        for (const id of player.events.keys()) if (id <= message.eventId) player.events.delete(id);
        break;
      case "resync":
        player.baselineId = 0;
        player.baseline = undefined;
        player.sent.clear();
        break;
    }
  }

  step(): void {
    if (this.tick === 0xffffffff) throw new Error("Network tick space exhausted; restart match");
    for (const [slot, player] of this.players) {
      const { input } = player.inputs.consume(this.tick);
      const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      const bits = view.getUint16(0, true);
      const control: Control = { MouseAimX: view.getInt16(2, true), MouseAimY: view.getInt16(4, true), MouseDist: view.getInt16(6, true), pressOrder: view.getUint16(8, true) };
      for (let bit = 0; bit < CONTROL_NAMES.length; bit++) control[CONTROL_NAMES[bit]!] = (bits & (1 << bit)) !== 0;
      requireStatus(this.host.setInput(slot, this.tick, control), "sim_set_input");
    }
    const advanced = requireStatus(this.host.step(), "sim_step");
    if (advanced !== this.tick + 1) throw new Error(`Unexpected sim tick ${advanced}, expected ${this.tick + 1}`);
    this.tick = advanced;
    this.drainEvents();
    if (this.tick % 2 === 0) this.snapshot();
  }

  private snapshot(): void {
    if (!this.players.size) return;
    if (this.snapshotId === 0xffffffff) throw new Error("Snapshot ID space exhausted");
    const state = this.host.saveState();
    if (typeof state === "number") throw new Error(`sim_save_state failed: ${state}`);
    const id = ++this.snapshotId;
    for (const [slot, player] of this.players) {
      player.sent.set(id, state);
      while (player.sent.size > 8) player.sent.delete(player.sent.keys().next().value!);
      this.emit({ type: "send", slot, message: { type: "snapshot", serverTick: this.tick, lastConsumedInputSeq: player.inputs.lastConsumedSequence, snapshotId: id, baselineId: player.baselineId, state: encodeDelta(state, player.baseline) } });
    }
  }

  private drainEvents(): void {
    const bytes = this.host.events();
    if (typeof bytes === "number") throw new Error(`sim_events unavailable or capacity changed: ${bytes}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let batch: ReliableEvent[] = [];
    let batchBytes = 4;
    const flush = () => {
      if (!batch.length) return;
      for (const [slot, player] of this.players) {
        if (player.events.size + batch.length > 1024) { this.emit({ type: "reject", slot, reason: "Unacknowledged event backlog exceeded" }); continue; }
        for (const event of batch) player.events.set(event.id, event);
        player.lastSentEvent = batch[batch.length - 1]!.id;
        this.emit({ type: "send", slot, message: { type: "events", events: batch } });
      }
      batch = [];
      batchBytes = 4;
    };
    for (let offset = 0; offset < bytes.length;) {
      if (bytes.length - offset < 20) throw new Error("Truncated simulation event header");
      const length = view.getUint32(offset + 16, true);
      if (length > 65535 || length > bytes.length - offset - 20) throw new Error("Invalid simulation event payload length");
      if (this.eventId === 0xffffffff) throw new Error("Event ID space exhausted");
      if (batch.length === 64 || batchBytes + 28 + length > 1024 * 1024) flush();
      batch.push({ id: ++this.eventId, tick: view.getUint32(offset + 4, true), header: bytes.slice(offset, offset + 20), payload: bytes.slice(offset + 20, offset + 20 + length) });
      batchBytes += 28 + length;
      offset += 20 + length;
    }
    flush();
  }

  dispose(): void {
    this.players.clear();
    this.host.dispose();
  }
}
