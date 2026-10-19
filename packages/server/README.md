# Authoritative server

Node 24 HTTPS/WSS control plane for Soldat Online, an unofficial project not endorsed by THD/MM. Each match runs the existing OpenSoldat WASM in its own worker thread. This package never rebuilds the simulation. Existing upstream licenses and attribution requirements continue to apply.

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
| `publicUrl` | local listener origin | External direct-listener HTTPS origin; set explicitly in production |
| `targetPlayers` | `12` | Humans plus bots per public match and friend lobby, 1–32 |
| `maxMatches` | `8` | Worker/WASM capacity; excess creation returns 503 |
| `maxLobbies` | `128` | Total lobby capacity, 1–4096 |
| `idleMs` | `60000` | Close matches with no humans or live leases; reclaim empty lobbies |
| `reservationMs` | `30000` | Single-use admission lease lifetime |
| `maxHostedLobbiesPerIp` | `2` | Unstarted/active lobbies owned by one source |
| `maxPrivateMatchesPerIp` | `2` | Active lobby-started matches owned by one source |
| `maxQuickplayReservationsPerIp` | `4` | Outstanding public quickplay leases per source |
| `lobbyExpiryMs` | `1800000` | Absolute lifetime of an unstarted lobby, including connected hosts |
| `afkMs` | `300000` | Disconnect when consumed controls have not changed for this long |
| `lobbyBufferedBytes` | `262144` | Lobby socket send-buffer ceiling; excess terminates the peer |
| `maxPendingUpgrades` | `256` | Pending lobby/match admissions across the listener |
| `maxWebSocketsPerIp` | `16` | Pending plus joined lobby/match WebSockets per source |
| `maxConnectionsPerIp` | `32` | Concurrent TCP/TLS sockets per source |
| `outboundQueueBytes` | `4194304` | Combined match application/socket outbound byte ceiling |
| `replayTicksPerSecond` | `60` | Rewind-work token refill; fixed capacity is 60 replayed ticks |
| `controlBurst` | `60` | Aggregate non-input messages initially allowed per match session |
| `controlPerSecond` | `30` | Aggregate non-input token refill per second |
| `failedLookupsPerMinute` | `10` | Failed lobby lookup/upgrade tokens per source per minute |
| `globalFailedLookupsPerSecond` | `100` | Global failed lookup/upgrade burst and refill per second |
| `globalCreationsPerSecond` | `20` | Global resource-creation burst and refill per second |
| `regions` | current listener as Local | Configured `{id,name,url}` entries with HTTPS origins |
| `allowedOrigins` | localhost/127.0.0.1 HTTP port 5195 | Explicit CORS/WSS origin allowlist; no wildcard |
| `operatorToken` | absent / operator login disabled | High-entropy 32–256 UTF-8 byte token; TLS only, never a nickname/password shortcut |
| `banFile` | absent / memory only | Global operator-ban JSON path; parent directory must exist and be writable |
| `voice` | direct/LAN ICE, no third-party endpoints | `{iceServers?,relayOnly?,turn?:{urls,secret,ttlSeconds?}}`; environment alternatives below |
| `rules.botDifficulty` | native default `100` | Original 0–300 skill value |
| `rules.world` | `original` | Native gameplay world; `fixture` is for controlled qualification |

All hardening keys are validated positive safe integers no greater than 2147483647; lifecycle times are milliseconds. `maxMatches` is 1–64. At least `ceil(maxMatches / 4)` workers (minimum one) are reserved for public quickplay: private starts receive an explicit capacity error rather than using this reserve. Source quotas use direct socket addresses, with IPv6 grouped by /64 and IPv4-mapped addresses normalized; forwarded headers are never trusted. Bounded IP bucket tables evict their stalest entry, while global creation limits prevent address rotation bypassing total rate limits. Deploy directly with TLS, without a reverse proxy.

Lobby updates coalesce to ten broadcasts per second and unchanged setup/readiness does not broadcast. Lobby admission includes joined and pending peers with two race slots; admission timeouts terminate after five seconds. TLS handshakes time out after five seconds. Match/lobby inbound WebSocket limits derive only from legal client messages; large server state decoder limits remain unchanged. Match control requests coalesce pending resync/ack work, and client pings are answered at most four times per second. Rewind budget exhaustion uses present-time fire and increments `replayBudgetFallbacks`/`uncompensatedShots`; RTT uses a 0.25 EWMA with each sample clamped to a 50 ms change before smoothing. Historical compensation remains capped at twelve ticks (200 ms at 60 Hz).

Failed lobby HTTP lookups and rejected lobby upgrades/admissions share the failure buckets. Once a source or global failure budget is exhausted, further lookup/upgrade attempts are rejected before resolving the code until tokens refill; successful lookups do not consume failure tokens.

SIGHUP re-reads the configured `tlsKeyPath`/`tlsCertPath` and calls `setSecureContext` without dropping existing connections. Read/validation failure logs an error and retains the previous TLS context; it never exits. SIGTERM/SIGINT retain graceful shutdown. The local launcher explicitly allows HTTP localhost/127.0.0.1 on ports **5195, 5198 and 5199**. API responses include HSTS (`max-age=31536000`) and `X-Content-Type-Options: nosniff`.

## Performance logging

The production launcher writes aggregate JSON performance summaries to stdout every **10 seconds**, plus remaining summaries on graceful shutdown. There is no public metrics endpoint, dashboard, client tracking, or browser instrumentation. These records describe server-observed transport and simulation performance; they do not measure client rendering or one-way network latency.

Records use `schemaVersion: 1`, ISO `timestamp`, `windowMs` and `type: "match_performance"` or `"server_performance"`. Match metadata is limited to the generated match ID, map, mode, target population and human count. `summaries` contains `simEncodeMs`, `workerSimEncodeMs`, `wireEncodeMs`, `tickLatenessMs`, `replayMs`, `inputBufferOccupancy`, `inputBufferLeadTicks` and `rttMs`, each with count/min/p50/p95/p99/max plus truncated/invalid sample counts. `samplePolicy: "first_2048_per_metric_per_window"` bounds each metric to its first 2,048 observations per reporting window. RTT aggregates fresh successful raw server ping/pong timing probes, collected once per validated pong and forwarded since the preceding worker report, distinct from gameplay's smoothed compensation RTT. No repeated peer snapshots or player identifiers are emitted; these timings do not measure packet loss.

`interval` contains `inboundBytes`, `outboundOfferedBytes`, `resyncRequests`, `disconnects`, `replayTicks`, `rejectedShots`, `uncompensatedShots` and `replayBudgetFallbacks`. Outbound bytes mean application payload offered to transport, not successful delivery or TLS/IP wire bytes; inbound includes codec-rejected application packets. `cumulative` contains overload/discarded-step counters. `ticks` reports first/last tick and observed progression, not dropped ticks or a health verdict: pauses, bullet time and resets affect progression. Worker metrics are sampled by monotonic wall time, including paused/slow-motion matches; paused simulation has no simulation samples or tick progression.

`interval.fireAdmissionReasons` contains fixed, bounded counters for the first matching Fire/grenade admission gate: `fallbackAge`, `fallbackView`, `fallbackHistory`, `fallbackAnchor`, `fallbackBudget`, `rejectAge`, `rejectHistory`, `rejectIntent`, `rejectAction`, `rejectWeapon`, `rejectMatchCooldown`, `rejectPlayerCooldown`, `rejectExistingFire` and `rejectView`. These are input-frame decisions, including held intent, not distinct projectiles, hits or missed shots. Frames rejected earlier by input sequence/rate validation never reach these gates. Reasons reset with each worker report and aggregate within the ten-second log window; rewind windows and shot policy are unchanged.

Server `runtime` reports RSS/main-heap/external memory, process CPU user/system time and percent of one core, event-loop delay percentiles/utilization and uptime. `logging` reports dropped matches/records, invalid metadata and write errors. Timing/buffer/RTT observations are aggregated rather than emitted per player. No player IP addresses, names, chat, admission tickets, host tokens or operator credentials belong in metrics.

The event-loop histogram observes the **main thread** with a 20 ms sampling interval; healthy raw delay values include that monitoring interval. Do not compare them directly with the worker tick-lateness budget. RSS covers the process, including workers; heap/external figures describe the main isolate.

The application does not create log files. Retention is the operator's responsibility: the [shared Docker deployment](../../deploy/README.md#shared-host-performance-logs) bounds both application containers' Docker logs below one decimal GB nominally. Local stdout or dedicated-host journald follows its own destination's retention policy instead.

### Timing investigation — 2026-10-19

A real-WASM profile identified one redundant pre-step render export, which rebuilds a 75,976-byte native render buffer. The server now reuses that same-step view, refreshing it after an automatic map transition. There is no cross-tick cache or changed rewind-anchor cadence. Native serialization remains the dominant sampled cost and already caches its encoded bytes/hash until state mutation; probing the save size and copying the saved state do not encode twice.

Five alternating-order baseline/fixed process pairs used 720 ticks per scenario, the frozen WASM, and identical controls. Each fixed run required exact network transcripts, serialized-state checkpoints, gameplay hashes and admission totals to match baseline:

| Scenario | Render calls before | Render calls after | Median total tick work before (ms) | After (ms) |
| --- | ---: | ---: | ---: | ---: |
| One human / seven bots | 1,441 | 721 | 532.84 | 495.41 |
| Eight humans / resync | 1,448 | 728 | 522.83 | 483.04 |
| Overlapping rewinds | 1,478 | 758 | 419.94 | 394.03 |
| Same-tick commands | 1,441 | 721 | 337.26 | 325.60 |
| Round transition | 1,443 | 723 | 341.09 | 343.86 |

This is a modest host-work reduction, not a reduction in network RTT or a VPS throughput qualification. The round-transition timing did not improve; do not claim a uniform speedup. Ignored receipt: `build-out/server-timing/paired-results.json`.

## API reference

See the [shared protocol reference](../protocol/README.md#matchmaking-http-reference) for complete request/response and binary payload layouts.

- `GET /api/ping`: tiny no-store RTT probe.
- `GET /api/regions`: actual configured regions.
- `POST /api/quickplay {nickname}`: lowest-load available public match, or a new bot-capable DM rotation match. Returns `{matchId,wsUrl,map,mode,humans,bots}`. Connect with the existing binary hello using the returned single-use, expiring ticket URL.
- `POST /api/lobbies {mode,map,rules?,mapRotation?}`: returns `{code,hostToken,wsUrl}`. Seven original modes are supported. Keep the token secret; share `/?lobby=CODE`.
- `GET /api/lobbies/:code`: public lobby state plus canonical lobby `wsUrl`, never the host token or a usable match-admission ticket. Use this WSS URL even when the HTTP API is reached through a development proxy.
- Lobby WSS `/lobbies/CODE`: `lobby-join`, `lobby-update`, `lobby-ready`, `lobby-start`, `lobby-kick {id}`, `lobby-leave`; receives personalized `lobby-state {selfId,state}` or `lobby-error {reason}`.

Codes have eight random Crockford base32 characters (40 bits; no I/L/O/U); entry and lookups are case-insensitive. Old six-character links fail explicitly. Only the host can change setup/start or kick guests. A kicked guest receives an explicit close reason and its source IP cannot rejoin that lobby for ten minutes. Setup changes clear guest readiness; no-op updates do not. All guests must be ready. Late joiners enter the same started match and replace a bot. Host departure closes an unstarted lobby; a started match survives. Unstarted lobbies expire after thirty minutes even with connected peers. Empty matches with no humans/live reservations close after sixty seconds; tickets expire after thirty seconds. AFK humans are disconnected and bots refill their slots.

## Population ownership

Dynamic targets start full of original waypoint bots. A human join removes a bot through the simulation's original leave command before joining; a human departure rejoins an original rotating profile in a free slot. Every team-mode join/refill chooses the least populated team (TM has four; CTF/INF/HTF two), with original team order breaking ties. FFA modes use team zero. Humans plus bots never exceed 32. Profile names, appearance, loadouts, scores and gameplay stay simulation-owned.

`createGameServer` remains the lower-level single-match API used by existing capture/security qualification. Its fixed `botCount` configuration is unchanged when `targetPlayers` is absent. Both APIs require TLS; there is no insecure WebSocket fallback.

## Input relay reference (protocol v7)

Admission sends `welcome`, then one full `state` at a completed step boundary; subsequent `ticks` messages start with that boundary's step. No ACK gates input relay or timing probes. Every two ticks the worker encodes one shared ordered record buffer and the listener adds each recipient's consumed-input sequence header. Human input rosters are self-contained per message; later steps compress unchanged controls. Bots never appear in the input roster.

All runtime membership and weapon commands are retained as exact JSON bytes and replayed before their corresponding step. A successful lag-compensation insertion sends `correct`, then a boundary `hash`; recipients synchronized after that historical tick receive fresh state instead. Periodic hashes occur every 30 ticks. Server rewind anchors are sparse (every four ticks plus the first boundary after history clear); absent retained anchors use present-time uncompensated action policy.

Resync requests coalesce while a full state is pending. A request inside the 30-tick rate window is deferred rather than dropped, so a client with one request in flight always gets a response. Recovery required by a pre-sync historical correction bypasses that deferral.

The DOM-free client runs both confirmed and prediction simulations with AI on. Confirmed follows records and verifies hashes; prediction holds remote humans and reloads only when newly confirmed intent differs. See [client network reference](../client/README.md) and [wire reference](../protocol/README.md). Historical G4 delta measurements remain in [the retained gate report](../../docs/gates/G4.md), not current-protocol qualification.

## Gameplay rules and round lifecycle

Imported map metadata must include `modes:GameMode[]`, derived from active native spawn points. The launcher rejects old content indexes rather than inferring objective support from filenames. Reimport content after updating the pipeline; realistic mode also needs `configs/weapons_realistic.ini` in the verified simulation pack.

Friend creation and host updates accept shared `MatchRules` and `mapRotation`. Rules are validated before creating a worker or mutating a lobby. A rotation contains 1–32 distinct known bot-capable maps compatible with that mode, including the selected map. An omitted rotation defaults to compatible maps; `[map]` repeats the same map. Changes reset guest readiness. Product matchmaking forces original world/AI and retains the server RNG policy; clients cannot update rules after match admission. The default total population remains **12**.

Native time/score limits produce match-end events and the real results/countdown phase. Once native `roundPhase` is ready, the server flushes old-map events and records, calls `loadMap(nextMap)` preserving connected players, and sends an ordered protocol-v6 welcome/fullstate boundary. Tick, reliable-event IDs and input sequence remain monotonic; replay/queued-input history is cleared. Browser rendering prepares asynchronously with generation guards; asset downloads never hold state/tick processing or pongs. Late match admission and started friend-lobby state describe the current round/map. No transition ticket, reconnect or artificial fast-forward is needed.

Team and appearance requests derive their slot from the admitted connection and pass native eligibility checks. The original ChangeTeam path owns deaths/spawn/team shirts. Appearance uses bounded RGB/style fields; user shirt colors are retained but native team shirts take precedence. All these state-changing commands are relayed identically to confirmed and predicted replicas and invalidate server rewind history. Bullet time changes worker wall-clock cadence from 60 to 20 fixed simulation ticks per second while active, with clients using the confirmed native scale.

### Team balancing and message controls

`balanceTeams` is immutable and defaults false. Enable it in friend/practice rules for least-populated playing-team admission, rejection of worsening voluntary switches and automatic departure/spectator balancing, moving genuine bots before humans. Spectators do not count and FFA is unchanged. Native `ChangeTeam` preserves original objective drops and Survival waiting/deaths. Automatic departure balancing extends original admission-only enforcement; a trusted replacement leave waits for immediate refill to avoid unnecessary human moves.

Balance denial and the normal player-change throttle send a nonfatal `notice`; malformed/unauthorized controls and aggregate abuse remain rejected. Accepted membership commands, including trusted replacement metadata, are retained verbatim for every replica.

Public/team chat and taunts use wire7 presentation messages, not simulation events or commands. The worker derives identity from admission and exact current team from native state: team0 reaches solo peers, team5 spectators only. Separate chat buckets allow four immediately and refill one per second, checked before IPC and in the worker. Text rejects controls/invisibles and is limited to 1,024 UTF-8 bytes. A client cannot forge delivery or gain administrator authority through chat.

### Native actions, live administration and votes

Alt+1–4 requests smoke/tabac/takeoff/victory for the admitted player. Original native idle/animation, cigar/helmet and interruption rules apply; dead, spectator, moving/nonstanding requests are denied without mutation. `/kill` uses native suicide. ABI6 is unchanged because these commands use already-serialized state.

Friend hosts receive match authority only through their validated host reservation. Operators authenticate with `/admin <token>`; configure `operatorToken` explicitly, for example with an independently generated `openssl rand -hex 32` value. No default operator credential exists. The browser masks credentials and excludes them from history, drafts, binds and saved settings. Login/logout changes typed permissions; it never opens a shell or PascalScript/RCON interpreter.

`/matchmenu` or **Match controls** exposes permission-aware numbered controls. Typed commands support kick, `/ban <slot> <minutes> [reason]`, `/bans`, `/unban <id>`, `/servermute <slot>`, `/serverunmute <slot>`, `/setteam <slot> <team>`, `/kill <slot>`, compatible `/map`, `/nextmap`, `/restart`, `/pause` and `/unpause`. Protected host/operator targets cannot be moderated by a lesser role. Forced team/kill commands use native mechanics; pause freezes native/predicted ticks and resets clock/input debt on resume while console, heartbeats and vote deadlines continue.

Hosts' bans are match-scoped and in memory; operators' bans cover this server process's matches and persist only when `banFile` is set. There is no cross-region ban replication. Stores hold at most 256 unexpired records each; duration is 1–43,200 minutes. Writes serialize, fsync and atomically rename mode-0600 files. Invalid/oversized stores fail startup; write errors do not pretend a ban succeeded. Public ban summaries contain opaque IDs, not addresses.

**Address limitation:** bans and future-admission mute inheritance use the normalized source address (IPv6 /64 grouping). A shared NAT can therefore prevent other people at that address from rejoining. A slot-targeted action disconnects/mutes only that admitted target, not its already-connected neighbors. Forwarded headers remain untrusted; deploy directly with TLS.

Map/kick voting requires at least three non-spectating humans admitted for ten seconds. The authority freezes admission-nonce membership; bots, late joiners and reused slots cannot add ballots. Kick targets stay in the denominator but cannot vote, and host/operator targets are protected. The initiator votes yes; passing requires at least two yes votes and `ceil(60% × electorate)`. Deadline is 20 seconds. The global 120-second cooldown is deliberately stronger than upstream's per-starter cooldown. F12=yes, F11=no. A passed kick creates an original-style 60-minute **match-only** address ban and disconnects the selected admission; map votes use the real compatible map/epoch transition.

### Radio and voice deployment

V opens the original numbered 3×3 radio menu. Requests contain only canonical choice codes; identity and exact native team come from the authority. Dead non-spectators may send; spectators and server-muted players may not. Solo team0 routes only to other solo players. Native complete-phrase recordings 151–159 play with a three-second radio cooldown. Local `/mute` filters radio/voice playback independently of authoritative `/servermute`.

Voice is opt-in, disabled in browser preferences by default, and has no default talk binding in the pinned controls. Enable it and capture a **Hold-to-talk binding** under Settings → Taunts & console controls. Enabling/listening never requests microphone capture; pressing the talk key does. Release, typing, menus, blur, pause, disable, disconnect and teardown stop capture. Team/public selection controls **outgoing** audio; opted-in recipients can hear authorized public transmissions from other teams. Spectators cannot transmit.

The server authenticates admission-nonce peers and directional channel/mute policy, then relays bounded audio-only SDP/ICE. Server-owned pair generations reject stale signaling after revoke/re-enable, even when admission IDs are unchanged. Directional mute/channel changes retain valid transports; ICE credential renewal updates configuration and restarts ICE without replacing DTLS/microphone state. Actual audio uses browser WebRTC, not gameplay WSS. Signaling has a separate 512-token burst/128-per-second listener bucket plus a 600-per-ten-second relay ceiling. This is peer audio, not a media-authoritative SFU: legitimate receivers enforce mute policy; colluding modified peers can communicate out of band regardless.

HTTPS (or localhost) and browser microphone permission are required. Empty ICE configuration is useful on LAN, not a guarantee of Internet NAT traversal. Configure your own STUN/TURN; no remote endpoint or hosted relay is silently selected. A production TURN service must have working DNS, certificates/ports and bandwidth independently of the game listener. Without relay-only mode, peers may learn one another's network addresses. `relayOnly:true` requires TURN and trades relay bandwidth/cost for address privacy.

Environment settings apply when JSON `voice` is absent:

| Environment | Value |
| --- | --- |
| `SOLDAT_VOICE_ICE_SERVERS` | JSON array of `{urls:[\"stun:host:port\",\"turns:host:5349?transport=tcp\"],username?,credential?}`; use only URLs your service supports |
| `SOLDAT_VOICE_RELAY_ONLY` | `true`/`false` or `1`/`0`; true without TURN fails configuration |
| `SOLDAT_VOICE_TURN_URL` | Comma-separated operator TURN URLs |
| `SOLDAT_VOICE_TURN_SECRET` | Coturn-compatible REST shared secret; never delivered to clients |
| `SOLDAT_VOICE_TURN_TTL` | Ephemeral credential lifetime, 600–86,400 seconds; default 3,600 |

The relay issues per-admission HMAC-SHA1 REST credentials and refreshes configuration before expiry. Static credentials may instead be supplied in `voice.iceServers`; they are necessarily visible to admitted browsers. No provisioned external TURN endpoint is included in this repository.


### Gameplay smoke recipes

Run with the rebuilt ABI6 WASM and current verified content, serially:

```sh
bun test packages/protocol/test
node --test packages/server/src/bots.test.ts packages/server/src/clock.test.ts
node --experimental-transform-types --test packages/server/scripts/gameplay.test.ts
```

For browser coverage, create a friend lobby in each mode with compatible maps, total12, and a short time limit. Join a second browser, request another allowed team and appearance, and confirm both peers see the same native result. Wait through the actual results/countdown; both sockets must remain connected on the next map, with unchanged identity/loadout/appearance and increasing hash matches, zero mismatches. Join a third browser after transition through the original friend code and verify the current map. Repeat a score-limited round and enable realistic/survival/advance/bonuses/bullet-time separately to observe actual native effects. These are recipes, not verification receipts.


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

The last command checks the current pinned WASM, generates a private test certificate, and uses real HTTPS/WSS listeners on ephemeral ports. It covers matchmaking/lobby authority and lifecycle, all 32 slots across seven modes, bot refill, and production headless confirmed/prediction clients. `NET_G4_WASM` and `NET_G4_CONTENT` override input locations without bypassing the module pin; content defaults to `dist/content-next`.

## Historical gameplay expansion verification (ABI5)

Recorded WASM SHA-256: `242d95122688054332a8af4f1f82ee85fdbd0a8c5afe0e2ee3e0676ec42c86b7`, ABI/state `0x00010005`; content `710dc47da59a5b779c6ac2efbe050d8226d34182b161fb0a21b5a2b5de87533e`. Content includes the original realistic weapon configuration and spawn-derived map modes. The counts below qualify that historical artifact, not ABI6.

`node sim/build/check-gameplay.mjs` passed 22 real-WASM scenarios: seven-mode objectives/bots and save/replay; native PM/TM/Rambo/INF/HTF scoring; team/appearance validation; realistic health; restricted/full weapon lists; time/score endings and reset; bullet-time activation/recovery; Survival waiting/reset including replacement bots; Advance unlocks; and all five native timed bonuses.

Protocol tests: 80 passed. Server unit tests: 28 passed. All server script tests: 87 passed, including real WSS round continuation with two players and a late third player, preserved identity/team/appearance and zero hash mismatches. Client tests: 78 passed. Content parser/pack tests: 25 passed. Protocol/server/client typechecks and client production build passed. Run the native script first, then `node --experimental-transform-types --test packages/server/scripts/*.test.ts` serially with other heavy qualification jobs stopped.

Receipts are under `build-out/gameplay/`. These checks do not requalify historical full native-oracle/browser matrices, impaired-network acceptance, long soaks or VPS capacity.

## Historical controls expansion verification — 2026-10-17

Historical WASM SHA-256: `57eb13e9a988a43ac31f63aa5538bd00cda19ff79e86121ef0e837879c348057`; macOS native SHA-256: `39898e0b6b9ac7f23741ce73ea3e4ad77c843a355ef2ecbf9d2f71ed2b9861d8`. This ABI6/wire6 artifact predates native gestures and typed administration/communication. Content identity was `710dc47da59a5b779c6ac2efbe050d8226d34182b161fb0a21b5a2b5de87533e`; these receipts do not qualify later artifacts.

- Native/WASM build passed its 15 signed-packed-load compiler probes. `GAMEPLAY_OUT=build-out/controls/features.json node sim/build/check-gameplay.mjs` passed **32** real-WASM scenarios, including all-mode balancing, bot-first departures/replacement, Survival, immutable rules, state replay and Realistic bot-follow visibility.
- Protocol tests: **86** passed. Server unit tests: **28** passed. All server script tests: **92** passed, including real WSS balance denial without disconnect/hash divergence, authenticated public/team/solo/spectator routing, forged delivery rejection, flood enforcement, native rounds and existing transport/lag-compensation hardening.
- Client tests: **116** passed. Protocol/server/client typechecks and production client build passed. The production build retains the existing large Phaser-chunk warning.
- Three private Chrome155 contexts verified a real 6/6 CTF roster, public/team taunts and opponent isolation, local mute/unmute, live binds/settings, balance denial, following/freecam, actual screenshot download and unbind/restore without reconnect/hash mismatch. The complete shell capture also passed.

Evidence: `build-out/controls/features.json`, `browser.json`, and `shell/screens.json`; the client reference describes the visual evidence. These results are not full native-oracle equivalence, a Firefox/Safari matrix, adverse-network acceptance or a long VPS capacity soak.

## Historical native actions and communications verification — 2026-10-18

Historical WASM SHA-256: `89e5d4b4afed8f68a2fc3fa3348f5ba4574c1ddc4094b23eae8bfcf08fcbc198`; macOS native SHA-256: `dadc9d87c527384cdc9cd87b7a9d841d9f863f094369c39806e538672032164f`. ABI/state/render/FX remain `0x00010006`; wire is **7**. Content remains `710dc47da59a5b779c6ac2efbe050d8226d34182b161fb0a21b5a2b5de87533e`.

| Verification | Passed |
| --- | ---: |
| Signed packed-load compiler probes | 15 |
| Real-WASM gameplay/gesture scenarios | 40 |
| Protocol tests | 90 |
| Server unit tests | 46 |
| Real HTTPS/WSS server integration tests | 96 |
| Isolated client tests | 150 |

Protocol/server/client typechecks and the production client build passed. The existing large Phaser-chunk warning remains. Native scenarios include all gesture/cigar/helmet transitions, dead/bow/movement rejection, byte-exact replay, original suicide/objective release and trusted forced-team/Survival behavior. WSS integration covers shared-NAT voting, off-rotation compatible catalog maps, protected capabilities, targeted bans, pause/AFK/epoch ordering, radio routing, signaling budgets and existing bot/transport/lag-compensation controls.

Permanent regressions also cover revoked same-admission voice generations, directional mute/channel changes retaining valid transports, idle TURN credential renewal, ICE restart without microphone destruction, credential secrecy, and once-per-death weapon selection. External TURN service operation, Firefox/Safari gameplay/media, impaired-network acceptance, full new native-oracle matrices and long production/VPS capacity are not qualified by these checks.

Native receipt: `build-out/communications/features.json`. Existing `build-out/controls/` and `build-out/gameplay/` receipts remain historical and bind different binaries/wire versions.

Three private Chrome155 clients passed the real friend-game surface with synthetic microphone devices: authenticated host/operator controls, original Alt+4 animation, exact imported 1.784-second radio recording playback to the teammate but not opponent, real getUserMedia → WebRTC RTP/decoded audio sink, team/public channel changes, local/server mute and microphone release, pause/unpause, secret-safe login/logout, F12 map voting to off-rotation Airpirates, post-round audio, native kill, targeted ban, rejected readmission, unban and fresh-admission audio. Zero page exceptions were recorded. Failed banned WSS admission currently shows the browser's generic connection-failed alert; the authenticated host has the explicit ban reason.

The full existing shell harness also passed: 21 screenshots and eight single-canvas menu/game transitions, including quickplay, lobby kick/readmission denial and host/guest admission. Receipts: `build-out/communications/verification.json`, `browser.json`, `features.json`, `shell/screens.json`; visual evidence includes `admin-menu.png`, `vote-active.png`, `radio-menu.png` and `voice-settings.png`.

## Privacy-safe artifact verification — 2026-10-18

The current shared WASM is SHA-256 `13b1d078ce0556fc7e8c4d0a53bbbb7da56f37bad6d19eb9f6803e9559ff745c`. Only its custom module-name subsection changed to the public `sim.wasm`; every standard section and all other metadata are byte-identical to the preceding artifact. The native executable remains `dadc9d87c527384cdc9cd87b7a9d841d9f863f094369c39806e538672032164f`; ABI, wire and content versions are unchanged. Two different local output directories produced the same canonical WASM.

The canonical artifact passed 40 real-WASM gameplay scenarios and all 96 serial HTTPS/WSS integration tests. Server/client typechecks, 46 server unit tests and 156 isolated client tests passed. Native and WASM RNG conformance matched all 2,031,704 calls across 64 seeds; the 15 signed-packed-load probes also passed. Metadata-normalizer smoke covered 13 cases, including long LEB lengths, idempotence, byte-preserved unrelated data and nonmutation on malformed inputs.

Local evidence is under `build-out/privacy/`. The historical receipts above retain their original identities; this metadata-only cutover does not claim a fresh full native-oracle/browser matrix, Internet voice traversal or production-capacity soak.

The rebuilt Node-enabled compiler image also compiled native and WASM successfully; its Linux WASM matched the macOS canonical digest exactly. The production client build and invariant checks passed. A real browser inspected the cleaned Credits page and completed fresh quickplay → enter game against the authoritative API: 196 matching hash checkpoints, zero mismatches at confirmed tick 5,846. This was a short localhost smoke, not a renewed full browser/network qualification.
