import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  acceptedEncodings, cacheControl, compressible, mimeType,
  precompressFile, precompressTree, previewCacheRoot, requestPath,
} from "./production.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: {
  root: { type: "string", default: process.env.SOLDAT_PREVIEW_ROOT ?? "dist/client" },
  "content-root": { type: "string", default: process.env.SOLDAT_BASELINE_CONTENT_ROOT },
  port: { type: "string", default: process.env.PORT ?? "5196" },
  host: { type: "string", default: "127.0.0.1" },
} });
const root = await realpath(resolve(repository, values.root!));
const contentRoot = values["content-root"]
  ? await realpath(resolve(repository, values["content-root"])) : undefined;
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid preview port");
const legacyWasmRoot = contentRoot ? await realpath(resolve(repository, "build-out/sim")) : root;
const emittedWasm = contentRoot ? undefined
  : (await readdir(resolve(root, "assets"))).find(name => /^sim-[a-f0-9]{64}\.wasm$/.test(name));
if (!contentRoot && !emittedWasm) throw new Error("Preview bundle has no hash-named simulation WASM");
const legacyWasmName = contentRoot ? "sim.wasm" : `assets/${emittedWasm}`;

// Before/after use identical codecs and headers. Baseline sidecars live outside
// both the preserved bundle and raw source content, and are ready before listen.
const bundleCompressed = contentRoot ? previewCacheRoot(repository, root) : root;
const contentCompressed = contentRoot ? previewCacheRoot(repository, contentRoot) : undefined;
if (contentRoot) {
  await precompressTree(root, bundleCompressed);
  await precompressTree(contentRoot, contentCompressed!);
  const wasm = resolve(repository, "build-out/sim/sim.wasm");
  // The old bundle requests /sim.wasm. Prepare just this existing file rather
  // than descending into the simulation build or changing anything inside it.
  await precompressFile(wasm, resolve(bundleCompressed, "sim.wasm"));
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return;
  }
  let pathname: string;
  try { pathname = requestPath(req.url ?? "/"); }
  catch { res.writeHead(400); res.end("Invalid path"); return; }
  try {
    const externalContent = contentRoot !== undefined && pathname.startsWith("/content/");
    const legacyWasm = pathname === "/sim.wasm";
    const mount = externalContent ? contentRoot! : legacyWasm ? legacyWasmRoot : root;
    const name = externalContent ? pathname.slice("/content/".length) : legacyWasm ? legacyWasmName : pathname.slice(1);
    const file = await realpath(resolve(mount, name));
    if (!file.startsWith(mount + sep)) { res.writeHead(403); res.end(); return; }
    const original = await stat(file);
    if (!original.isFile()) { res.writeHead(404); res.end(); return; }
    const sidecarRoot = externalContent ? contentCompressed! : bundleCompressed;
    const sidecar = resolve(sidecarRoot, legacyWasm ? legacyWasmName : relative(mount, file));
    let served: string | undefined;
    let encoding: "br" | "gzip" | "identity" | undefined;
    for (const candidate of acceptedEncodings(req.headers["accept-encoding"])) {
      if (candidate === "identity") { served = file; encoding = candidate; break; }
      if (!compressible.test(file)) continue;
      const compressed = `${sidecar}.${candidate === "gzip" ? "gz" : "br"}`;
      try {
        const actual = await realpath(compressed);
        if (actual.startsWith(sidecarRoot + sep) && (await stat(actual)).isFile()) {
          served = actual; encoding = candidate; break;
        }
      } catch { /* Missing sidecars may use the next accepted representation. */ }
    }
    if (!served) { res.writeHead(406, { Vary: "Accept-Encoding" }); res.end(); return; }
    const size = (await stat(served)).size;
    res.setHeader("Content-Type", mimeType(file));
    res.setHeader("Content-Length", size);
    res.setHeader("Cache-Control", cacheControl(pathname));
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Last-Modified", original.mtime.toUTCString());
    if (encoding !== "identity") res.setHeader("Content-Encoding", encoding!);
    if (req.method === "HEAD") { res.end(); return; }
    const stream = createReadStream(served);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    res.writeHead(code === "ENOENT" || code === "ENOTDIR" ? 404 : 500);
    res.end(code === "ENOENT" || code === "ENOTDIR" ? "Not found" : "Asset read failed");
  }
});
server.listen(port, values.host, () => {
  const address = server.address();
  console.log(`Soldat production preview http://${values.host}:${typeof address === "object" && address ? address.port : port}/`);
});
