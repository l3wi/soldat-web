import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { exec, type Evidence } from "./support.ts";

const IMAGE = "soldat-web/fpc:bcd7288";
export interface PacketProfile {
  uplinkDelayMs: number; downlinkDelayMs: number; jitterMs: number; lossPercent: number;
  uplinkKbps?: number; downlinkKbps?: number;
  /** Gilbert-Elliott loss: mean burst length is 100 / endPercent packets. */
  burst?: { startPercent: number; endPercent: number; lossInBurstPercent: number; lossOutsidePercent: number };
  outage?: { atSeconds: number; durationMs: number };
}
export const ACCEPTANCE_PROFILE: PacketProfile = { uplinkDelayMs: 50, downlinkDelayMs: 50, jitterMs: 15, lossPercent: 1 };

/** Dedicated Linux TCP relay; TLS/WSS stays end-to-end opaque. Kernel u32
 * classifiers separate uplink (destination server port) from downlink (source
 * relay port), enabling asymmetric real-packet delay/rate/loss profiles. */
export async function packetGateway(serverPort: number, gatewayPort: number, profile: PacketProfile, evidence: Evidence) {
  const numbers = [serverPort, gatewayPort, profile.uplinkDelayMs, profile.downlinkDelayMs, profile.jitterMs, profile.lossPercent, profile.uplinkKbps ?? 0, profile.downlinkKbps ?? 0,
    ...Object.values(profile.burst ?? {}), ...Object.values(profile.outage ?? {})];
  if (numbers.some(value => !Number.isFinite(value) || value < 0) || profile.lossPercent > 100) throw new Error("Invalid real-packet profile");
  const netem = (delayMs: number, rateKbps?: number) => {
    const delay = delayMs || profile.jitterMs ? `delay ${delayMs}ms${profile.jitterMs ? ` ${profile.jitterMs}ms distribution normal` : ""}` : "";
    const loss = profile.burst ? `loss gemodel ${profile.burst.startPercent}% ${profile.burst.endPercent}% ${profile.burst.lossInBurstPercent}% ${profile.burst.lossOutsidePercent}%` : `loss random ${profile.lossPercent}%`;
    return `limit 10000 ${delay} ${loss}${rateKbps ? ` rate ${rateKbps}kbit` : ""}`;
  };
  const uplink = netem(profile.uplinkDelayMs, profile.uplinkKbps), downlink = netem(profile.downlinkDelayMs, profile.downlinkKbps);
  const hostTools = resolve(tmpdir(), "soldat-net-g4-linux-tools");
  await mkdir(hostTools, { recursive: true });
  const mounts = ["--tmpfs", "/tmp:rw,exec,size=256m", "--tmpfs", "/var/lib/apt:rw,size=128m", "--tmpfs", "/var/cache/apt:rw,size=128m", "--tmpfs", "/var/log:rw,size=16m", "-v", `${hostTools}:/tools`, "-e", "HOME=/tmp", "-e", "TMPDIR=/tmp"];
  const install = "if test ! -x /tools/sbin/tc || test ! -x /tools/usr/bin/socat; then apt-get update && apt-get install -y --download-only --no-install-recommends iproute2 socat && for deb in /var/cache/apt/archives/*.deb; do dpkg-deb -x \"$deb\" /tools; done; fi";
  const setup = await exec("docker", ["run", "--rm", "--pull=never", ...mounts, IMAGE, "sh", "-ec", install], { maxBuffer: 4 * 1024 * 1024 });
  evidence.record({ type: "gateway-provision", image: IMAGE, stdout: setup.stdout, stderr: setup.stderr });
  const identity = await exec("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}} {{.Architecture}}"]);
  evidence.record({ type: "gateway-image", identity: identity.stdout.trim(), profile, topology: "Node/client -> published container socat TCP relay -> host.docker.internal WSS; kernel eth0 egress netem in both directions; TLS end-to-end" });
  const name = `soldat-net-g4-${process.pid}-${Date.now()}`;
  const environment = ["-e", "LD_LIBRARY_PATH=/tools/lib/aarch64-linux-gnu:/tools/usr/lib/aarch64-linux-gnu:/tools/lib/x86_64-linux-gnu:/tools/usr/lib/x86_64-linux-gnu"];
  const command = `export TC_LIB_DIR=/tools/usr/lib/$(uname -m)-linux-gnu/tc; /tools/sbin/tc qdisc add dev eth0 root handle 1: prio bands 3; /tools/sbin/tc qdisc add dev eth0 parent 1:1 handle 10: netem ${uplink}; /tools/sbin/tc qdisc add dev eth0 parent 1:2 handle 20: netem ${downlink}; /tools/sbin/tc filter add dev eth0 parent 1: protocol ip prio 1 u32 match ip dport ${serverPort} 0xffff flowid 1:1; /tools/sbin/tc filter add dev eth0 parent 1: protocol ip prio 2 u32 match ip sport ${gatewayPort} 0xffff flowid 1:2; /tools/sbin/tc -s qdisc show dev eth0; /tools/sbin/tc filter show dev eth0; echo NET_G4_GATEWAY_READY; exec /tools/usr/bin/socat TCP-LISTEN:${gatewayPort},fork,reuseaddr TCP:host.docker.internal:${serverPort}`;
  // arm64's uname is aarch64, x64's is x86_64, matching Debian multiarch paths.
  const child: ChildProcess = spawn("docker", ["run", "--rm", "--pull=never", "--name", name, "--cap-add=NET_ADMIN", ...mounts, ...environment, "-p", `127.0.0.1:${gatewayPort}:${gatewayPort}`, IMAGE, "sh", "-ec", command], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const ready = new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Packet gateway readiness timed out: ${logs}`)), 30_000);
    child.stdout!.on("data", chunk => {
      const text = chunk.toString(); logs += text; evidence.record({ type: "gateway-stdout", text });
      if (logs.includes("NET_G4_GATEWAY_READY")) { clearTimeout(timeout); resolveReady(); }
    });
    child.stderr!.on("data", chunk => { logs += chunk.toString(); evidence.record({ type: "gateway-stderr", text: chunk.toString() }); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Packet gateway exited ${code}: ${logs}`)); });
  });
  try { await ready; }
  catch (error) { await exec("docker", ["stop", "--time", "1", name]).catch(() => {}); throw error; }
  let outageTimer: NodeJS.Timeout | undefined;
  let outageJob: Promise<void> | undefined;
  let outageError: unknown;
  if (profile.outage) outageTimer = setTimeout(() => {
    const requestedMs = profile.outage!.durationMs;
    // Both transitions and the sleep execute in one container process: Docker
    // launch latency is not accidentally added to the configured outage.
    const script = `export TC_LIB_DIR=/tools/usr/lib/$(uname -m)-linux-gnu/tc; /tools/sbin/tc qdisc change dev eth0 parent 1:1 handle 10: netem loss 100%; /tools/sbin/tc qdisc change dev eth0 parent 1:2 handle 20: netem loss 100%; echo OUTAGE_START_NS $(date +%s%N); sleep ${requestedMs / 1000}; /tools/sbin/tc qdisc change dev eth0 parent 1:1 handle 10: netem ${uplink}; /tools/sbin/tc qdisc change dev eth0 parent 1:2 handle 20: netem ${downlink}; echo OUTAGE_END_NS $(date +%s%N); /tools/sbin/tc -s qdisc show dev eth0`;
    outageJob = exec("docker", ["exec", name, "sh", "-ec", script]).then(result => {
      const start = /OUTAGE_START_NS (\d+)/.exec(result.stdout)?.[1], end = /OUTAGE_END_NS (\d+)/.exec(result.stdout)?.[1];
      evidence.record({ type: "gateway-kernel-outage", requestedMs, observedMarkerDurationMs: start && end ? Number(BigInt(end) - BigInt(start)) / 1e6 : null, stdout: result.stdout, stderr: result.stderr });
    });
    outageJob.catch(error => { outageError = error; evidence.record({ type: "gateway-outage-error", error: String(error) }); });
  }, profile.outage.atSeconds * 1000);
  return {
    url: `wss://127.0.0.1:${gatewayPort}`,
    async stats() {
      if (outageError) throw outageError;
      const result = await exec("docker", ["exec", name, "/tools/sbin/tc", "-s", "qdisc", "show", "dev", "eth0"]);
      evidence.record({ type: "gateway-packet-counters", stdout: result.stdout, stderr: result.stderr });
      return result.stdout;
    },
    async close() {
      clearTimeout(outageTimer);
      try {
        if (outageJob) await outageJob;
        await this.stats();
      } finally { await exec("docker", ["stop", "--time", "2", name]); }
    },
  };
}
