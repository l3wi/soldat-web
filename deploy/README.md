# Deploy one Soldat region

How-to for an administrator deploying directly to an **OVHcloud VPS-2 (4 vCores, 8 GB)** running Ubuntu 24.04 LTS or Debian 13. Choose US Dallas Local Zone or an EU location. There is no reverse proxy, container runtime, or CI/CD requirement. Run the host commands as the admin with `sudo`, except the initial provider-console bootstrap.

Stop and resolve any failed command before continuing. Replace example hostnames, keys, email addresses, and release names before executing commands.

OVH anti-DDoS protects the network (L3/L4), not HTTPS/WSS application work. The server's resource, connection, message, creation, and replay budgets remain essential. Limits use the direct socket source address (IPv6 grouped by /64), not forwarded headers. Keep the game hostname **DNS-only / grey-cloud** in Cloudflare.

## 1. Secure administrator access

Keep the provider console and original SSH session open until a **second key-authenticated admin session** succeeds. Substitute your own public key; never copy a private key to the VPS.

```sh
# Initial root/provider-console session:
apt-get update
apt-get install -y sudo openssh-server
adduser admin
usermod -aG sudo admin
install -d -o admin -g admin -m 0700 /home/admin/.ssh
printf '%s\n' 'ssh-ed25519 REPLACE_WITH_YOUR_PUBLIC_KEY' > /home/admin/.ssh/authorized_keys
chown admin:admin /home/admin/.ssh/authorized_keys
chmod 0600 /home/admin/.ssh/authorized_keys
```

After logging in as `admin` with the key, install an early drop-in (OpenSSH normally takes the first value; cloud-init may have later defaults):

```sh
sudo tee /etc/ssh/sshd_config.d/00-soldat.conf >/dev/null <<'EOF'
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo /usr/sbin/sshd -t
sudo /usr/sbin/sshd -T | grep -E '^(pubkeyauthentication|authenticationmethods|passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
sudo systemctl reload ssh
```

Check effective settings for any existing `Match` blocks with `sshd -T -C user=admin,host=YOUR_HOST,addr=YOUR_ADMIN_IP`. Do not close recovery access until another login works. The admin retains a local password for `sudo`, not SSH password authentication.

## 2. Firewall, host updates, and network settings

Copy this directory to the host, then from that directory:

```sh
sudo apt-get install -y ufw unattended-upgrades ca-certificates curl xz-utils openssl util-linux certbot python3-certbot-dns-cloudflare
# Ensure IPV6=yes in /etc/default/ufw, even if no AAAA record is published.
sudo sh ./firewall.sh
sudo install -o root -g root -m 0644 sysctl-soldat.conf /etc/sysctl.d/60-soldat.conf
sudo sysctl --system
sudo dpkg-reconfigure -plow unattended-upgrades
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
sudo tee /etc/apt/apt.conf.d/99-soldat-no-auto-reboot >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
EOF
sudo systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
```

`firewall.sh` deliberately owns/resets UFW on this **dedicated** VPS; rerunning it produces the same rules and removes stale allows. It sets default deny inbound, permits rate-limited TCP 22, TCP 443, and UDP 443 reserved for future WebTransport. No port 80 or current UDP application listener is needed. Outbound traffic remains allowed for DNS, ACME, and updates. Mirror these rules in any OVH network firewall; do not inadvertently block required ICMP/ICMPv6 (UFW's base rules retain it). Plan maintenance reboots for kernel updates; unattended upgrades do not upgrade the separately installed Node tarball.

The sysctl file bounds SYN/accept backlogs, enables overflow SYN cookies, and uses **loose** IPv4 reverse-path checking for asymmetric routing. It does not tune socket buffers, TIME_WAIT, or connection tracking speculatively.

## 3. Install verified Node 24 LTS

Use the official nodejs.org Linux tarball. These commands discover the latest Node **24** patch from its checksum manifest, pin the download to that version, and reject a checksum mismatch. Both manifest and artifact use verified HTTPS; for independent release authentication, additionally verify the manifest's Node release-team signature before extraction.

```sh
work=$(mktemp -d)
cd "$work"
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac
curl --proto '=https' --tlsv1.2 -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
archive=$(grep -E "  node-v24\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz$" SHASUMS256.txt | tr -s ' ' | cut -d ' ' -f2)
test -n "$archive"
node_dir=${archive%.tar.xz}
version=${node_dir%-linux-*}
version=${version#node-}
curl --proto '=https' --tlsv1.2 -fsSLO "https://nodejs.org/dist/$version/$archive"
grep "  $archive\$" SHASUMS256.txt | sha256sum -c -
sudo install -d -o root -g root -m 0755 /usr/local/lib/nodejs
sudo tar --no-same-owner -xJf "$archive" -C /usr/local/lib/nodejs
sudo chown -R root:root "/usr/local/lib/nodejs/$node_dir"
sudo chmod -R go-w "/usr/local/lib/nodejs/$node_dir"
sudo ln -sfn "/usr/local/lib/nodejs/$node_dir/bin/node" /usr/local/bin/node
/usr/local/bin/node --version
```

Confirm the version is `v24.*`. Record its exact version and checksum in the release record. Retain the preceding Node installation for rollback; repeat this process for security patches. The service uses `/usr/local/bin/node`; no `npm`, Bun, compiler, or shell wrapper is required at runtime.

## 4. Install an immutable application release and config

Prepare a trusted release outside the running VPS with the repository's locked dependency install (`bun install --frozen-lockfile`). Include the root `package.json`, runtime `node_modules` dependency tree with its workspace symlinks intact, `packages/server`, `packages/protocol`, `packages/sim-host`, the frozen `build-out/sim/sim.wasm`, and the validated `dist/content-next` import. The content directory must include both `index.json` and the complete raw `sim/manifest.json` content set, not just browser packs. Preserve workspace sources outside `node_modules`: Node runs their TypeScript directly. Do not rebuild or replace the frozen simulation as part of deployment. No `.git`, dev TLS keys, or local configuration belongs in the release.

```sh
sudo useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin soldat
sudo install -d -o root -g root -m 0755 /opt/soldat
sudo install -d -o root -g soldat -m 0750 /etc/soldat
# Extract your trusted release archive into a NEW, root-owned directory:
release=2026-10-16-REPLACE_WITH_COMMIT
sudo install -d -o root -g root -m 0755 "/opt/soldat/$release"
sudo tar --no-same-owner -xf /path/to/soldat-release.tar -C "/opt/soldat/$release"
sudo chown -R root:root "/opt/soldat/$release"
sudo chmod -R go-w "/opt/soldat/$release"
echo "13b1d078ce0556fc7e8c4d0a53bbbb7da56f37bad6d19eb9f6803e9559ff745c  /opt/soldat/$release/build-out/sim/sim.wasm" | sha256sum -c -
sudo ln -s "$release" /opt/soldat/current.new
sudo mv -Tf /opt/soldat/current.new /opt/soldat/current
# Return to the copied deploy/ directory for the remaining relative filenames.
sudo install -o root -g soldat -m 0640 server.example.json /etc/soldat/server.json
sudoedit /etc/soldat/server.json
```

All release directories must be readable/traversable by `soldat`, never writable by it. The initial `useradd` is one-time; reuse the existing dedicated account during upgrades. Set `publicUrl` to this machine's HTTPS origin, update `allowedOrigins` to the exact static-client HTTPS origin, and choose a new u64 decimal `matchSeed` if desired (it is not a credential). TLS paths already point to the hook's atomic certificate pair.

The example includes **us/eu** entries to show the schema. **For a one-region deployment, remove the undeployed entry**; never advertise an unreachable region. On EU, also change `publicUrl` to `https://eu.play.example.com` and the displayed region name as appropriate. Publish an A record; publish AAAA only after binding IPv6 too. The example's `0.0.0.0` listener is IPv4-only; `host: "::"` can provide dual-stack on these Linux hosts, but verify both address families before adding AAAA.

`maxMatches: 24` and `targetPlayers: 12` are starting capacity ceilings for this 4-vCore/8-GB machine, **not a measured throughput guarantee**. Load-test your actual map/population mix and lower the ceiling if scheduling or memory pressure rises. Six of 24 match slots are reserved for public play. The remaining application limit keys in the example match the production defaults documented in [the server reference](../packages/server/README.md#configuration-reference): per-IP ownership/admissions, short idle reclamation, AFK/lobby expiry, bounded queues, replay work, aggregate control messages, and lookup/creation budgets. Shared NAT clients share per-IP quotas; do not raise those limits to compensate without considering abuse. Config changes require a restart; SIGHUP reloads **TLS only**.

## 5. Issue TLS through Cloudflare DNS-01

Create a Cloudflare API token restricted to this zone, with **Zone / DNS / Edit** and **Zone / Zone / Read**. Keep it root-only; do not use the global API key. DNS validation needs no inbound port 80 and works with a grey-cloud game record.

```sh
sudo install -d -o root -g root -m 0700 /root/.secrets/certbot
sudo install -o root -g root -m 0600 /dev/null /root/.secrets/certbot/cloudflare.ini
sudoedit /root/.secrets/certbot/cloudflare.ini
# File content: dns_cloudflare_api_token = YOUR_RESTRICTED_TOKEN
sudo install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo install -o root -g root -m 0755 certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/soldat-tls
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/certbot/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 60 \
  --cert-name soldat-server -d us.play.example.com \
  --email YOUR_ACME_EMAIL --agree-tos --non-interactive
sudo systemctl enable --now certbot.timer
```

Use the EU hostname instead when deploying EU. The deploy hook handles only `/etc/letsencrypt/live/soldat-server`; it stages root:soldat **0640** key/fullchain files inside a root:soldat **0750** generation directory under `/etc/soldat/tls/`, then atomically switches `tls/current`. The service cannot access `/root` or certbot's original private keys. Initial issuance skips reload because the service is not running yet. If installing the hook after issuance, run it explicitly:

```sh
sudo env RENEWED_LINEAGE=/etc/letsencrypt/live/soldat-server /etc/letsencrypt/renewal-hooks/deploy/soldat-tls
```

Renewal calls `systemctl reload soldat-server` to send SIGHUP. Existing connections keep working; invalid replacement files leave the old in-memory TLS context in use and log an error instead of exiting. Reload dispatch is asynchronous: inspect the journal and the certificate served by a **new** TLS connection. Retained generation directories permit manual certificate rollback; remove obsolete generations during maintenance, never the `current` target. Do not point an active server at ACME staging certificates. Test renewal with `sudo certbot renew --dry-run` **without** `--run-deploy-hooks`, so staging certificates cannot be deployed.

## 6. Enable the service and bounded journals

```sh
sudo install -o root -g root -m 0644 soldat-server.service /etc/systemd/system/soldat-server.service
sudo install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/60-soldat.conf >/dev/null <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=512M
SystemKeepFree=1G
RuntimeMaxUse=64M
MaxRetentionSec=14day
RateLimitIntervalSec=30s
RateLimitBurst=1000
EOF
sudo systemctl restart systemd-journald
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/soldat-server.service
sudo systemctl enable --now soldat-server
sudo systemctl status soldat-server --no-pager
sudo journalctl -u soldat-server -n 50 --no-pager
```

Journal limits are **host-wide**, not just this unit. Review rate-limit suppression notices during incidents; the journal is not a backup or a full packet/access log.

The unit grants only `CAP_NET_BIND_SERVICE` for port 443. Application/config/runtime trees are read-only; only isolated private temporary space is writable. It caps memory at 6 GB with pressure beginning at 5 GB and bounds tasks and descriptors. `MemoryDenyWriteExecute` is deliberately **omitted**: Node V8 and WebAssembly JIT require executable memory. The `@system-service` syscall set is intentional; a narrower guessed list can break worker threads/JIT. Target-host verification below is required after Node/systemd upgrades. No capability should be added just to improve a benchmark or suppress a warning.

## 7. Verify before directing players here

- `curl --fail --show-error https://us.play.example.com/api/ping` returns `{"ok":true}` without `-k`.
- Fetch `/api/regions`; it advertises only deployed endpoints. Check the same ping over IPv6 if publishing AAAA.
- From a trusted admin checkout/release with the installed `ws` dependency, open WSS using the actual public certificate and allowed client Origin (no browser required):

  ```sh
  cd /opt/soldat/current
  /usr/local/bin/node --input-type=module <<'JS'
  import { createRequire } from 'node:module';
  const WebSocket = createRequire(`${process.cwd()}/packages/server/package.json`)('ws');
  const base = 'https://us.play.example.com';
  const origin = 'https://play.example.com';
  const response = await fetch(`${base}/api/lobbies`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'dm', map: 'Arena' }),
  });
  if (!response.ok) throw new Error(`Lobby HTTP ${response.status}`);
  const lobby = await response.json();
  const ws = new WebSocket(lobby.wsUrl, { origin });
  const timeout = setTimeout(() => { ws.terminate(); process.exitCode = 1; }, 10000);
  ws.on('error', error => { console.error(error); process.exitCode = 1; });
  ws.on('open', () => { console.log('WSS TLS/upgrade OK'); ws.close(); });
  ws.on('close', () => clearTimeout(timeout));
  JS
  ```

  This exercises TLS, Origin acceptance, and upgrade only, not simulation admission. Its empty lobby expires automatically; do not loop this capacity-limited check. Complete one real client join/play/leave after publishing the client.
- `sudo systemd-analyze security soldat-server` prints an exposure score. Record it with the deployment; **lower is better**. Inspect each residual exposure rather than chasing a zero score with V8-breaking restrictions. This is a static sandbox assessment, not proof of application security.
- Check `sudo ufw status verbose`, `sudo ss -lntup`, and `sudo systemctl show soldat-server -p User -p MemoryCurrent -p MemoryHigh -p MemoryMax -p TasksCurrent`. Expect only the intended public services, no port 80 listener, and no game UDP listener yet.
- Run `sudo systemctl reload soldat-server`; confirm the process and existing sessions survive, no reload error appears in `journalctl -u soldat-server`, and a new TLS connection serves the expected certificate. Check `systemctl list-timers certbot.timer` and the dry-run renewal described above.

## 8. Host the static client on Cloudflare Pages

Build on a trusted build machine with the same frozen WASM and content import, using `VITE_SERVER_URL=wss://us.play.example.com bun run --cwd packages/client build`. Deploy **`dist/client`** to Cloudflare Pages and attach `https://play.example.com`. This variable is baked into the client; rebuild to change its initial API/WSS origin. Set every game server's `allowedOrigins` to `["https://play.example.com"]` (add exact preview origins only if intentionally supported). Region endpoints remain server-owned. The static website may use Cloudflare's CDN, but **us/eu game DNS records must remain DNS-only/grey-cloud**, directly reaching this service on 443.

## 9. Backups, upgrades, and rollback

Back up `/etc/soldat/server.json` and the configured `banFile`, if enabled, to encrypted off-host storage. Test restoring the config's root:soldat 0640 permissions and the ban file's service-only writable access. Matches, lobbies, tickets and scores remain ephemeral in-memory state; there is no game database. Recover versioned deployment files and immutable releases from the trusted release source. Reissue TLS through DNS-01 after a rebuild. Store/recreate the scoped Cloudflare token through your normal secret manager; do not add certbot account keys, copied private keys, logs or `node_modules` to the application backup set.

For an upgrade:

1. Stage a **new** root-owned `/opt/soldat/<release>` and verify the frozen WASM checksum exactly as above. Keep the old release, Node installation, and compatible configuration snapshot. Never edit `current` in place.
2. Announce a maintenance window: restarting loses live matches and lobby state. Stop with `sudo systemctl stop soldat-server` and allow SIGTERM up to 45 seconds.
3. If needed, install a verified patched Node 24 and update the root-owned `/usr/local/bin/node` link. Apply only intended config changes with `sudoedit` and retain root:soldat 0640. Update/reload the unit only if changed.
4. Atomically select the new release: `sudo ln -s NEW_RELEASE /opt/soldat/current.new && sudo mv -Tf /opt/soldat/current.new /opt/soldat/current`. Run `sudo systemctl daemon-reload` after any unit changes, then `sudo systemctl start soldat-server` and the checklist above. Use `sudo systemctl reset-failed soldat-server` first only if a previous crash loop hit the start limit.
5. If startup, TLS, WSS, or play verification fails, stop the service, atomically repoint `current` to the retained old release, restore its config snapshot and prior Node link if changed, and start/verify again. Rollback does **not** restore in-memory matches. Do not erase the prior release until the replacement is accepted.

No deployment step changes the frozen simulation hash `13b1d078ce0556fc7e8c4d0a53bbbb7da56f37bad6d19eb9f6803e9559ff745c`. Historical gate reports retain the hashes of the artifacts they actually measured.

## Shared Docker/Traefik host

[`compose.shared.yml`](compose.shared.yml) is the alternative for an existing Docker host such as the deployed `soldat.bwc.ad` site. **Do not run the dedicated-host firewall reset, SSH changes or host-wide journal setup above on a shared machine.** Add only the application account/directories, its containers, its certificate-sync timer and its own proxy routing.

- Serve the static client through the existing `proxy` Docker network and HTTPS router. The client container runs the existing production static server on internal port 8080; it has no API forwarding route and no published host port.
- Keep game HTTPS/WSS direct: `https://soldat-api.bwc.ad:7443`, with a DNS-only A record and only the intended public IPv4 address published. The frontend can remain Cloudflare-proxied at `https://soldat.bwc.ad`. Do not advertise API IPv6 without verifying source-address preservation and reachability.
- Build the client with `SITE_URL=https://soldat.bwc.ad SITE_INDEXABLE=true VITE_SERVER_URL=wss://soldat-api.bwc.ad:7443`. This emits the public canonical/OG/sitemap/robots metadata and bakes in the direct game endpoint.
- Prepare the immutable release with the locked production dependencies, runtime workspace sources, `packages/client/scripts`, the built `dist/client`, complete `dist/content-next` and the frozen WASM. Do not include `.git`, workstation paths, private config, keys or dev credentials.
- Include matching `.br` and `.gz` sidecars when deploying changed HTML or assets. An origin can serve a new uncompressed index but an obsolete compressed index if sidecars are left from the previous build. Verify identity/gzip/Brotli HTML all reference the expected hashed entry and compare the served JavaScript checksum with the tested build; a dynamic CDN response does not rule out stale origin sidecars.
- Use a dedicated non-login `soldat` account. Keep releases root-owned/read-only; `/etc/soldat/server.json` is root:soldat 0640. Container config paths use `/app/build-out/sim/sim.wasm` and `/app/dist/content-next`; set the direct `publicUrl`, exact frontend `allowedOrigins` and only the deployed region. Keep operator credentials outside the release. `/var/lib/soldat`, writable only by the service account, holds the optional `banFile`.
- The shared-host starting ceiling is four match workers, 12 total humans/bots per match, a 2-CPU/2-GiB game container and a 0.5-CPU/256-MiB static container. This is an isolation/capacity ceiling, not measured multi-match throughput. Both containers run non-root, with a read-only root/release, dropped capabilities, bounded temporary storage, PIDs and logs.

Store real deployment values in `/etc/soldat/deployment.env`: `SOLDAT_NODE_IMAGE` (verified Node 24 image digest), `SOLDAT_RELEASE` (immutable absolute release path), `SOLDAT_UID`, `SOLDAT_GID` and `SOLDAT_BIND_IP` (public IPv4). Install the compose file at `/opt/soldat/compose.shared.yml`, then validate and start only this project:

```sh
docker compose --env-file /etc/soldat/deployment.env -f /opt/soldat/compose.shared.yml config --quiet
docker compose --env-file /etc/soldat/deployment.env -f /opt/soldat/compose.shared.yml up -d
```

### Shared-host performance logs

The production launcher emits aggregate JSON match/runtime summaries to stdout every **10 seconds** and flushes remaining summaries during graceful shutdown. See the [server metrics reference](../packages/server/README.md#performance-logging) for scope and privacy boundaries. No public metrics endpoint, dashboard, client tracking or browser instrumentation is added.

Only this project's Docker `json-file` logs use this budget:

| Container | `max-size` | `max-file` | Nominal retained bytes |
| --- | --- | --- | --- |
| `soldat-server` | `"30000000"` (bytes) | `"30"` | 900,000,000 |
| `soldat-client` (unchanged) | `10m` (10,485,760 bytes) | `"3"` | 31,457,280 |
| **Combined** | | | **931,457,280** |

This leaves **68,542,720 bytes** below 1,000,000,000 bytes for rotation/record headroom. It is a nominal retention budget, not a filesystem quota or a time-retention guarantee; record boundaries and filesystem metadata can add overhead. Docker rotates at `max-size` and removes the oldest file when rotation would exceed `max-file`, overwriting the oldest retained history rather than growing indefinitely. These settings cover all stdout/stderr records from the two containers, not only performance summaries. See [Docker's json-file driver reference](https://docs.docker.com/engine/logging/drivers/json-file/).

Docker retains this history for the lifetime of the container. Removing/recreating a container removes its local log history; this is not durable cross-deployment storage. Keep bounded investigation receipts before a rollout when needed, rather than creating an unbounded second log stream.

Do not add application log files, volumes, unlimited `tee`/exports or an external logging service. Do not change global Docker or journald settings on the shared host. The dedicated-host **512M host-wide journal** policy above is a separate deployment option and remains untouched; neither unrelated containers nor host journals/backups are included in this Docker budget.

Read bounded recent records without creating another retained copy:

```sh
docker logs --since 15m --tail 300 soldat-server
docker logs --since 15m --tail 300 soldat-server 2>/dev/null | jq -R 'fromjson? | select(.type == "match_performance" or .type == "server_performance")'
# Follow a bounded initial tail; stop with Ctrl-C (do not redirect/tee to a file):
docker logs --since 1m --tail 30 --follow soldat-server
```

RTT distributions aggregate fresh successful raw server ping/pong probes once per validated pong across the reporting window, without repeated peer snapshots or player identifiers; they do not measure packet loss or one-way latency. Outbound byte counts are application payload bytes **offered** to transport, not confirmed delivery or TLS/IP wire bytes. Inbound counts include application packets rejected by the codec. Worker metrics use monotonic wall time and continue during paused/slow-motion matches; paused simulation contributes no simulation samples or tick progression. Process runtime records continue independently.

**Deployment verification:** recreate the game container with the updated Compose configuration; inspect `docker inspect soldat-server --format '{{json .HostConfig.LogConfig}}'` for `json-file`, `max-size: "30000000"` and `max-file: "30"`; confirm the client's existing `10m`/`3` settings; observe successive JSON summaries at roughly ten-second intervals and inspect their privacy-safe fields. A restart alone does not replace an existing container's logging options. Record actual deployment evidence separately; the initial deployment record does not establish these later settings or metrics.

### Shared-host certificate renewal

Issue a **dedicated** `soldat-api.bwc.ad` certificate through the existing Traefik `letsencrypt` resolver using a separate certificate-only HTTPS router, `noop@internal` and an IP-deny middleware. That port-443 router does not forward gameplay. Do not give the game a host-wide wildcard private key or mount Traefik's ACME/account storage into either container.

Install [`sync-traefik-tls.py`](sync-traefik-tls.py) under `/opt/soldat/ops/`. It selects only the configured domain, checks hostname/expiry/key matching, stages root:soldat 0640 certificate files and atomically switches `/etc/soldat/tls/current`. It sends SIGHUP only to the named running game container; it never restarts Traefik or another application. Run it once after issuance and before initial game startup.

[`soldat-tls-sync.service`](soldat-tls-sync.service) and [`soldat-tls-sync.timer`](soldat-tls-sync.timer) repeat synchronization twice daily and after boot. The supplied unit uses this host's `/root/infra/traefik/acme.json`; adjust that path and the domain deliberately for another host. Enable only this timer after `systemd-analyze verify`; keep previous certificate generations for rollback. Inspect a new public TLS connection and the game logs after reload, rather than treating signal dispatch as certificate validation.

Verify the public HTML/OG/robots/sitemap, direct `/api/ping` and region URLs, denied foreign Origins, an actual WSS join/play/leave and client hash agreement. Confirm direct external socket addresses survive Docker's IPv4 publishing. Observe certificate reload with an admitted client still connected. Do not reset shared firewall/proxy services or claim the broader release matrix passed from these deployment checks.

## Public deployment record

Initial deployment, **2026-10-18**:

- Public source: [l3wi/soldat-web](https://github.com/l3wi/soldat-web). Running application source commit: `ab925afd89482ac0e215edce2cf58768e7a41713`.
- Site: **https://soldat.bwc.ad**. Direct game API: **https://soldat-api.bwc.ad:7443**; gameplay uses the corresponding `wss://` endpoint. Only this deployed region is advertised.
- Existing shared Linux x86_64 host; no new VPS provisioned. Node **24.22.0**, image `node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`. Locked production dependencies installed with Bun **1.3.14**; Bun is not the application runtime.
- Frozen WASM: `13b1d078ce0556fc7e8c4d0a53bbbb7da56f37bad6d19eb9f6803e9559ff745c`; content set: `710dc47da59a5b779c6ac2efbe050d8226d34182b161fb0a21b5a2b5de87533e`; wire **7**, simulation ABI **6**.
- Four-worker ceiling, **12 total humans/bots** per match. The two non-root containers' read-only roots, dropped capabilities, no-new-privileges, CPU/memory/PID limits and zero restarts were observed. The existing Traefik process remained running without a restart.
- Private operator configuration stays outside the release. Persistent bans use `/var/lib/soldat`; the dedicated leaf-certificate sync timer is enabled. The app cannot read Traefik's ACME store or unrelated keys.

Executed checks:

- Client typecheck, 12 hosting checks and the public production build passed.
- Public CA-verified HTTPS homepage, canonical/indexable/OG metadata, robots, sitemap and the **1200×630** OG PNG passed. Direct API TLS/HSTS and allowed Origin passed; foreign Origin returned 403; the static frontend did not proxy the API.
- Two public CA-verified WSS clients used the real `OnlineSession` and confirmed/predicted WASM replicas. Both joined the same match in different slots, exchanged real inputs and retained 12 active players. Confirmed hashes matched throughout: **zero mismatches**, with 42 and 40 matches at the post-reload checkpoint.
- Docker's direct game connections retained the verified external caller address, rather than collapsing to the bridge/proxy address.
- The certificate-sync helper dispatched SIGHUP while both clients remained admitted. The process PID and slots stayed unchanged; confirmed ticks/hashes continued, and a fresh CA-verified TLS connection served the staged leaf certificate. One client's departure refilled with a bot while the other continued with zero mismatches.

No live browser check was performed, at the user's request; verification used network/API scenarios. This smoke does not qualify sustained capacity, the impaired-network matrix, a future certificate renewal, or the broader release criteria. No external ICE/TURN service was configured or qualified. Local ignored receipts are `build-out/deploy/http-verification.json` and `build-out/deploy/wss-verification.json`; they contain no admission tickets or operator credentials.

### Performance logging rollout

Enabled **2026-10-18**, server source commit `a7e5dec0d1a10bb2da47672a0145502a11e40030`:

- Server typecheck, 59 unit tests (including 13 logger behavior cases) and 27 platform cases passed. A real local production process logged active and paused windows, continued fresh RTT probes while paused, resumed gameplay, and shut down with a final flush. Both real WASM clients retained zero confirmed-state hash mismatches.
- An isolated Docker rotation probe emitted 1,000 records with a three-file budget. Only the newest six records remained across three files (3,690 bytes), demonstrating oldest-history removal and the documented per-record threshold overshoot. The disposable container was removed; this did not flood the live game's logs.
- The live game container was recreated only after observing zero established game-port connections. The static client and shared proxy were not restarted; private operator configuration and the frozen WASM stayed unchanged. The previous immutable release remains available for rollback.
- Live inspection confirmed `json-file` with `30000000`/`30` for the server and unchanged `10m`/`3` for the client: **931,457,280 nominal retained bytes combined**, with headroom below one decimal GB.
- Two public CA-verified WSS clients completed real prediction/confirmed simulation with **55/49 matching hash checkpoints and zero mismatches**. Five match and five runtime summaries were observed, including populated RTT/simulation/traffic metrics, no logger drops/write errors, and no probe nicknames or operator credentials in output.

Ignored local receipts: `build-out/deploy/performance-smoke-local.json`, `performance-smoke-live.json`, `log-rotation-verification.json` and `logging-live-verification.json`. These checks establish functioning bounded logging, not sustained-capacity, client-rendering or impaired-network qualification.

### Movement and server-timing fixes

Deployed **2026-10-19**, source commit `1443e5cb07b76e1c374a8f26ce60003abc27aa24`:

- Local root, skeleton, camera and predicted cosmetics now share the online presentation phase. Reconciliation preserves fractional pose continuity; native input/follow rules, fixed-step gameplay, interpolation limits and the frozen WASM are unchanged. See [movement evidence](../packages/client/README.md#movement-smoothing-verification--2026-10-19).
- The server removes one redundant same-step render export, with exact transcript/state/hash equivalence across five scenarios and five alternating-order timing pairs. See the [measured server results](../packages/server/README.md#timing-investigation--2026-10-19). Fourteen bounded fire-admission reason fields distinguish timing/history/action/weapon/cooldown decisions without relaxing policy.
- Checks passed: 162 client tests, 60 server unit tests, 42 gameplay/lag-compensation cases, 27 platform cases, client/server typechecks, and the public client build. The build retains the existing large-Phaser-chunk warning.
- Real public CA-verified WSS gameplay used the new client session at requested 60/120/144 Hz cadences, with 16/15/16 matching hash checkpoints respectively, zero mismatches and zero resyncs. This is numeric/network proof, not actual browser/display smoothness verification.
- The deployed HTML was checked with identity, gzip and Brotli negotiation. Each referenced `/assets/index-YV0tbB3A.js`; its served SHA-256 matched the tested build (`76a7be3c460ade8cb55159ffc23661cee19c93b73230966ab3a2a27541befee5`). Matching HTML sidecars are required as part of immutable artifact assembly.
- The game rollout began with zero established game-port connections. The shared proxy and private operator configuration stayed unchanged; previous valid releases remain for rollback. Server release is `/opt/soldat/releases/1443e5cb07b7`; the complete compressed client artifacts are in the corresponding `-web` release. The client-only artifact correction did not restart the game server.
- Live logs contained all fourteen reason keys, reconciling with aggregate rejection/fallback counters, no logger drops/write errors, and no probe nicknames or operator credentials. A representative active window measured simulation/encoding p99 7.21 ms and tick-lateness p99 1.34 ms with zero overloads/discarded steps; this short sample is not a capacity qualification. The combined nominal log budget remains 931,457,280 bytes.

Ignored receipts: `build-out/movement-network-live-results.json`, `build-out/deploy/smoothing-public-assets.json`, `smoothing-html-representations.json` and `smoothing-live-logs.json`. Browser/visual verification remains excluded by the user's explicit network/API-only choice.

### Playback, worker processing and prediction bootstrap rollout

Deployed **2026-10-19**, application source commit `4847c60`:

- Both containers use the immutable release `/opt/soldat/releases/4847c60`. The rollout began with zero established game-port connections. The preceding `1443e5cb07b7-web` release remains available for rollback; the shared proxy was not restarted.
- Remote playback keeps a monotonic interpolation reserve; the client primes cold prediction timing without relaxing server input admission. Worker processing reuses safe pre-wake render state and publishes full-window schema-two diagnostics. The frozen WASM, ABI 6, wire 7 and default 12-player population are unchanged.
- The public production build, server typecheck, 73 server unit tests and five native worker-processing regressions passed before activation. Earlier client/bootstrap/integration verification is recorded in the client and server references.
- Public identity, gzip and Brotli HTML all reference `/assets/index-CVSeB4Ah.js`. The served entry matches the tested build SHA-256 `f903a9811cdbcbc7f707cb231328e0a160926dc549c240e062ebdd391cda9fdd`. Cloudflare adds its existing beacon to public HTML, so verification checks the release entry and metadata rather than demanding byte identity with origin HTML.
- Three public CA-verified WSS clients joined the same Aero match in distinct slots at requested 60/120/144 Hz Node update cadences. Each retained 12 active soldiers and completed 32 matching confirmed-state hash checkpoints, with zero mismatches, resyncs, backward playback-clock samples or client errors. Scheduled inputs were consumed and soldiers moved; all probe connections closed afterward.
- Live schema-two match and runtime summaries use full-window histograms. The retained four match windows show no overloads or discarded steps; seven runtime windows show no logger drops, invalid metadata/reports or write errors. Transport queueing, playback underruns and startup held/neutral input still occurred: this is deployment interoperability evidence, not proof of jitter-free play or sustained capacity.
- Both production containers were running with zero restarts. The private server configuration checksum and Node image are unchanged. Server `30000000`/`30` and client `10m`/`3` log rotation remain unchanged, retaining the combined nominal 931,457,280-byte budget.

Ignored receipts: `build-out/deploy/optimizations-live-verification.json`, `optimizations-live-telemetry.json` and `optimizations-deployment.json`. Verification remains network/API-only; no browser/display smoothness claim is made.
