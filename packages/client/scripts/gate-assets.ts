import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import type { Plugin } from "vite";

/** Development-only evidence endpoints; fixture assets are explicitly allowlisted. */
export function gateAssets(root: string): Plugin {
  const results: unknown[] = [];
  let activeRun = "";
  return { name: "client-g2-evidence", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/g2/")) return next();
      const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
      try {
        if (url.pathname === "/g2/start" && req.method === "POST") { activeRun = url.searchParams.get("run") ?? ""; return json({ runId: activeRun }); }
        const corpus = JSON.parse(await readFile(resolve(root, "tests/fixtures/movement/corpus.json"), "utf8")) as { fixtures: string[] };
        if (url.pathname === "/g2/config") return json(corpus);
        if (url.pathname === "/g2/results") return json(results);
        if (url.pathname === "/g2/error" && req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          const failure = { ...JSON.parse(Buffer.concat(chunks).toString()), accepted: false };
          results.push(failure); console.error(JSON.stringify(failure)); return json(failure);
        }
        const name = url.searchParams.get("fixture") ?? "";
        if (!corpus.fixtures.includes(name)) return json({ error: "Unknown fixture" }, 404);
        if (url.pathname === "/g2/fixture") { res.setHeader("Content-Type", "application/json"); return res.end(await readFile(resolve(root, "tests/fixtures/movement", name))); }
        const fixture = name ? JSON.parse(await readFile(resolve(root, "tests/fixtures/movement", name), "utf8")) : undefined;
        if (url.pathname === "/g2/map") {
          if (!fixture.mapPath) return json({ error: "No fixture map overlay" }, 404);
          const path = resolve(root, fixture.mapPath);
          if (!path.startsWith(root + "/")) throw new Error("Fixture map outside repository");
          return res.end(await readFile(path));
        }
        if (url.pathname === "/g2/baseline") return res.end(await readFile(resolve(root, "build-out/sim/receipts/node", name.replace(".fixture.json", ".receipt.json"))));
        if (url.pathname === "/g2/result" && req.method === "POST") {
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of req) { length += chunk.length; if (length > 16 * 1024 * 1024) throw new Error("Receipt too large"); chunks.push(chunk); }
          const receipt = JSON.parse(Buffer.concat(chunks).toString());
          if (activeRun && receipt.runId !== activeRun) throw new Error("Superseded qualification run");
          if (url.pathname === "/g2/result") {
            const expected = JSON.parse(await readFile(resolve(root, "build-out/sim/receipts/node", name.replace(".fixture.json", ".receipt.json")), "utf8"));
            for (const key of ["wasmSha256", "fixtureSha256", "contentSetHash"]) if (receipt[key] !== expected[key]) throw new Error(`Receipt ${key} mismatch`);
            if (![60,120,144].includes(receipt.hz) || receipt.droppedTicks !== 0 || receipt.renders < receipt.ticks || receipt.rows.length !== expected.baseline.length) throw new Error("Incomplete rendered receipt");
            for (let i = 0; i < receipt.rows.length; i++) if (receipt.rows[i].hash !== expected.baseline[i].hash || receipt.rows[i].tick !== expected.baseline[i].tick) throw new Error(`Hash mismatch at tick ${i}`);
          }
          const out = resolve(root, "build-out/client-g2"); await mkdir(out, { recursive: true });
          const file = `${receipt.browser}-${receipt.hz}-${basename(name)}.json`;
          await writeFile(resolve(out, file), JSON.stringify(receipt) + "\n");
          const summary = { fixture: name, browser: receipt.browser, runtime: receipt.runtime, runId: receipt.runId, wasmSha256: receipt.wasmSha256, hz: receipt.hz, ticks: receipt.ticks, renders: receipt.renders, accepted: true, file };
          results.push(summary); console.log(JSON.stringify(summary)); return json(summary);
        }
        json({ error: "Unknown gate endpoint" }, 404);
      } catch (error) { json({ error: String(error) }, 409); }
    });
  } };
}
