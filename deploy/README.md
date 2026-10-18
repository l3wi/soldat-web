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
  import WebSocket from 'ws';
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

**Back up `/etc/soldat/server.json` only** to encrypted off-host storage, and test restoring its permissions (`root:soldat`, 0640). Matches, lobbies, tickets, and scores are ephemeral in-memory state; no game database or writable data directory exists. Versioned deployment files and immutable release artifacts are recovered from the trusted release source, not VPS backups. Reissue TLS through DNS-01 after a rebuild. Store/recreate the scoped Cloudflare token through your normal secret manager; do not add certbot account keys, copied private keys, logs, or `node_modules` to the application backup set.

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
- Use a dedicated non-login `soldat` account. Keep releases root-owned/read-only; `/etc/soldat/server.json` is root:soldat 0640. Container config paths use `/app/build-out/sim/sim.wasm` and `/app/dist/content-next`; set the direct `publicUrl`, exact frontend `allowedOrigins` and only the deployed region. Keep operator credentials outside the release. `/var/lib/soldat`, writable only by the service account, holds the optional `banFile`.
- The shared-host starting ceiling is four match workers, 12 total humans/bots per match, a 2-CPU/2-GiB game container and a 0.5-CPU/256-MiB static container. This is an isolation/capacity ceiling, not measured multi-match throughput. Both containers run non-root, with a read-only root/release, dropped capabilities, bounded temporary storage, PIDs and logs.

Store real deployment values in `/etc/soldat/deployment.env`: `SOLDAT_NODE_IMAGE` (verified Node 24 image digest), `SOLDAT_RELEASE` (immutable absolute release path), `SOLDAT_UID`, `SOLDAT_GID` and `SOLDAT_BIND_IP` (public IPv4). Install the compose file at `/opt/soldat/compose.shared.yml`, then validate and start only this project:

```sh
docker compose --env-file /etc/soldat/deployment.env -f /opt/soldat/compose.shared.yml config --quiet
docker compose --env-file /etc/soldat/deployment.env -f /opt/soldat/compose.shared.yml up -d
```

### Shared-host certificate renewal

Issue a **dedicated** `soldat-api.bwc.ad` certificate through the existing Traefik `letsencrypt` resolver using a separate certificate-only HTTPS router, `noop@internal` and an IP-deny middleware. That port-443 router does not forward gameplay. Do not give the game a host-wide wildcard private key or mount Traefik's ACME/account storage into either container.

Install [`sync-traefik-tls.py`](sync-traefik-tls.py) under `/opt/soldat/ops/`. It selects only the configured domain, checks hostname/expiry/key matching, stages root:soldat 0640 certificate files and atomically switches `/etc/soldat/tls/current`. It sends SIGHUP only to the named running game container; it never restarts Traefik or another application. Run it once after issuance and before initial game startup.

[`soldat-tls-sync.service`](soldat-tls-sync.service) and [`soldat-tls-sync.timer`](soldat-tls-sync.timer) repeat synchronization twice daily and after boot. The supplied unit uses this host's `/root/infra/traefik/acme.json`; adjust that path and the domain deliberately for another host. Enable only this timer after `systemd-analyze verify`; keep previous certificate generations for rollback. Inspect a new public TLS connection and the game logs after reload, rather than treating signal dispatch as certificate validation.

Verify the public HTML/OG/robots/sitemap, direct `/api/ping` and region URLs, denied foreign Origins, an actual WSS join/play/leave and client hash agreement. Confirm direct external socket addresses survive Docker's IPv4 publishing. Observe certificate reload with an admitted client still connected. Do not reset shared firewall/proxy services or claim the broader release matrix passed from these deployment checks.
