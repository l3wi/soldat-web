import { loadSim, requireStatus, sha256, type SimHost, type SimManifest } from "@soldat-web/sim-host";
import { BOT_PROFILES, DEFAULT_SANDBOX, sandboxBotTeam, validateSandbox, type SandboxOptions } from "./sandbox-options";

export async function loadSandbox(map: string, signal: AbortSignal, combat = false, loadout?: { weapon: number; secondaryWeapon: number }, options: SandboxOptions = DEFAULT_SANDBOX, name?: string): Promise<SimHost> {
  validateSandbox(options);
  const response = await fetch("/sim.wasm", { signal });
  if (!response.ok || response.headers.get("content-type")?.includes("text/html")) throw new Error("simulation unavailable: build build-out/sim/sim.wasm with the Phase-1 toolchain");
  const host = await loadSim(await response.arrayBuffer());
  try {
    const manifestResponse = await fetch("/content/sim/manifest.json", { signal });
    if (!manifestResponse.ok) throw new Error(`Simulation manifest: HTTP ${manifestResponse.status}`);
    const manifest = await manifestResponse.json() as SimManifest;
    if (manifest.schemaVersion !== 1) throw new Error("Unsupported simulation content schema");
    const ids = Object.keys(manifest.files).sort();
    const identity = ids.map(id => `${id}\t${manifest.files[id]!.sha256}\n`).join("");
    if (await sha256(new TextEncoder().encode(identity)) !== manifest.sha256) throw new Error("Simulation content-set identity mismatch");
    const selected = `maps/${map.toLowerCase()}.pms`;
    if (!manifest.files[selected]) throw new Error(`Selected map absent from sim content: ${map}`);
    for (const id of ids) {
      // Core raw mechanics load once for this match; all other maps stay lazy.
      if (id.startsWith("maps/") && id !== selected) continue;
      if (id !== id.toLowerCase() || id.includes("\\") || id.split("/").some(p => !p || p === "." || p === "..")) throw new Error(`Noncanonical sim VFS path: ${id}`);
      const entry = manifest.files[id]!;
      const file = await fetch(`/content/${entry.path.split("/").map(encodeURIComponent).join("/")}`, { signal });
      if (!file.ok) throw new Error(`Simulation content ${id}: HTTP ${file.status}`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length !== entry.bytes || await sha256(bytes) !== entry.sha256) throw new Error(`Simulation content identity mismatch: ${id}`);
      requireStatus(host.putFile(id, bytes), `sim_vfs_put(${id})`);
    }
    // Practice matches draw a fresh keyed match seed so bot decisions/spread differ between games; combat qualification stays seed 0.
    const seed = combat ? new Uint32Array(2) : crypto.getRandomValues(new Uint32Array(2));
    requireStatus(host.init(combat ? { mode: "ctf", traceCombat: true, ai: false, world: "fixture" } :
      { mode: options.mode, ai: true, rng: "keyed", world: "original", botDifficulty: options.botDifficulty }, seed[0]!, seed[1]!, 0), "sim_init");
    requireStatus(host.loadMap(map), "sim_load_map");
    // Spawn armed with the limbo selection (original players pick in limbo before playing); combat qualification keeps its fixed setup.
    requireStatus(host.command(0, { kind: "join", slot: 1, team: combat ? 1 : options.mode === "ctf" ? options.team : 0, control: "authoritative", ...(!combat && loadout ? loadout : {}), ...(!combat && name ? { name } : {}) }), "sim_command(join)");
    if (combat) requireStatus(host.command(0, { kind: "join", slot: 2, team: 2, control: "authoritative" }), "sim_command(join target)");
    else for (let index = 0; index < options.bots; index++) {
      requireStatus(host.command(0, { kind: "join", slot: index + 2, control: "bot",
        bot: BOT_PROFILES[index % BOT_PROFILES.length]!, team: sandboxBotTeam(options, index) }), "sim_command(join bot)");
    }
    return host;
  } catch (error) { host.dispose(); throw error; }
}
