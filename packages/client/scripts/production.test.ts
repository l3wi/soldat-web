import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  acceptedEncodings, cacheControl, copyProductionContent, includeProductionContent,
  mimeType, precompressTree, requestPath,
} from "./production.ts";

describe("production hosting contract", () => {
  it("ships packs and exact simulation manifest but not raw files or WAV masters", () => {
    for (const path of ["", "sim", "sim/manifest.json", "sim/packs", "sim/packs/Arena.spk", "sim/packs/all.spk", "index.json", "objects/hash.opus", "maps/Arena.json"]) {
      assert.equal(includeProductionContent(path), true, path);
    }
    for (const path of ["sim/anims", "sim/anims/run.poa", "sim/maps/Arena.PMS", "objects/hash.wav", "objects/hash.WAV"]) {
      assert.equal(includeProductionContent(path), false, path);
    }
  });

  it("negotiates quality weights, refusals, wildcards and identity", () => {
    assert.deepEqual(acceptedEncodings("gzip, br"), ["br", "gzip", "identity"]);
    assert.deepEqual(acceptedEncodings("br;q=0, gzip;q=1, identity;q=0.5"), ["gzip", "identity"]);
    assert.deepEqual(acceptedEncodings("*;q=0"), []);
    assert.deepEqual(acceptedEncodings(undefined), ["identity"]);
    assert.deepEqual(acceptedEncodings("br;q=garbage, identity;q=0, gzip;q=0.5"), ["gzip"]);
  });

  it("keeps mutable entry points short-lived and hash names immutable", () => {
    for (const path of ["/", "/index.html", "/content/index.json", "/content/manifest.json", "/content/maps/Arena.json", "/content/sim/packs/Arena.spk", "/sim.wasm"]) {
      assert.equal(cacheControl(path), "public, max-age=0, must-revalidate", path);
    }
    for (const path of ["/assets/phaser-AbC123_x.js", `/assets/sim-${"a".repeat(64)}.wasm`, `/content/objects/${"b".repeat(64)}.opus`]) {
      assert.equal(cacheControl(path), "public, max-age=31536000, immutable", path);
    }
    assert.equal(mimeType("sim.wasm"), "application/wasm");
    assert.equal(mimeType("audio.opus"), "audio/ogg");
    assert.equal(mimeType("map.spk"), "application/octet-stream");
    assert.equal(mimeType("image.webp"), "image/webp");
  });

  it("rejects encoded traversal, NUL and backslashes before file access", () => {
    for (const path of ["/../secret", "/%2e%2e/secret", "/content/%2e%2e%2fsecret", "/content/%00", "/content/%5csecret", "/%zz"]) {
      assert.throws(() => requestPath(path), undefined, path);
    }
    assert.equal(requestPath("/?map=Arena"), "/index.html");
    assert.equal(requestPath("/content/maps/Arena.json?v=1"), "/content/maps/Arena.json");
  });

  it("copies filtered real content and sidecars round-trip without touching source bytes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "soldat-production-"));
    try {
      const source = join(temporary, "source"), destination = join(temporary, "client/content");
      await mkdir(join(source, "sim/packs"), { recursive: true });
      await mkdir(join(source, "sim/maps"));
      await mkdir(join(source, "objects"));
      const manifest = Buffer.from('{"schemaVersion":1,"files":{}}\n');
      const pack = Buffer.from("SPK1\0\0\0\0");
      await writeFile(join(source, "sim/manifest.json"), manifest);
      await writeFile(join(source, "sim/packs/Arena.spk"), pack);
      await writeFile(join(source, "sim/maps/Arena.pms"), "raw-map");
      await writeFile(join(source, "objects/master.wav"), "master");
      await writeFile(join(source, "objects/audio.opus"), "opus");
      await copyProductionContent(source, destination);
      await precompressTree(destination);
      assert.deepEqual(await readFile(join(destination, "sim/manifest.json")), manifest);
      assert.deepEqual(brotliDecompressSync(await readFile(join(destination, "sim/packs/Arena.spk.br"))), pack);
      assert.deepEqual(gunzipSync(await readFile(join(destination, "sim/manifest.json.gz"))), manifest);
      await assert.rejects(stat(join(destination, "sim/maps")), { code: "ENOENT" });
      await assert.rejects(stat(join(destination, "objects/master.wav")), { code: "ENOENT" });
      await assert.rejects(stat(join(source, "sim/manifest.json.br")), { code: "ENOENT" });
      assert.equal(await readFile(join(destination, "objects/audio.opus"), "utf8"), "opus");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
