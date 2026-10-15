import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Evidence } from "./support.ts";
import { packetGateway } from "./impairment.ts";
import { distribution } from "./workload.ts";

test("existing Docker image routes asymmetric real TCP packets through kernel netem", async () => {
  const out = resolve(process.env.NET_G4_PACKET_OUT ?? "build-out/net-g4/packet-path");
  await mkdir(out, { recursive: true });
  const evidence = new Evidence(resolve(out, "packets.jsonl"));
  const server = createServer(socket => { socket.setNoDelay(true); socket.on("data", bytes => socket.write(bytes)); });
  server.listen(0, "0.0.0.0"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP echo address");
  const gateway = await packetGateway(address.port, 9444, { uplinkDelayMs: 10, downlinkDelayMs: 90, jitterMs: 5, lossPercent: 0, outage: { atSeconds: 0.3, durationMs: 500 } }, evidence);
  const samples: number[] = [];
  try {
    const socket = createConnection({ port: 9444, host: "127.0.0.1" }); socket.setNoDelay(true);
    await once(socket, "connect");
    try {
      for (let sequence = 0; sequence < 8; sequence++) {
        const payload = Buffer.alloc(128, sequence), received = once(socket, "data"), start = performance.now();
        socket.write(payload); const [echo] = await received;
        assert.deepEqual(echo, payload); samples.push(performance.now() - start);
      }
      const counters = await gateway.stats();
      assert.match(counters, /delay 10ms/); assert.match(counters, /delay 90ms/);
      const timing = distribution(samples);
      assert.ok(timing.p50 !== null && timing.p50 >= 80, `kernel 100 ms path was bypassed: ${JSON.stringify(timing)}`);
      assert.ok((counters.match(/Sent [1-9][0-9]* bytes [1-9][0-9]* pkt/g) ?? []).length >= 2, "Both directional qdiscs must carry actual packets");
      assert.match(counters, /dropped [1-9][0-9]*/, "Real outage must drop kernel packets before restoration");
      assert.match(counters, /delay 10ms\s+5ms/); assert.match(counters, /delay 90ms\s+5ms/);
      await writeFile(resolve(out, "summary.json"), JSON.stringify({ type: "real-packet-path", topology: "dedicated socat TCP relay; Linux eth0 egress u32 classifiers; no application message drops", uplinkDelayMs: 10, downlinkDelayMs: 90, jitterMs: 5, outageRequestedMs: 500, samplesMs: samples, rttMs: timing, counters }, null, 2));
    } finally { socket.destroy(); }
  } finally {
    await gateway.close();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await evidence.close();
  }
});
