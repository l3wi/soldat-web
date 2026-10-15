import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { runFixture, assertMatchingReceipts } from "./fixture.ts";
import { runnerArguments, fixtureFiles, readFixture, readManifest, receiptName, readBaseline, containedPath } from "./fixture-files.ts";
import { readTraceState, createTraceHeader } from "./trace.ts";

const args = runnerArguments(process.argv.slice(2));
const files = await fixtureFiles(args);
const wasm = new Uint8Array(await readFile(args.wasm));
const manifest = await readManifest(args.content);
await mkdir(args.out, { recursive: true });
for (const path of files) {
  const file = await readFixture(path);
  const trace: string[] = [];
  const receipt = await runFixture({
    wasm, fixture: file.fixture, fixtureBytes: file.bytes, fixtureName: file.name, manifest,
    runtime: `Node ${process.version} ${process.platform}/${process.arch}`,
    readContent: async name => new Uint8Array(await readFile(containedPath(args.content, name))),
    readFixtureAsset: async name => new Uint8Array(await readFile(containedPath(process.cwd(), name))),
    trace: args.trace ? (host, tick) => {
      const state = readTraceState(host);
      if (tick === 0) trace.push(JSON.stringify(createTraceHeader(file.fixture, state)));
      trace.push(JSON.stringify(state));
    } : undefined,
  });
  if (args.baseline) assertMatchingReceipts(await readBaseline(args.baseline, file.name), receipt);
  await writeFile(resolve(args.out, receiptName(path)), `${JSON.stringify(receipt)}\n`);
  if (args.trace) await writeFile(resolve(args.out, `${basename(path).replace(/\.fixture\.json$/, "")}.trace.jsonl`), `${trace.join("\n")}\n`);
  console.log(JSON.stringify({ fixture: path, ticks: receipt.ticks, hash: receipt.baseline.at(-1)?.hash, checkpoints: receipt.checkpoints.length, identical: receipt.identical }));
  await writeFile(resolve(args.out, `${basename(path).replace(/\.fixture\.json$/, "")}.hashes.jsonl`), `${receipt.baseline.map(row => JSON.stringify(row)).join("\n")}\n`);
}
