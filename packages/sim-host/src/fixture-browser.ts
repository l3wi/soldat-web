import { runFixture, ReceiptMismatch, type Fixture } from "./fixture.ts";
import type { SimManifest } from "./sim.ts";

async function bytes(path: string) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
const output = document.querySelector("pre")!;
try {
  const configResponse = await fetch("/config");
  if (!configResponse.ok) throw new Error("Fixture server configuration unavailable");
  const config = await configResponse.json() as { fixtures: { name: string; url: string }[]; rng?: "original" | "keyed" };
  const wasm = await bytes("/sim.wasm");
  const compiledModule = await WebAssembly.compile(wasm);
  const manifest = JSON.parse(new TextDecoder().decode(await bytes("/content/sim/manifest.json"))) as SimManifest;
  for (const file of config.fixtures) {
    output.textContent = `Running ${file.name} in ${navigator.userAgent}`;
    const fixtureBytes = await bytes(file.url);
    const receipt = await runFixture({
      wasm, compiledModule, manifest, fixture: JSON.parse(new TextDecoder().decode(fixtureBytes)) as Fixture,
      fixtureBytes, fixtureName: file.name, runtime: navigator.userAgent,
      rngPolicy: config.rng,
      readContent: path => bytes(`/content/${path.split("/").map(encodeURIComponent).join("/")}`),
      readFixtureAsset: path => bytes(`/fixture-assets/${path.split("/").map(encodeURIComponent).join("/")}`),
    });
    const response = await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(receipt) });
    if (!response.ok) throw new Error(await response.text());
  }
  document.documentElement.dataset.result = "pass";
  output.textContent = JSON.stringify({ status: "complete", runtime: navigator.userAgent, fixtures: config.fixtures.length });
} catch (error) {
  document.documentElement.dataset.result = "fail";
  const failure = { type: "sim-fixture-error", runtime: navigator.userAgent, error: String(error), mismatch: error instanceof ReceiptMismatch ? error.difference : undefined };
  output.textContent = JSON.stringify(failure);
  await fetch("/error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(failure) }).catch(() => {});
}
