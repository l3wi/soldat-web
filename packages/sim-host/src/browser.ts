import { loadSpike } from "./index.ts";

const output = document.querySelector("pre")!;
try {
  const response = await fetch("/spike.wasm");
  if (!response.ok) throw new Error(`WASM HTTP ${response.status}`);
  const spike = await loadSpike(await response.arrayBuffer());
  const result = { runtime: navigator.userAgent, ticks: 10_000, hash: spike.hash(),
    stateBytes: spike.exports.spike_state_len(), imports: spike.imports, stdout: spike.stdout() };
  output.textContent = JSON.stringify(result, null, 2);
  document.documentElement.dataset.result = "pass";
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
} catch (error) {
  output.textContent = String(error);
  document.documentElement.dataset.result = "fail";
  await fetch("/result", { method: "POST", body: JSON.stringify({ error: String(error), runtime: navigator.userAgent }) });
}
