import { defineConfig } from "vite";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
export default defineConfig({
  plugins: [
    {
      name: "local-content",
      configureServer(server) {
        server.middlewares.use("/content", async (req, res, next) => {
          const root = resolve("../../dist/content");
          const path = resolve(
            root,
            "." + decodeURIComponent((req.url ?? "/").split("?")[0]!),
          );
          if (!path.startsWith(root + sep)) {
            res.statusCode = 403;
            res.end();
            return;
          }
          try {
            if (!(await stat(path)).isFile()) return next();
            res.setHeader(
              "Content-Type",
              path.endsWith(".json")
                ? "application/json"
                : path.endsWith(".png")
                  ? "image/png"
                  : "application/octet-stream",
            );
            createReadStream(path).pipe(res);
          } catch {
            next();
          }
        });
      },
    },
  ],
  build: {
    target: "es2022",
    rollupOptions: {
      input: { phaser: resolve("index.html"), pixi: resolve("pixi.html") },
    },
  },
});
