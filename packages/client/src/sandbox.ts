import { loadSim, requireStatus, type SimHost } from "@soldat-web/sim-host";
import { BOT_PROFILES, DEFAULT_SANDBOX, sandboxBotTeam, validateSandbox, type SandboxOptions } from "./sandbox-options";
import { mountSimulationPack } from "./sim-content";
import { loadSimulationCode } from "./sim-runtime";

export async function loadSandbox(map: string, signal: AbortSignal, combat = false, loadout?: { weapon: number; secondaryWeapon: number }, options: SandboxOptions = DEFAULT_SANDBOX, name?: string): Promise<SimHost> {
  validateSandbox(options);
  const code = await loadSimulationCode(signal, combat ? "/sim.wasm" : undefined);
  const host = await loadSim(code.module);
  try {
    await mountSimulationPack(host, map, signal);
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
