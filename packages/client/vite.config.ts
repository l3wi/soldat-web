import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gateAssets } from "./scripts/gate-assets";
import { copyProductionContent, mimeType, precompressTree, requestPath } from "./scripts/production";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wasmPath = resolve(root, "build-out/sim/sim.wasm");
const virtualWasm = "virtual:soldat-sim-wasm";
const resolvedVirtualWasm = "\0" + virtualWasm;

function gameAssets(build: boolean): Plugin {
  const contentRoot = resolve(root, process.env.SOLDAT_CONTENT_ROOT ?? "dist/content-next");
  let outDir = resolve(root, "dist/client");
  let wasmReference: string | undefined;
  return {
    name: "local-game-assets",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      if (contentRoot === outDir || contentRoot.startsWith(outDir + sep)) {
        throw new Error("SOLDAT_CONTENT_ROOT must be outside the client output directory");
      }
    },
    async buildStart() {
      if (!build) return;
      // Consume the frozen current artifact; this pipeline never invokes a sim build.
      const bytes = await readFile(wasmPath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      wasmReference = this.emitFile({ type: "asset", fileName: `assets/sim-${hash}.wasm`, source: bytes });
    },
    resolveId(id) { if (id === virtualWasm) return resolvedVirtualWasm; },
    load(id) {
      if (id !== resolvedVirtualWasm) return;
      if (!build) return 'export default "/sim.wasm";';
      if (!wasmReference) throw new Error("Simulation WASM asset was not emitted");
      return `export default import.meta.ROLLUP_FILE_URL_${wasmReference};`;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        let url: string;
        try { url = requestPath(req.url ?? "/"); }
        catch { res.statusCode = 400; res.end(); return; }
        const path = url === "/sim.wasm" ? wasmPath
          : url.startsWith("/content/") ? resolve(contentRoot, "." + url.slice(8)) : undefined;
        if (!path) return next();
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return;
        }
        try {
          const actual = await realpath(path);
          if (url !== "/sim.wasm" && !actual.startsWith((await realpath(contentRoot)) + sep)) {
            res.statusCode = 403; res.end(); return;
          }
          const info = await stat(actual);
          if (!info.isFile()) { res.statusCode = 404; res.end(); return; }
          res.setHeader("Content-Type", mimeType(actual));
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "no-store");
          if (req.method === "HEAD") { res.end(); return; }
          const stream = createReadStream(actual);
          stream.on("error", () => res.destroy());
          stream.pipe(res);
        } catch { res.statusCode = 404; res.end("Game asset unavailable"); }
      });
    },
    async writeBundle() {
      if (!build) return;
      await copyProductionContent(contentRoot, resolve(outDir, "content"));
      await precompressTree(outDir);
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [gameAssets(command === "build"), gateAssets(root)],
  server: {
    proxy: {
      "/api": { target: process.env.SOLDAT_SERVER_URL ?? "https://127.0.0.1:7443", changeOrigin: true, secure: false },
    },
  },
  build: {
    target: "es2022", outDir: "../../dist/client", emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/phaser/")) return "phaser";
          if (["react", "react-dom", "scheduler"].some(name => id.includes(`/node_modules/${name}/`))) return "react";
        },
      },
    },
  },
}));
