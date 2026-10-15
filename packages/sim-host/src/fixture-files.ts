import { readFile } from "node:fs/promises";
import { basename, resolve, relative, isAbsolute, dirname } from "node:path";
import type { Fixture, FixtureReceipt } from "./fixture.ts";
import type { SimManifest } from "./sim.ts";

export interface RunnerArguments {
  wasm: string; content: string; out: string; baseline?: string; corpus?: string; trace: boolean; fixtures: string[];
}
export function runnerArguments(args: string[]): RunnerArguments {
  const result: RunnerArguments = { wasm: "build-out/sim/sim.wasm", content: "dist/content", out: "build-out/sim/receipts/node", trace: false, fixtures: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--trace") result.trace = true;
    else if (["--wasm", "--content", "--out", "--baseline", "--corpus"].includes(arg)) {
      const value = args[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--wasm") result.wasm = value;
      if (arg === "--content") result.content = value;
      if (arg === "--out") result.out = value;
      if (arg === "--baseline") result.baseline = value;
      if (arg === "--corpus") result.corpus = value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else result.fixtures.push(arg);
  }
  return result;
}
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
export function receiptName(path: string): string { return `${basename(path).replace(/\.fixture\.json$/, "")}.receipt.json`; }
export function containedPath(root: string, path: string): string {
  const full = resolve(root, path), rel = relative(resolve(root), full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`Path escapes root: ${path}`);
  return full;
}
export async function fixtureFiles(args: RunnerArguments): Promise<string[]> {
  if (!args.corpus) {
    if (!args.fixtures.length) throw new Error("Supply fixture paths or --corpus INDEX");
    return args.fixtures;
  }
  const corpus = await readJson<{ fixtures: (string | { path: string })[] }>(args.corpus);
  return [...args.fixtures, ...corpus.fixtures.map(entry => {
    const path = typeof entry === "string" ? entry : entry.path;
    return path.startsWith("tests/") ? path : resolve(dirname(args.corpus!), path);
  })];
}
export interface FixtureFile { name: string; fixture: Fixture; bytes: Uint8Array }
export async function readFixture(path: string): Promise<FixtureFile> {
  const bytes = new Uint8Array(await readFile(path));
  return { name: path, fixture: JSON.parse(new TextDecoder().decode(bytes)) as Fixture, bytes };
}
export async function readManifest(root: string): Promise<SimManifest> { return readJson<SimManifest>(resolve(root, "sim/manifest.json")); }
export async function readBaseline(root: string, fixture: string): Promise<FixtureReceipt> { return readJson<FixtureReceipt>(resolve(root, receiptName(fixture))); }
