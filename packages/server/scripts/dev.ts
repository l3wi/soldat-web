import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = resolve(root, "build-out/server-dev");
await mkdir(out, { recursive: true });
const key = resolve(out, "localhost-key.pem"), cert = resolve(out, "localhost-cert.pem");
try { await Promise.all([access(key), access(cert)]); }
catch {
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert]);
}
const configPath = resolve(out, "server.json");
const port = Number(process.env.SOLDAT_SERVER_PORT ?? 7443);
const origin = `https://127.0.0.1:${port}`;
const regions = JSON.parse(await readFile(new URL("../regions.local.json", import.meta.url), "utf8")) as { id: string; name: string; url: string }[];
await writeFile(configPath, JSON.stringify({
  wasmPath: resolve(root, "build-out/sim/sim.wasm"), contentRoot: resolve(root, process.env.SOLDAT_CONTENT_ROOT ?? "dist/content-next"),
  map: "Arena", matchSeed: "123456789", rules: { mode: "dm", rng: "keyed", world: "original", botDifficulty: 100 },
  tlsKeyPath: key, tlsCertPath: cert, host: "127.0.0.1", port, publicUrl: origin, maxMatches: 8,
  regions: regions.map(region => ({ ...region, url: origin })),
  allowedOrigins: [5195, 5198, 5199].flatMap(clientPort => [`http://127.0.0.1:${clientPort}`, `http://localhost:${clientPort}`]),
}, null, 2));
console.log(`Local API: ${origin}/api/ping (trust ${cert} in your browser first)`);
console.log(`Client: VITE_SERVER_URL=wss://127.0.0.1:${port} bun run --cwd packages/client dev --port 5195`);
const child = spawn(process.execPath, [resolve(root, "packages/server/src/main.ts")], { cwd: root, env: { ...process.env, SOLDAT_SERVER_CONFIG: configPath }, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 0; });
