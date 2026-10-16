import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FROZEN_WASM_SHA256, Evidence, delay, json, qualificationServer } from "./support.ts";
import { ACCEPTANCE_PROFILE, packetGateway, type PacketProfile } from "./impairment.ts";
import { distribution } from "./workload.ts";
import type { OnlineMetrics } from "../../client/src/net/session.ts";
import { SIM_ABI_VERSION } from "@soldat-web/sim-host";

export interface RigOptions { players: number; targetPlayers?: number; seconds: number; out: string; impaired: boolean; combat: boolean; browserPlayers: number; port: number; gatewayPort: number; profile?: PacketProfile; stackedCombat?: boolean; pickupCombat?: boolean }
export interface ClientSample { type: string; player: number; at?: number; measurementElapsedMs?: number; metrics?: OnlineMetrics; bytesSent?: number; bytesReceived?: number; inputsSent?: number; visibility?: string; renders?: number; error?: string; duplicate?: boolean; id?: number; tick?: number; kind?: number }
interface ClientSeries {
  corrections: number[]; receiptAge: number[]; estimatedAge: number[]; rtt: number[];
  first: ClientSample; visibleSamples: number; hiddenSamples: number; firstRenders?: number;
}

export async function runRig(options: RigOptions) {
  if (!Number.isInteger(options.players) || options.players < 2 || options.players > 32 || options.browserPlayers < 0 || options.browserPlayers > options.players || !Number.isFinite(options.seconds) || options.seconds <= 0) throw new Error("Require 2..32 humans, positive seconds, and valid browser player count");
  await mkdir(options.out, { recursive: true });
  const raw = new Evidence(resolve(options.out, "clients.jsonl"));
  const rig = await qualificationServer(options.out, options.port, options.targetPlayers);
  const errors: string[] = [], workers: Worker[] = [];
  const series = new Map<number, ClientSeries>();
  const finals: ClientSample[] = [];
  let logicalEvents = 0, duplicateApplications = 0, eventGaps = 0;
  const lastEvents = new Map<number, number>();
  const appliedEvents = new Map<number, Set<number>>();
  const appliedKinds: Record<string, number> = {};
  const profile = options.profile ?? ACCEPTANCE_PROFILE;
  let startAt = 0;
  const gateway = options.impaired ? await packetGateway(Number(new URL(rig.url).port), options.gatewayPort, profile, rig.evidence).catch(async error => { await rig.close(); await raw.close(); throw error; }) : undefined;
  const url = gateway?.url ?? rig.url;
  const memoryTimer = setInterval(() => rig.evidence.record({ type: "process-memory", ...process.memoryUsage() }), 10_000);
  const collect = (message: ClientSample) => {
    raw.record(message);
    if (message.type === "failure") errors.push(message.error ?? "Unknown headless failure");
    if ((message.type === "ticks" || message.type === "render-age") && message.metrics && (message.measurementElapsedMs === undefined ? startAt > 0 : message.measurementElapsedMs > 2000)) {
      const data: ClientSeries = series.get(message.player) ?? { corrections: [], receiptAge: [], estimatedAge: [], rtt: [], first: message, visibleSamples: 0, hiddenSamples: 0 };
      if (message.visibility === "visible") data.visibleSamples++;
      else if (message.visibility !== undefined) data.hiddenSamples++;
      if (message.renders !== undefined && data.firstRenders === undefined) data.firstRenders = message.renders;
      if (message.type === "ticks") data.corrections.push(message.metrics.correction);
      else {
        data.receiptAge.push(message.metrics.stateAgeMs);
        data.estimatedAge.push(message.metrics.stateAgeMs + message.metrics.rttMs / 2); data.rtt.push(message.metrics.rttMs);
      }
      series.set(message.player, data);
    }
    if (message.type === "final") finals.push(message);
    if (message.type === "logical-event") {
      logicalEvents++; if (message.duplicate) duplicateApplications++;
      const previous = lastEvents.get(message.player);
      if (previous !== undefined && message.id !== previous + 1) eventGaps++;
      const ids = appliedEvents.get(message.player) ?? new Set<number>();
      ids.add(message.id!); appliedEvents.set(message.player, ids);
      if (message.kind !== undefined) appliedKinds[message.kind] = (appliedKinds[message.kind] ?? 0) + 1;
      lastEvents.set(message.player, message.id!);
    }
  };
  const cancellation = new AbortController();
  const stop = () => cancellation.abort(new Error("Networking qualification interrupted"));
  const interrupted = new Promise<never>((_resolve, reject) => cancellation.signal.addEventListener("abort", () => reject(cancellation.signal.reason), { once: true }));
  interrupted.catch(() => {});
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    const ready: Promise<void>[] = [];
    for (let player = options.browserPlayers + 1; player <= options.players; player++) {
      const worker = new Worker(new URL("./headless-worker.ts", import.meta.url), { workerData: { url, wasmPath: rig.match.wasmPath, contentRoot: rig.match.contentRoot, manifest: rig.manifest, player, combat: options.combat, stackedCombat: options.stackedCombat ?? false, pickupCombat: options.pickupCombat ?? false } });
      workers.push(worker);
      worker.on("message", collect);
      worker.on("error", error => { errors.push(error.stack ?? error.message); raw.record({ type: "worker-error", player, error: error.stack ?? error.message }); });
      ready.push(new Promise<void>((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Player ${player} admission timed out`)), 60_000);
        const listener = (message: ClientSample) => {
          if (message.type === "ready") { clearTimeout(timeout); worker.off("message", listener); resolveReady(); }
          else if (message.type === "failure") { clearTimeout(timeout); reject(new Error(message.error)); }
        };
        worker.on("message", listener);
      }));
    }
    console.log(json({ type: "rig-listening", url, out: options.out, browserPlayers: options.browserPlayers, players: options.players, seconds: options.seconds }));
    if (options.browserPlayers) {
      const deadline = performance.now() + 120_000;
      let browserReady = false;
      while (performance.now() < deadline) {
        if (await stat(resolve(options.out, "browser-ready.json")).then(() => true, () => false)) { browserReady = true; break; }
        await Promise.race([delay(50), interrupted]);
      }
      if (!browserReady) throw new Error("Real browsers did not signal admission");
    }
    await Promise.race([Promise.all(ready), interrupted]);
    await Promise.race([delay(2000), interrupted]);
    const metricsStartIndex = rig.metrics.length;
    startAt = performance.now();
    rig.evidence.record({ type: "measurement-start", options, warmupSeconds: 2, wasmSha256: FROZEN_WASM_SHA256, runtime: process.version, platform: process.platform, architecture: process.arch, memory: process.memoryUsage() });
    console.log(json({ type: "rig-started", out: options.out, seconds: options.seconds }));
    const end = startAt + options.seconds * 1000;
    while (performance.now() < end) {
      if (errors.length) throw new Error(errors[0]);
      await Promise.race([delay(Math.max(0, Math.min(1000, end - performance.now()))), interrupted]);
    }
    const elapsed = (performance.now() - startAt) / 1000;
    const metricsEndIndex = rig.metrics.length;
    const measurementEndMemory = process.memoryUsage();
    for (const worker of workers) worker.postMessage({ type: "stop" });
    await Promise.all(workers.map(worker => once(worker, "exit")));
    if (options.browserPlayers) {
      const deadline = performance.now() + 15_000;
      let bytes: string | undefined;
      while (performance.now() < deadline) {
        bytes = await readFile(resolve(options.out, "browser-results.json"), "utf8").catch(() => undefined);
        if (bytes) break;
        await Promise.race([delay(50), interrupted]);
      }
      if (!bytes) throw new Error("Real browser evidence was not collected");
      const browser = JSON.parse(bytes) as { samples: ClientSample[]; finals: ClientSample[]; events: ClientSample[]; errors: string[] };
      for (const sample of browser.samples) collect(sample);
      for (const event of browser.events) collect(event);
      finals.push(...browser.finals); errors.push(...browser.errors);
    }
    const perPlayer = Array.from({ length: options.players }, (_, index) => {
      const player = index + 1, data = series.get(player);
      const last = finals.find(sample => sample.player === player), m = last?.metrics;
      const first = data?.first;
      const corrections = data?.corrections ?? [];
      const largeCorrections = corrections.filter(value => value > 10).length;
      const seconds = Math.max(1, elapsed);
      return { player, samples: corrections.length, corrections: distribution(corrections), correctionsOver10: largeCorrections, correctionsOver10PerMinute: largeCorrections * 60 / seconds,
        relayReceiptAgeMs: distribution(data?.receiptAge ?? []), estimatedRelayAgeMs: distribution(data?.estimatedAge ?? []), rttMs: distribution(data?.rtt ?? []),
        bytesPerSecondSent: last?.bytesSent === undefined || first?.bytesSent === undefined ? null : (last.bytesSent - first.bytesSent) / seconds,
        bytesPerSecondReceived: last?.bytesReceived === undefined || first?.bytesReceived === undefined ? null : (last.bytesReceived - first.bytesReceived) / seconds,
        inputFramesPerSecond: last?.inputsSent === undefined || first?.inputsSent === undefined ? null : (last.inputsSent - first.inputsSent) / seconds,
        consumedSequenceAdvance: m ? m.lastConsumedInputSeq - (first?.metrics?.lastConsumedInputSeq ?? 0) : 0,
        visibleSamples: data?.visibleSamples ?? 0, hiddenSamples: data?.hiddenSamples ?? 0,
        observedRendersPerSecond: last?.renders === undefined || data?.firstRenders === undefined ? null : (last.renders - data.firstRenders) / seconds,
        final: m ?? null };
    });
    const cutoffTick = Math.min(...perPlayer.map(player => player.final?.confirmedTick ?? 0)) - 120;
    const serverKinds: Record<string, number> = {};
    let serverEnqueuedLogicalEvents = 0, missingAppliedEvents = 0;
    for (const player of perPlayer) {
      const expected = new Map<number, number>();
      for (const event of rig.enqueuedEvents) {
        if (event.slot === player.final?.slot && event.tick <= cutoffTick) expected.set(event.id, event.kind);
      }
      serverEnqueuedLogicalEvents += expected.size;
      for (const [id, kind] of expected) {
        serverKinds[kind] = (serverKinds[kind] ?? 0) + 1;
        if (!appliedEvents.get(player.player)?.has(id)) missingAppliedEvents++;
      }
    }
    const measuredMetrics = rig.metrics.slice(metricsStartIndex, metricsEndIndex);
    const simEncodeMs = distribution(measuredMetrics.flatMap(sample => sample.simEncodeMs));
    const tickLatenessMs = distribution(measuredMetrics.flatMap(sample => sample.tickLatenessMs));
    const wireEncodeMs = distribution(measuredMetrics.flatMap(sample => (sample as typeof sample & { wireEncodeMs?: number[] }).wireEncodeMs ?? []));
    const workerSimEncodeMs = distribution(measuredMetrics.flatMap(sample => (sample as typeof sample & { workerSimEncodeMs?: number[] }).workerSimEncodeMs ?? []));
    const packetCounters = await gateway?.stats();
    const result = {
      type: "net-g4-qualification", version: 1, wasmSha256: FROZEN_WASM_SHA256, simAbiVersion: SIM_ABI_VERSION, map: "Arena", contentSetHash: rig.manifest.sha256,
      runtime: process.version, options, warmupSeconds: 2, elapsedSeconds: elapsed, finalProcessMemory: measurementEndMemory, packetImpairment: gateway ? { ...profile, nominalAddedRttMs: profile.uplinkDelayMs + profile.downlinkDelayMs, actualKernelCounters: packetCounters } : null,
      simEncodeMs, workerSimEncodeMs, wireEncodeMs, tickLatenessMs, replayMs: distribution(measuredMetrics.flatMap(sample => sample.replayMs)), replayTicks: measuredMetrics.reduce((sum, sample) => sum + sample.replayTicks, 0),
      uncompensatedShots: measuredMetrics.reduce((sum, sample) => sum + sample.uncompensatedShots, 0),
      diagnosticProfiling: process.env.NET_G4_PROFILE === "1",
      inputBufferOccupancy: distribution(measuredMetrics.flatMap(sample => sample.inputBufferOccupancy)),
      inputBufferLeadTicks: distribution(measuredMetrics.flatMap(sample => sample.inputBufferLeadTicks)),
      metricDefinitions: { simEncodeMs: "Per server tick, worker sim+sparse-save+record encoding and main-thread wire encode CPU work summed; not cross-thread elapsed time", wireEncodeMs: "Individual protocol packet encoding CPU cost", relayReceiptAgeMs: "Latest real presentation's elapsed time since ordered relay arrival, sampled at 4 Hz", estimatedRelayAgeMs: "Presentation receipt age + smoothed RTT/2; assumes symmetric delay, not synchronized server/client clocks", bytesPerSecond: "Binary protocol payload bytes; excludes WebSocket/TLS/IP overhead", memory: "Process RSS includes server/client workers; raw JSONL streamed, only numeric quantile samples retained by harness" },
      logicalEvents, duplicateApplications, eventGaps, serverEnqueuedLogicalEvents, missingAppliedEvents, eventEvidence: { cutoffTick, cutoffDefinition: "Oldest final confirmed tick minus 120 ticks; later event delivery is not claimed complete", serverEnqueuedKindHistogram: serverKinds, appliedKindHistogram: appliedKinds, note: "Per-slot server transport enqueue including retransmissions, deduplicated by ID, compared to client logical callback IDs in this committed prefix" }, players: perPlayer, errors: [...errors, ...rig.errors],
      gates: {
        correctionP95Under2: options.combat ? null : perPlayer.every(player => player.corrections.p95 !== null && player.corrections.p95 < 2),
        correctionOver10UnderOnePerMinuteEachPlayer: options.combat ? null : perPlayer.every(player => player.samples > 0 && player.correctionsOver10PerMinute < 1),
        sameTickAuthoritativeHash: perPlayer.every(player => player.final && player.final.hashMatches > 0 && player.final.hashMismatches === 0),
        authoritativeInputProgress: perPlayer.every(player => player.consumedSequenceAdvance > 0 && player.inputFramesPerSecond !== null && player.inputFramesPerSecond > 0),
        browserVisibilityAndRenderProgress: options.browserPlayers ? perPlayer.slice(0, options.browserPlayers).every(player => player.visibleSamples > 0 && player.hiddenSamples === 0 && player.observedRendersPerSecond !== null && player.observedRendersPerSecond > 0) : null,
        simEncodeP99Under8ms: simEncodeMs.p99 !== null && simEncodeMs.p99 < 8,
        tickLatenessP99Under4ms: tickLatenessMs.p99 !== null && tickLatenessMs.p99 < 4,
        reliableEventsExactlyOnce: logicalEvents && serverEnqueuedLogicalEvents ? duplicateApplications === 0 && eventGaps === 0 && missingAppliedEvents === 0 : null,
        noServerOrClientErrors: !errors.length && !rig.errors.length,
        humanPlay: "pending: automated inputs are not two humans playing",
        nextRenderedFrameLocalResponse: "pending: requires physical display/input latency evidence",
      },
    };
    await writeFile(resolve(options.out, "summary.json"), `${json(result)}\n`);
    console.log(json({ type: "rig-summary", ...result.gates, out: options.out }));
    return result;
  } catch (error) {
    raw.record({ type: "rig-failure", error: error instanceof Error ? error.stack : String(error) });
    await writeFile(resolve(options.out, "failure.json"), `${json({ error: error instanceof Error ? error.stack : String(error), options, errors })}\n`);
    throw error;
  } finally {
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
    clearInterval(memoryTimer);
    await Promise.all(workers.map(worker => worker.terminate()));
    try { await gateway?.close(); } finally { await rig.close(); await raw.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i]!;
    if (["--impaired", "--combat", "--stacked-combat", "--pickup-combat"].includes(name)) values.set(name, "true");
    else values.set(name, process.argv[++i] ?? "");
  }
  const profile: PacketProfile = values.has("--profile")
    ? JSON.parse(await readFile(resolve(values.get("--profile")!), "utf8")) as PacketProfile
    : { uplinkDelayMs: Number(values.get("--up-delay-ms") ?? Number(values.get("--rtt-ms") ?? 100) / 2), downlinkDelayMs: Number(values.get("--down-delay-ms") ?? Number(values.get("--rtt-ms") ?? 100) / 2), jitterMs: Number(values.get("--jitter-ms") ?? 15), lossPercent: Number(values.get("--loss-percent") ?? 1) };
  if (values.has("--up-kbps")) profile.uplinkKbps = Number(values.get("--up-kbps"));
  if (values.has("--down-kbps")) profile.downlinkKbps = Number(values.get("--down-kbps"));
  if (values.has("--burst-packets")) {
    const endPercent = 100 / Number(values.get("--burst-packets"));
    profile.burst = { startPercent: profile.lossPercent * endPercent / (100 - profile.lossPercent), endPercent, lossInBurstPercent: 100, lossOutsidePercent: 0 };
  }
  if (values.has("--outage-ms")) profile.outage = { durationMs: Number(values.get("--outage-ms")), atSeconds: Number(values.get("--outage-at-seconds") ?? 10) };
  const options: RigOptions = { players: Number(values.get("--players") ?? 2), seconds: Number(values.get("--seconds") ?? 60), out: resolve(values.get("--out") ?? "build-out/net-g4/lan-2"), impaired: values.has("--impaired") || values.has("--profile"), combat: values.has("--combat") || values.has("--stacked-combat") || values.has("--pickup-combat"), stackedCombat: values.has("--stacked-combat"), pickupCombat: values.has("--pickup-combat"), browserPlayers: Number(values.get("--browser-players") ?? 0), port: Number(values.get("--port") ?? 9443), gatewayPort: Number(values.get("--gateway-port") ?? 9444), profile };
  if (values.has("--target-players")) options.targetPlayers = Number(values.get("--target-players"));
  await runRig(options);
}
