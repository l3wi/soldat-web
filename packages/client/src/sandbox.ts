import { loadSim, requireStatus, sha256, type SimHost, type SimManifest } from "@soldat-web/sim-host";

export async function loadSandbox(map: string, signal: AbortSignal, combat = false): Promise<SimHost> {
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
    requireStatus(host.init(combat ? { mode: "ctf", traceCombat: true } : {}, 0, 0, 0), "sim_init");
    requireStatus(host.loadMap(map), "sim_load_map");
    requireStatus(host.command(0, { kind: "join", slot: 1, team: 1, control: "authoritative" }), "sim_command(join)");
    if (combat) requireStatus(host.command(0, { kind: "join", slot: 2, team: 2, control: "authoritative" }), "sim_command(join target)");
    return host;
  } catch (error) { host.dispose(); throw error; }
}
