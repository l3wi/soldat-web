import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runRig, type RigOptions } from "./run.ts";
import { ACCEPTANCE_PROFILE } from "./impairment.ts";
import { FROZEN_WASM_SHA256, json } from "./support.ts";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out"), secondsAt = args.indexOf("--seconds");
const out = resolve(outAt < 0 ? "build-out/net-g4/final" : args[outAt + 1]!);
const seconds = Number(secondsAt < 0 ? 120 : args[secondsAt + 1]);
if (!Number.isFinite(seconds) || seconds < 120) throw new Error("Final correction-rate cases require at least 120 measured seconds each");
await mkdir(out, { recursive: true });
const results: object[] = [];
const cases: RigOptions[] = [];
for (const impaired of [false, true]) for (const players of [2, 8]) cases.push({ players, impaired, seconds, out: resolve(out, `${impaired ? "100ms-15ms-1pct" : "lan"}-${players}`), combat: false, browserPlayers: 0, port: 9443, gatewayPort: 9444, profile: ACCEPTANCE_PROFILE });
// Ordinary-movement correction gates above are kept separate from real combat
// knockback/death/respawn corrections; reliable confirmation evidence lives here.
if (!args.includes("--movement-only")) cases.push({ players: 8, impaired: true, seconds, out: resolve(out, "combat-8"), combat: true, browserPlayers: 0, port: 9443, gatewayPort: 9444, profile: ACCEPTANCE_PROFILE });
if (!args.includes("--movement-only")) cases.push({ players: 2, impaired: true, seconds, out: resolve(out, "canonical-combat-2"), combat: true, stackedCombat: true, browserPlayers: 0, port: 9443, gatewayPort: 9444, profile: ACCEPTANCE_PROFILE });
if (args.includes("--soak")) cases.push({ players: 8, impaired: false, seconds: 1800, out: resolve(out, "soak-8-30min"), combat: true, browserPlayers: 0, port: 9443, gatewayPort: 9444 });
for (const options of cases) {
  try { results.push(await runRig(options)); }
  catch (error) { results.push({ options, failure: error instanceof Error ? error.stack : String(error) }); }
  await writeFile(resolve(out, "matrix.json"), `${json({ wasmSha256: FROZEN_WASM_SHA256, results, pending: ["Two humans playing Arena", "Physical input-to-display latency", "16/32-player capacity", "Full SPEC6.4 profile cross-product", "Two-hour memory soak", ...(args.includes("--soak") ? [] : ["Thirty-minute eight-player soak"]) ] })}\n`);
}
if (results.some(row => {
  const result = row as { failure?: string; gates?: Record<string, boolean | string | null> };
  return Boolean(result.failure) || Object.values(result.gates ?? {}).some(value => value === false);
})) process.exitCode = 1;
