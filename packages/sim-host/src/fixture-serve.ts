import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertMatchingReceipts, ReceiptMismatch, type FixtureReceipt, type ReceiptDifference } from "./fixture.ts";
import { runnerArguments, fixtureFiles, readBaseline, readFixture, receiptName, containedPath } from "./fixture-files.ts";

const args = runnerArguments(process.argv.slice(2));
if (!args.baseline) throw new Error("Browser collection requires --baseline NODE_RECEIPT_DIRECTORY");
const fixtures = await fixtureFiles(args);
const expected: Record<string, FixtureReceipt> = {};
const fixtureAssets: Record<string, string> = {};
for (const path of fixtures) {
  expected[path] = await readBaseline(args.baseline, path);
  const file = await readFixture(path);
  if (file.fixture.mapPath) fixtureAssets[file.fixture.mapPath] = containedPath(process.cwd(), file.fixture.mapPath);
}
const bundle = await Bun.build({ entrypoints: [new URL("./fixture-browser.ts", import.meta.url).pathname], target: "browser", write: false });
if (!bundle.success || !bundle.outputs[0]) throw new Error(`Fixture browser bundle failed: ${bundle.logs.join("\n")}`);
await mkdir(args.out, { recursive: true });
const results: { runtime?: string; fixture?: string; accepted: boolean; error?: string; mismatch?: ReceiptDifference }[] = [];
let serial = 0;
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 4174), maxRequestBodySize: 32 * 1024 * 1024,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/") return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Simulation corpus determinism</title><h1>Simulation corpus determinism</h1><pre>Starting…</pre><script type="module" src="/fixture-browser.js"></script></html>', { headers: { "content-type": "text/html" } });
      if (path === "/fixture-browser.js") return new Response(bundle.outputs[0], { headers: { "content-type": "text/javascript" } });
      if (path === "/sim.wasm") return new Response(Bun.file(resolve(args.wasm)), { headers: { "content-type": "application/wasm" } });
      if (path === "/config") return Response.json({ rng: args.rng, fixtures: fixtures.map((name, index) => ({ name, url: `/fixtures/${index}` })) });
      if (path.startsWith("/fixtures/")) {
        const index = Number(path.slice("/fixtures/".length));
        if (!Number.isInteger(index) || !fixtures[index]) return new Response("Unknown fixture", { status: 404 });
        return new Response(await readFile(fixtures[index]!));
      }
      if (path.startsWith("/content/")) return new Response(await readFile(containedPath(args.content, decodeURIComponent(path.slice("/content/".length)))));
      if (path.startsWith("/fixture-assets/")) {
        const asset = decodeURIComponent(path.slice("/fixture-assets/".length));
        if (!Object.hasOwn(fixtureAssets, asset)) return new Response("Not a declared fixture asset", { status: 403 });
        return new Response(await readFile(fixtureAssets[asset]!));
      }
      if (path === "/results") return Response.json({ baselines: Object.values(expected), results });
      if (path === "/result" && request.method === "POST") {
        const receipt = await request.json() as FixtureReceipt;
        const baseline = expected[receipt.fixture];
        try {
          if (!baseline || receipt.type !== "sim-fixture-receipt" || typeof receipt.runtime !== "string") throw new Error("Unknown fixture or malformed receipt");
          assertMatchingReceipts(baseline, receipt);
          const destination = resolve(args.out, `${String(++serial).padStart(4, "0")}-${receiptName(receipt.fixture)}`);
          await writeFile(destination, `${JSON.stringify(receipt)}\n`);
          const result = { runtime: receipt.runtime, fixture: receipt.fixture, accepted: true };
          results.push(result); console.log(JSON.stringify(result));
          return Response.json(result);
        } catch (error) {
          const result = { runtime: receipt.runtime, fixture: receipt.fixture, accepted: false, error: String(error), mismatch: error instanceof ReceiptMismatch ? error.difference : undefined };
          results.push(result); console.error(JSON.stringify(result));
          return Response.json(result, { status: 409 });
        }
      }
      if (path === "/error" && request.method === "POST") {
        const result = await request.json() as { runtime: string; error: string };
        results.push({ ...result, accepted: false }); console.error(JSON.stringify(result));
        return new Response("recorded");
      }
      return new Response("Not found", { status: 404 });
    } catch (error) { return new Response(String(error), { status: 500 }); }
  },
});
console.log(`Fixture receipt server: ${server.url}`);
