import { readFile } from "node:fs/promises";
import { loadSpike } from "./index.ts";

const path = process.argv[2] ?? new URL("../../../build-out/spike/spike.wasm", import.meta.url);
const ticks = Number(process.argv[3] ?? 10_000);
const spike = await loadSpike(await readFile(path));
if (process.argv.includes("--trace")) {
  spike.exports.spike_reset();
  for (let tick = 1; tick <= ticks; tick++) {
    const hash = BigInt.asUintN(64, spike.exports.spike_step()).toString(16).padStart(16, "0");
    console.log(tick, hash, ...spike.stateBits());
  }
} else {
  console.log(JSON.stringify({ runtime: process.version, ticks, hash: spike.hash(ticks),
    stateBytes: spike.exports.spike_state_len(), imports: spike.imports, stdout: spike.stdout() }));
}
