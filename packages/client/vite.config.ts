import { defineConfig, type Plugin } from "vite";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function localAssets(): Plugin {
  return {
    name: "local-game-assets",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        let url: string;
        try { url = decodeURIComponent((req.url ?? "/").split("?")[0]!); }
        catch { res.statusCode = 400; res.end(); return; }
        const contentRoot = resolve(root, "dist/content");
        const path = url === "/sim.wasm"
          ? resolve(root, "build-out/sim/sim.wasm")
          : url.startsWith("/content/") ? resolve(contentRoot, "." + url.slice(8)) : null;
        if (!path) return next();
        if (url !== "/sim.wasm" && !path.startsWith(contentRoot + sep)) {
          res.statusCode = 403; res.end(); return;
        }
        try {
          if (!(await stat(path)).isFile()) return next();
          const type = path.endsWith(".json") ? "application/json" : path.endsWith(".png") ? "image/png" : path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".txt") ? "text/plain; charset=utf-8" : path.endsWith(".wav") ? "audio/wav" : "application/octet-stream";
          res.setHeader("Content-Type", type);
          createReadStream(path).pipe(res);
        } catch { res.statusCode = 404; res.end("Game asset unavailable"); }
      });
    },
  };
}
export default defineConfig({ plugins: [localAssets()], build: { target: "es2022", outDir: "../../dist/client", emptyOutDir: true } });
