import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { decodeMessage, encodeMessage, PROTOCOL_VERSION, type Message } from "@soldat-web/protocol";
import { encodeInput, loadSim, loadSimContent, requireStatus, SIM_ABI_VERSION, type SimManifest } from "@soldat-web/sim-host";
import { OnlineSession } from "../../client/src/net/session.ts";
import { arenaInput } from "./workload.ts";

export interface HeadlessWorkerOptions { url: string; wasmPath: string; contentRoot: string; manifest: SimManifest; player: number; combat: boolean; stackedCombat: boolean; pickupCombat: boolean; botDiagnostics?: number[] }
const options = workerData as HeadlessWorkerOptions;
const correctionDiagnostics = process.env.NET_G4_CORRECTION_DIAGNOSTICS === "1";
if (!parentPort) throw new Error("Headless client must run in its own worker thread");
const port = parentPort;
const wasm = new Uint8Array(await readFile(options.wasmPath));
const prediction = await loadSim(wasm), extraction = await loadSim(wasm);
await loadSimContent(prediction, options.manifest, async path => {
  const bytes = new Uint8Array(await readFile(resolve(options.contentRoot, path)));
  const id = Object.keys(options.manifest.files).find(id => options.manifest.files[id]!.path === path);
  if (!id) throw new Error("Manifest content path missing");
  requireStatus(extraction.putFile(id, bytes), "extraction content");
  return bytes;
});
let bytesSent = 0, bytesReceived = 0, stopped = false, ready = false;
let inputsSent = 0;
let lastAgeSample = 0;
let session: OnlineSession | undefined;
let timer: NodeJS.Timeout | undefined;
let snapshotInputs: { slot: number; input: Uint8Array }[] = [];
const socket = new WebSocket(options.url, { rejectUnauthorized: false, perMessageDeflate: false });
const send = (message: Message) => { const bytes = encodeMessage(message); bytesSent += bytes.length; if (message.type === "input") inputsSent++; socket.send(bytes); };
// An intent-only pickup exercise: drop the actual equipped weapon, then chase
// a real original Thing using published prediction coordinates. No trusted
// spawn/health/ammo/position commands or fabricated gameplay events are used.
const sampleInput = () => {
  const tick = session!.predictionWorld.tick;
  if (!options.pickupCombat) return arenaInput(tick, options.player, options.combat, options.stackedCombat);
  const render = prediction.renderView();
  if (typeof render === "number") throw new Error("Pickup controller has no render view");
  const local = render.sprite(session!.metrics.slot - 1);
  const phase = tick % 1200;
  if (phase < 600) return encodeInput({ Fire: phase >= 90, MouseAimX: -409, MouseAimY: -75, MouseDist: 500 });
  if (phase >= 650 && phase < 680 && local.weapon !== 255) return encodeInput({ ThrowWeapon: true, MouseAimX: Math.round(local.posX + 100), MouseAimY: Math.round(local.posY), MouseDist: 100 });
  let nearest: { x: number; y: number; distance: number } | undefined;
  if (local.weapon === 255) for (let index = 0; index < render.thingCount; index++) {
    const thing = render.thing(index);
    if (thing.style < 4 || thing.style > 14 || thing.holdingSprite) continue;
    const distance = Math.hypot(thing.posX - local.posX, thing.posY - local.posY);
    if (!nearest || distance < nearest.distance) nearest = { x: thing.posX, y: thing.posY, distance };
  }
  const dx = nearest ? nearest.x - local.posX : 0, dy = nearest ? nearest.y - local.posY : 0;
  return encodeInput({ Left: dx < -2, Right: dx > 2, Up: dy < -15, Jetpack: dy < -50 && Math.abs(dx) < 80, MouseAimX: Math.round(local.posX + 100), MouseAimY: Math.round(local.posY), MouseDist: 100 });
};
const fail = (error: unknown) => {
  port.postMessage({ type: "failure", player: options.player, error: error instanceof Error ? error.stack : String(error) });
  stopped = true; clearInterval(timer); socket.terminate(); session?.dispose();
};
socket.on("open", () => send({ type: "hello", protocolVersion: PROTOCOL_VERSION, contentSetHash: Buffer.from(options.manifest.sha256, "hex"), simAbiVersion: SIM_ABI_VERSION, nickname: `Rig-${options.player}`, weapon: 4, secondaryWeapon: 0 }));
socket.on("message", data => {
  if (stopped) return;
  try {
    const packet = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    bytesReceived += packet.length;
    const message = decodeMessage(packet);
    if (message.type === "welcome") {
      if (session) throw new Error("Repeated welcome");
      const rules = JSON.parse(new TextDecoder().decode(message.rules)) as Record<string, unknown>;
      for (const host of [prediction, extraction]) {
        requireStatus(host.init({ ...rules, ai: false }, Number(message.matchSeed & 0xffffffffn), Number(message.matchSeed >> 32n), 0), "sim_init(headless welcome)");
        requireStatus(host.loadMap(message.map), "sim_load_map(headless welcome)");
      }
      const appliedEvents = new Set<number>();
      session = new OnlineSession({ prediction, extraction, slot: message.slot, send,
        onSnapshot: metrics => {
          port.postMessage({ type: "snapshot", player: options.player, at: performance.now(), metrics, bytesSent, bytesReceived, inputsSent });
          if (options.botDiagnostics) {
            const view = session!.authoritativeRenderView();
            const bots = [];
            for (let index = 0; index < 32; index++) {
              const sprite = view.sprite(index);
              if (!options.botDiagnostics.includes(sprite.slot)) continue;
              const input = snapshotInputs.find(entry => entry.slot === sprite.slot)?.input;
              bots.push({ slot: sprite.slot, name: sprite.playerName, team: sprite.team, kills: sprite.kills, deaths: sprite.deaths, x: sprite.posX, y: sprite.posY, fired: sprite.fired, controlBits: sprite.controlBits, aimX: sprite.aimX, aimY: sprite.aimY, mouseDist: sprite.mouseDist, waypoint: sprite.currentWaypoint, input: input ? [...input] : null });
            }
            const projectiles = [];
            for (let index = 0; index < view.bulletCount; index++) {
              const bullet = view.bullet(index);
              if (options.botDiagnostics.includes(bullet.owner)) projectiles.push(bullet.owner);
            }
            const humanTeams = [view.sprite(0).team, view.sprite(1).team];
            port.postMessage({ type: "bots", player: options.player, tick: view.tick, hash: metrics.snapshotHash, bots, projectiles,
              humanTeams, teamScores: [...view.globals.teamScores],
              thingStyles: Array.from({ length: view.thingCount }, (_, index) => view.thing(index).style) });
          }
          if (!ready) { ready = true; port.postMessage({ type: "ready", player: options.player, slot: message.slot }); }
        },
        onCorrection: correctionDiagnostics ? diagnostic => {
          port.postMessage({ type: "correction-diagnostic", player: options.player, at: performance.now(), diagnostic });
        } : undefined,
        onEvent: event => {
          const duplicate = appliedEvents.has(event.id); appliedEvents.add(event.id);
          port.postMessage({ type: "logical-event", player: options.player, id: event.id, tick: event.tick, kind: new DataView(event.header.buffer, event.header.byteOffset).getUint32(0, true), duplicate });
        },
      });
      timer = setInterval(() => {
        try {
          session!.advance(sampleInput);
          session!.present();
          if (performance.now() - lastAgeSample >= 250) {
            lastAgeSample = performance.now();
            port.postMessage({ type: "render-age", player: options.player, at: lastAgeSample, metrics: session!.metrics, bytesSent, bytesReceived, inputsSent });
          }
        } catch (error) { fail(error); }
      }, 4);
    } else if (session) {
      if (message.type === "snapshot") snapshotInputs = message.inputs;
      session.receive(message);
    }
    else if (message.type === "ping") send({ type: "pong", timestamp: message.timestamp });
    else throw new Error(`Unexpected ${message.type} before welcome`);
  } catch (error) { fail(error); }
});
socket.on("error", error => { if (!stopped) fail(error); });
socket.on("close", (code, reason) => { if (!stopped) fail(new Error(`WSS closed ${code}: ${reason.toString()}`)); });
port.on("message", message => {
  if (message.type === "weapon-choice" && !stopped && ready) {
    send({ type: "weapon-choice", primary: message.primary, secondary: message.secondary, selection: message.selection });
    return;
  }
  if (message.type !== "stop" || stopped) return;
  stopped = true; clearInterval(timer);
  port.postMessage({ type: "final", player: options.player, metrics: session?.metrics ?? null, bytesSent, bytesReceived, inputsSent, memory: process.memoryUsage() });
  socket.close(); session?.dispose(); port.close();
});
