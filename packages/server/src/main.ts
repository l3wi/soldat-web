import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPlatformServer } from "./platform.ts";
import type { GameMode, Region } from "@soldat-web/protocol";
import type { MatchConfiguration } from "./worker-messages.ts";

try {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("The authoritative server requires Node 24 LTS");
  const path = process.env.SOLDAT_SERVER_CONFIG;
  if (!path) throw new Error("Set SOLDAT_SERVER_CONFIG to a JSON configuration path; TLS is required");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  for (const key of ["wasmPath", "contentRoot", "map", "matchSeed", "tlsKeyPath", "tlsCertPath"]) {
    if (typeof config[key] !== "string" || !config[key]) throw new Error(`Configuration requires ${key}`);
  }
  if (typeof config.rules !== "object" || config.rules === null || Array.isArray(config.rules)) throw new Error("Configuration requires a rules object");
  if (config.port !== undefined && (typeof config.port !== "number" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) throw new Error("Invalid listen port");
  if (config.host !== undefined && typeof config.host !== "string") throw new Error("Invalid listen host");
  const contentRoot = resolve(config.contentRoot as string);
  const manifest = JSON.parse(await readFile(resolve(contentRoot, "sim/manifest.json"), "utf8")) as { sha256: string };
  const match: MatchConfiguration = {
    wasmPath: resolve(config.wasmPath as string), contentRoot, contentSetHash: manifest.sha256,
    map: config.map as string, matchSeed: config.matchSeed as string, rules: config.rules as Record<string, unknown>,
    ...(config.botCount === undefined ? {} : { botCount: config.botCount as number }),
  };
  const [key, cert] = await Promise.all([readFile(config.tlsKeyPath as string), readFile(config.tlsCertPath as string)]);
  const index = JSON.parse(await readFile(resolve(contentRoot, "index.json"), "utf8")) as { maps: Record<string, { botCapable: boolean }> };
  const maps = Object.entries(index.maps).map(([name, value]) => ({ name, botCapable: value.botCapable, mode: (name.toLowerCase().startsWith("ctf_") ? "ctf" : "dm") as GameMode }));
  const server = await createPlatformServer({
    match, maps, tls: { key, cert }, host: config.host as string ?? "0.0.0.0", port: config.port as number ?? 443,
    ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl as string }),
    ...(config.regions === undefined ? {} : { regions: config.regions as Region[] }),
    ...(config.targetPlayers === undefined ? {} : { targetPlayers: config.targetPlayers as number }),
    ...(config.maxMatches === undefined ? {} : { maxMatches: config.maxMatches as number }),
  });
  console.log(JSON.stringify({ type: "listening", address: server.httpsServer.address(), contentSetHash: manifest.sha256 }));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.close().catch(error => { console.error(error); process.exitCode = 1; });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
