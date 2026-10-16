import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
export const compressible = /\.(?:js|mjs|css|html|wasm|json|spk|pack)$/i;

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".wav": "audio/wav",
  ".opus": "audio/ogg", ".ogg": "audio/ogg", ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2", ".spk": "application/octet-stream",
};
export function mimeType(path: string): string {
  return mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function cacheControl(path: string): string {
  // Only content-addressed objects and Rollup/hash-named assets are immutable.
  if (/(?:^|\/)objects\/[a-f0-9]{64}\.[^/]+$/i.test(path)
    || /(?:^|\/)assets\/[^/]+-[a-z0-9_-]{8,}\.[^/]+$/i.test(path)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=0, must-revalidate";
}

/** Descends only real directories/files; source trees cannot inject external symlinks. */
export async function* filesIn(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesIn(path);
    else if (entry.isFile()) yield path;
    else throw new Error(`Unsupported asset type: ${path}`);
  }
}

export function includeProductionContent(path: string): boolean {
  const name = path.split(sep).join("/");
  if (/\.wav$/i.test(name)) return false;
  return name === "" || name === "sim" || !name.startsWith("sim/")
    || name === "sim/manifest.json" || name === "sim/packs" || name.startsWith("sim/packs/");
}

export async function copyProductionContent(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    filter: (path) => includeProductionContent(relative(source, path)),
  });
}

/** Writes sidecars without changing the original bytes or their content hashes. */
export async function precompressFile(path: string, target = path): Promise<void> {
  const bytes = await readFile(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.br`, await brotli(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
  }));
  await writeFile(`${target}.gz`, await gzipAsync(bytes, { level: 9 }));
}

export async function precompressTree(directory: string, sidecarRoot = directory): Promise<void> {
  // Serial compression bounds memory even for the per-map simulation packs.
  for await (const path of filesIn(directory)) {
    if (compressible.test(path)) await precompressFile(path, resolve(sidecarRoot, relative(directory, path)));
  }
}

/** Stable separate preview cache: baseline inputs are never modified. */
export function previewCacheRoot(repository: string, directory: string): string {
  const id = createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 16);
  return resolve(repository, "build-out/client-preview-cache", id);
}

/** Accept-Encoding quality weights, including explicit refusal of identity. */
export function acceptedEncodings(header: string | undefined): ("br" | "gzip" | "identity")[] {
  const weights = new Map<string, number>();
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [name, ...parameters] = part.trim().split(";");
    if (!name) continue;
    const quality = parameters.find(value => value.trim().startsWith("q="));
    const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
    weights.set(name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  const weight = (name: string): number => weights.get(name)
    ?? (name === "identity" ? (weights.get("*") === 0 ? 0 : 1) : weights.get("*") ?? 0);
  return (["br", "gzip", "identity"] as const).filter(name => weight(name) > 0)
    .sort((a, b) => weight(b) - weight(a));
}

/** Reject traversal before resolution; realpath containment is checked by the server too. */
export function requestPath(url: string): string {
  const path = decodeURIComponent(url.split(/[?#]/, 1)[0]!);
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\\")
    || path.split("/").some(part => part === "..")) throw new Error("Invalid request path");
  return path === "/" ? "/index.html" : path;
}
