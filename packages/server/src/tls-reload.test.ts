import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { promisify } from "node:util";
import test from "node:test";
import { installTlsReload } from "./tls-reload.ts";

// Actual process signals, filesystem reloads and TLS handshakes require the platform clock.
const delay = (ms: number) => { const done = Promise.withResolvers<void>(); setTimeout(done.resolve, ms); return done.promise; };
test("SIGHUP swaps real certificate fingerprints, retains established connections and survives failed reload", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "soldat-tls-reload-"));
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  const generate = async (name: string) => promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${name}`]);
  await generate("before");
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const errors: Error[] = [], sockets: TLSSocket[] = [];
  const stop = installTlsReload(server, key, cert, error => errors.push(error));
  const peer = async () => {
    const socket = connect({ host: "127.0.0.1", port: address.port, rejectUnauthorized: false }); sockets.push(socket);
    await once(socket, "secureConnect");
    return { socket, fingerprint: socket.getPeerCertificate().fingerprint256 };
  };
  try {
    const before = await peer();
    await generate("after"); process.kill(process.pid, "SIGHUP");
    let after = await peer();
    for (let attempt = 0; after.fingerprint === before.fingerprint && attempt < 100; attempt++) {
      after.socket.destroy(); await delay(10); after = await peer();
    }
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.equal(before.socket.destroyed, false);
    await writeFile(cert, "not a certificate"); process.kill(process.pid, "SIGHUP");
    for (let attempt = 0; errors.length === 0 && attempt < 100; attempt++) await delay(10);
    assert.equal(errors.length, 1); assert.match(errors[0]!.message, /previous context retained/);
    assert.equal((await peer()).fingerprint, after.fingerprint);
    assert.equal(before.socket.destroyed, false);
  } finally {
    stop(); for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise;
    await rm(dir, { recursive: true, force: true });
  }
});
