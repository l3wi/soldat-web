# Authoritative server

Node 24 HTTPS/WSS control plane for private development builds of Soldat Online. Each match runs the existing OpenSoldat WASM in its own worker thread. This package never rebuilds the simulation. The Soldat name requires THD/MM permission before public launch; see [SPEC D10](../../SPEC.md).

## Run locally

From the repository root after `bun install`, with the existing `build-out/sim/sim.wasm` and imported `dist/content-next` present:

```sh
bun run --cwd packages/server dev
```

The launcher reuses or creates a self-signed localhost certificate under `build-out/server-dev/` using the existing OpenSSL flow, writes a local configuration there, and starts Node on **https://127.0.0.1:7443**. Visit `/api/ping` in the browser and trust the development certificate before joining via WSS. This does not modify the simulation, the content import, or the user's client dev server.

For a new client dev process:

```sh
VITE_SERVER_URL=wss://127.0.0.1:7443 bun run --cwd packages/client dev --port 5195
```

An existing client process needs its server endpoint configured separately; do not stop a user-owned process. `SOLDAT_SERVER_PORT` changes the local port. `SOLDAT_CONTENT_ROOT` selects an alternate imported content root. `regions.local.json` declares the sole **Local** region; the launcher keeps its URL aligned with the actual local port. There are no synthetic regions, latency values, or roster members.

To use your own TLS and deployment configuration:

```sh
SOLDAT_SERVER_CONFIG=/absolute/path/server.json node packages/server/src/main.ts
```

## Configuration reference

Required JSON fields: `wasmPath`, `contentRoot`, `map`, `matchSeed` (u64 decimal string), `rules`, `tlsKeyPath`, `tlsCertPath`. The content root must contain both `index.json` and the raw `sim/manifest.json` content set. Relative paths resolve against the process working directory. No TLS key belongs in version control.

| Field | Default | Meaning |
| --- | --- | --- |
| `host`, `port` | `0.0.0.0`, `443` | TLS listener |
| `publicUrl` | local listener origin | External HTTPS origin; set explicitly behind a proxy |
| `targetPlayers` | `16` | Humans plus bots per public match and friend lobby, 1–32 |
| `maxMatches` | `8` | Worker/WASM capacity; excess creation returns 503 |
| `regions` | current listener as Local | Configured `{id,name,url}` entries with HTTPS origins |
| `allowedOrigins` | localhost/127.0.0.1 HTTP port 5195 | Explicit CORS/WSS origin allowlist; no wildcard |
| `rules.botDifficulty` | native default `100` | Original 0–300 skill value |
| `rules.world` | `original` | Native gameplay world; `fixture` is for controlled qualification |

The programmatic `createPlatformServer` additionally accepts `maxLobbies` (128), `idleMs` (300000), and `reservationMs` (30000). `allowedOrigins` is also supported in server JSON configuration. The local launcher explicitly allows HTTP localhost/127.0.0.1 on ports **5195, 5198 and 5199**, permitting private capture servers without touching the user's server. Other origins remain rejected. Source-IP limits use the direct socket address, never an untrusted forwarded header. Configure a trusted proxy's own rate limits if deploying behind one.

## API reference

See the [shared protocol reference](../protocol/README.md#matchmaking-http-reference) for complete request/response and binary payload layouts.

- `GET /api/ping`: tiny no-store RTT probe.
- `GET /api/regions`: actual configured regions.
- `POST /api/quickplay {nickname}`: lowest-load available public match, or a new bot-capable DM rotation match. Returns `{matchId,wsUrl,map,mode,humans,bots}`. Connect with the existing binary hello using the returned single-use, expiring ticket URL.
- `POST /api/lobbies {mode,map}`: returns `{code,hostToken,wsUrl}`. Keep the token secret; share `/?lobby=CODE`.
- `GET /api/lobbies/:code`: public lobby state plus canonical lobby `wsUrl`, never the host token or a usable match-admission ticket. Use this WSS URL even when the HTTP API is reached through a development proxy.
- Lobby WSS `/lobbies/CODE`: `lobby-join`, `lobby-update`, `lobby-ready`, `lobby-start`, `lobby-leave`; receives personalized `lobby-state {selfId,state}` or `lobby-error {reason}`.

Only the host can change setup/start; setup changes clear guest readiness. All guests must be ready. Late joiners enter the same started match and replace a bot. Host departure closes an unstarted lobby; a started match survives. Empty lobbies and matches with no humans/reservations are reclaimed after five minutes. Outstanding tickets expire after 30 seconds. The server bounds match/lobby/roster capacity, body/packet sizes, and admission waits; malformed and abusive requests do not start unbounded workers.

## Population ownership

Dynamic targets start full of original waypoint bots. A human join removes a bot through the simulation's original leave command before joining; a human departure rejoins an original rotating profile in a free slot. Every CTF join chooses the less populated team, keeping the full target balanced. Humans plus bots never exceed 32. Profile names, appearance, loadouts, scores and gameplay stay simulation-owned.

`createGameServer` remains the lower-level single-match API used by existing capture/security qualification. Its fixed `botCount` configuration is unchanged when `targetPlayers` is absent. Both APIs require TLS; there is no insecure WebSocket fallback.

## Input relay reference (protocol v4)

Admission sends `welcome`, then one full `state` at a completed step boundary; subsequent `ticks` messages start with that boundary's step. No ACK gates input relay or timing probes. Every two ticks the worker encodes one shared ordered record buffer and the listener adds each recipient's consumed-input sequence header. Human input rosters are self-contained per message; later steps compress unchanged controls. Bots never appear in the input roster.

All runtime membership and weapon commands are retained as exact JSON bytes and replayed before their corresponding step. A successful lag-compensation insertion sends `correct`, then a boundary `hash`; recipients synchronized after that historical tick receive fresh state instead. Periodic hashes occur every 30 ticks. Server rewind anchors are sparse (every four ticks plus the first boundary after history clear); absent retained anchors use present-time uncompensated action policy.

Resync requests coalesce while a full state is pending. A request inside the 30-tick rate window is deferred rather than dropped, so a client with one request in flight always gets a response. Recovery required by a pre-sync historical correction bypasses that deferral.

The DOM-free client runs both confirmed and prediction simulations with AI on. Confirmed follows records and verifies hashes; prediction holds remote humans and reloads only when newly confirmed intent differs. See [client network reference](../client/README.md) and [wire reference](../protocol/README.md). Historical G4 delta measurements remain in [the retained gate report](../../docs/gates/G4.md), not current-protocol qualification.

For a serial LAN measurement with three headless humans and five original bots:

```sh
node --experimental-transform-types packages/server/scripts/run.ts --players 3 --target-players 8 --seconds 60 --port 9443 --out build-out/net-v4/lan-3
```

The summary reports `bytesPerSecondReceived` per client (binary payload, excluding WebSocket/TLS/IP overhead), confirmed hash counts and server CPU metrics. No full state is sent during steady-state unless resynchronization is requested.

Measured on 2026-10-16 with that command: **60.002 s**, **3 humans + 5 bots**, **3,523 B/s received per client**, **125 verified hashes per client**, **zero mismatches/resyncs/errors**. Server sim+encode p99 was **2.520 ms** and tick lateness p99 **2.404 ms**. Raw receipts are under `build-out/net-v4/lan-3/` (`summary.json`, `clients.jsonl`, `server.jsonl`). This automated LAN result is not an impairment-matrix, browser, physical-input-latency or human-play qualification.

## Acceptance commands

Run serially to keep worker/WASM memory bounded:

```sh
bun run --cwd packages/server typecheck
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server test
bun test packages/protocol/test packages/protocol/src/transport
bun run --cwd packages/server test:platform
```

The last command checks the unchanged frozen WASM via the existing qualification helper, generates a private test certificate, and uses real HTTPS/WSS listeners on ephemeral ports. It covers quickplay fill/create/capacity and expiration, friend-lobby authority/readiness/start/late-join/leave, malformed/rate-limited requests, all 32 join/leave slots with DM/CTF bot refill, and three production `OnlineSession` headless Node clients against a real match worker. `NET_G4_WASM` and `NET_G4_CONTENT` override qualification input locations; they do not bypass the frozen-module check. No browser or Docker cleanup is involved.
