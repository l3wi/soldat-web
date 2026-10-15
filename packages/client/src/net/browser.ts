import { loadSim, loadSimContent, requireStatus, sha256, SIM_ABI_VERSION, type SimHost, type SimManifest } from "@soldat-web/sim-host";
import { decodeMessage, encodeMessage, PROTOCOL_VERSION, type Message, type ReliableEvent } from "@soldat-web/protocol";
import { connectWss, type MessageTransport } from "@soldat-web/protocol/transport";
import { OnlineSession, type OnlineMetrics } from "./session.ts";

const FROZEN_WASM = "7282e3044b086aad5e5091ecf1661579e31b2499add12665ac76d47c4a16f857";
export interface OnlineHook {
  readonly metrics: OnlineMetrics;
  /** Optional 12-byte override, sampled/copy-owned at each real predicted tick. */
  input?: Uint8Array;
  readonly session: OnlineSession;
  onSnapshot?: (metrics: Readonly<OnlineMetrics>) => void;
  /** Confirmed gameplay only, deduplicated before delivery; first ID may exceed one. */
  onGameplayEvent?: (event: ReliableEvent) => void;
}
declare global { interface Window { __soldatOnline?: OnlineHook } }
export interface BrowserOnline {
  session: OnlineSession; prediction: SimHost; hook: OnlineHook;
  updateOverlay(): void; dispose(): void;
}
async function bytes(url: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
export async function connectOnline(options: {
  url: string; map: string; container: HTMLElement; signal: AbortSignal;
  onStatus(status: string): void; onEvent(event: ReliableEvent): void;
  onPresentation(bytes: Uint8Array): void;
}): Promise<BrowserOnline> {
  const wasm = await bytes("/sim.wasm", options.signal);
  if (await sha256(wasm) !== FROZEN_WASM) throw new Error("Online simulation does not match the frozen Phase-4 WASM");
  const response = await fetch("/content/sim/manifest.json", { signal: options.signal });
  if (!response.ok) throw new Error(`Simulation manifest: HTTP ${response.status}`);
  const manifest = await response.json() as SimManifest;
  const prediction = await loadSim(wasm), extraction = await loadSim(wasm);
  let session: OnlineSession | undefined, disposed = false;
  let overlay: HTMLElement | undefined;
  let transport: MessageTransport | undefined;
  let timer: number | undefined;
  let hook: OnlineHook | undefined;
  const dispose = () => {
    if (disposed) return; disposed = true;
    clearTimeout(timer); transport?.close(); overlay?.remove();
    options.signal.removeEventListener("abort", aborted);
    if (window.__soldatOnline === hook) delete window.__soldatOnline;
    if (session) session.dispose(); else { prediction.dispose(); extraction.dispose(); }
  };
  const aborted = () => dispose();
  try {
    // Server mounts the complete manifest. The VFS identity is gameplay state,
    // so a selected-map-only mount cannot safely restore server fullstates.
    const cache = new Map<string, Uint8Array<ArrayBuffer>>();
    const readContent = async (path: string) => {
      if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe simulation content path");
      let data = cache.get(path);
      if (!data) { data = await bytes(`/content/${path.split("/").map(encodeURIComponent).join("/")}`, options.signal); cache.set(path, data); }
      return data;
    };
    await loadSimContent(prediction, manifest, readContent);
    await loadSimContent(extraction, manifest, readContent);
    cache.clear();
    if (options.signal.aborted) throw new DOMException("Online admission cancelled", "AbortError");
    options.signal.addEventListener("abort", aborted, { once: true });
    transport = connectWss(options.url);
    const send = (message: Message) => transport!.send(message.type === "snapshot" ? "latestState" : "reliableControl", encodeMessage(message));
    const admitted = await new Promise<OnlineSession>((resolve, reject) => {
      timer = window.setTimeout(() => { reject(new Error("Online admission timed out")); dispose(); }, 15_000);
      const failed = (error: Error) => {
        if (session) { session.metrics.status = `disconnected: ${error.message}`; options.onStatus(session.metrics.status); }
        reject(error); dispose();
      };
      options.signal.addEventListener("abort", () => reject(new DOMException("Online admission cancelled", "AbortError")), { once: true });
      transport!.onError = failed;
      transport!.onClose = (code, reason) => failed(new Error(`WSS closed (${code}): ${reason}`));
      transport!.onMessage = (_channel, packet) => {
        try {
          const message = decodeMessage(packet);
          if (message.type === "welcome") {
            if (session) throw new Error("Repeated welcome");
            if (message.map.toLowerCase() !== options.map.toLowerCase()) throw new Error(`Server map is ${message.map}; select that map in the URL`);
            const rules: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message.rules));
            if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("Invalid welcome rules");
            for (const host of [prediction, extraction]) {
              requireStatus(host.init(Object.fromEntries(Object.entries(rules)), Number(message.matchSeed & 0xffffffffn), Number(message.matchSeed >> 32n), 0), "sim_init(welcome)");
              requireStatus(host.loadMap(message.map), "sim_load_map(welcome)");
            }
            session = new OnlineSession({ prediction, extraction, slot: message.slot, send,
              onEvent(event) { options.onEvent(event); hook?.onGameplayEvent?.(event); },
              onPresentation: options.onPresentation, onSnapshot: metrics => hook?.onSnapshot?.(metrics) });
            clearTimeout(timer); resolve(session);
          } else if (session) session.receive(message);
          else if (message.type === "ping") send({ type: "pong", timestamp: message.timestamp });
          else if (message.type === "disconnect") throw new Error(message.reason);
          else throw new Error(`Unexpected ${message.type} before welcome`);
        } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
      };
      const params = new URLSearchParams(location.search);
      const contentSetHash = Uint8Array.from(manifest.sha256.match(/.{2}/g) ?? [], pair => parseInt(pair, 16));
      send({ type: "hello", protocolVersion: PROTOCOL_VERSION, contentSetHash, simAbiVersion: SIM_ABI_VERSION,
        nickname: params.get("nickname") || "Player", weapon: Number(params.get("weapon") ?? 4), secondaryWeapon: Number(params.get("secondaryWeapon") ?? 0) });
    });
    if (disposed) throw new Error("Online connection closed during admission");
    hook = { metrics: admitted.metrics, session: admitted }; window.__soldatOnline = hook;
    overlay = document.createElement("pre"); overlay.dataset.soldatNet = "debug";
    overlay.setAttribute("role", "status");
    overlay.style.cssText = "position:absolute;top:8px;left:8px;z-index:20;pointer-events:none;margin:0;padding:8px;background:#101820df;color:#d9f0df;font:12px/1.5 monospace;white-space:pre-wrap";
    options.container.append(overlay);
    return { session: admitted, prediction, hook, dispose,
      updateOverlay() {
        const m = admitted.metrics;
        overlay!.textContent = `${m.status} · slot ${m.slot} · tick ${m.predictedTick}/${m.serverTick}\nRTT ${m.rttMs.toFixed(1)}ms · snapshot gaps ${(m.loss * 100).toFixed(1)}% · age ${m.snapshotAgeMs.toFixed(1)}ms\ncorrection ${m.correction.toFixed(3)} · interp ${m.interpolationMs.toFixed(1)}ms · replay ${m.replayTicks}\nhash @${m.snapshotTick}: ${m.loadedHash} ${m.loadedHash === m.snapshotHash ? "=" : "≠"} ${m.snapshotHash}`;
      } };
  } catch (error) { dispose(); throw error; }
}
