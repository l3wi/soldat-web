# Multiplayer authority, transports, and runtime research

Research date: 2026-10-15. Scope: inspected OpenSoldat checkout plus current primary browser/library documentation; no code or dependencies installed, no repository files changed, and no runtime/network benchmarks performed. Proposed numbers below are design starting points, not measured results. This source checkout is evidence for OpenSoldat, not proof that Soldat 1.7.1.1 or earlier releases used identical algorithms.

## 1. Verified facts

### 1.1 Original transport: GNS over UDP, not WebSocket

- Non-Steam builds initialize GameNetworkingSockets and obtain its socket interface; Steam builds use Steam's corresponding interface: `reference/opensoldat/shared/network/Net.pas:934-955`. The build pins GNS v1.4.1: `reference/opensoldat/shared/libs/GameNetworkingSockets/CMakeLists.txt:40-52`.
- Client connects by IP and server listens by IP: `reference/opensoldat/shared/network/Net.pas:1136-1145,1335-1349`. The variable named `UDP` is an abstraction around GNS, not proof of raw socket calls.
- GNS provides reliable and unreliable messages over UDP, encryption, message boundaries, fragmentation/reassembly, and congestion/queue handling. It is not browser-compatible WebRTC simply because it also has optional ICE support: https://github.com/ValveSoftware/GameNetworkingSockets . Existing-server compatibility would need a bridge/protocol implementation, but is out of scope here.
- Movement/full/major snapshots and bullet spawn packets explicitly use `k_nSteamNetworkingSend_Unreliable`: `reference/opensoldat/shared/network/NetworkServerSprite.pas:125-129,170-174`; `reference/opensoldat/shared/network/NetworkClientSprite.pas:304-306,340-345`; `reference/opensoldat/shared/network/NetworkClientBullet.pas:51-62`. Even sprite-death messages here use unreliable delivery: `reference/opensoldat/shared/network/NetworkServerSprite.pas:317-319`. Do not copy that event-delivery choice unquestioningly.

### 1.2 Authority is hybrid — position trust is real, client-authoritative damage is not established

**Movement:** client sends position, velocity, keys, and aim. Server verifies message size, associates it with the authenticated connection's player, ignores movement while dead, checks out-of-bounds values, then directly assigns the client position and velocity and decodes controls. See `reference/opensoldat/shared/network/NetworkServerSprite.pas:479-518`. This handler does not reconstruct legal displacement by replaying sequenced inputs. The server also simulates controls between updates (`reference/opensoldat/shared/mechanics/Sprites.pas:505-533`), so 'server only relays positions' would also be inaccurate.

**Local correction:** full snapshots only replace position/velocity for `i <> MySprite`, except respawn initialization; major snapshots do the same. Health and vest still come from server. See `reference/opensoldat/shared/network/NetworkClientSprite.pas:90-110,162-165,206-225,248`. These paths are not the usual modern 'ack input N, restore authoritative local state, replay N+1...' scheme. Their avoidance of ordinary self-position correction is part of why local control can feel unconstrained under latency. Movement deltas include server ticks and discard old packets (`reference/opensoldat/shared/network/NetworkClientSprite.pas:589-603`), but that is not input acknowledgment/replay.

**Weapons/ammo:** client state carries ammo counts and weapon selection; server applies them with some checks/script hooks. See `reference/opensoldat/shared/network/NetworkServerSprite.pas:427-475`. Strictly server-owned ammo/cooldowns in the revival is a deliberate hardening, not a literal port of authority rules.

**Shooting:** slower weapons/grenades send a client-originated projectile spawn (weapon, position, velocity, seed, client tick), not an 'I hit player X for Y damage' assertion. Fast-fire weapons instead force movement/fire-key updates at intervals. See `reference/opensoldat/shared/network/Net.pas:485-494`; `reference/opensoldat/shared/mechanics/Bullets.pas:277-298`. Server checks duplicate seeds, weapon validity, spectator status, projectile velocity, approximate muzzle origin, fire/reload intervals, grenades and other cases, then creates its own projectile: `reference/opensoldat/shared/network/NetworkServerBullet.pas:118-158,160-229,235-270,292-321`. Example tolerances are muzzle distance 366 world units, velocity up to `LastWeaponSpeed + 10*InheritedVelocity`, fire interval factor 0.85 and reload factor 0.9. These are historical validation rules, not recommended new security limits.

**Damage:** shared collision code runs on client and server, but client initializes `srv := 0`, then multiplies bullet damage by that zero under `IFNDEF SERVER`; the server computes actual damage. See `reference/opensoldat/shared/mechanics/Bullets.pas:1459-1461,1683-1695`; explosions likewise use a client-side zero multiplier at `:2433-2435,2549-2550`. `HealthHit` applies armor, health and death at `reference/opensoldat/shared/mechanics/Sprites.pas:3337-3358,3405-3412`. Thus this checkout supports **client-predicted collision/effects plus server damage**, not client-authoritative hit claims. Client blood/stat counters are not authoritative evidence of damage (`reference/opensoldat/shared/mechanics/Bullets.pas:1615-1673`; `reference/opensoldat/shared/mechanics/Sprites.pas:3374-3383`).

**Conclusion:** 'Soldat trusted client positions' is confirmed for this checkout. 'Soldat did client-side hit detection' needs the qualifier *for local presentation too*; 'the client decided hits/damage' is refuted for these inspected weapon paths. Earlier closed-source versions remain unknown. New server-owned movement changes the reconciliation feel; server-owned damage by itself is not a contradiction with this source.

### 1.3 Tick and send rates are different

Default simulation is 60 Hz: `reference/opensoldat/shared/Constants.pas:29`. Client uses a fixed-step accumulator: `reference/opensoldat/client/ClientGame.pas:281-294,305-308`. Server updates the game inside a tick loop: `reference/opensoldat/server/ServerLoop.pas:108-119,151-152`.

Internet defaults are expressed in **ticks between opportunities**, not packets/second: `reference/opensoldat/shared/Cvar.pas:1003-1009`.

| Message | Base interval | At 60 Hz, 9+ active players | Small server adjustment (<5 active) |
|---|---:|---:|---:|
| Full sprite snapshot | 35 ticks | ~1.71 opportunities/s | round(35×0.66)=23 ticks, ~2.61/s |
| Major snapshot | 19 | ~3.16/s before full-snapshot exclusion | 13 ticks, ~4.62/s before exclusion |
| Dead sprite snapshot | 50 | 1.2/s | 33 ticks, ~1.82/s |
| Heartbeat/scoreboard | 135 | ~0.44/s | 89 ticks, ~0.67/s |
| Bot movement delta | 4 | 15/s before exclusions | 3 ticks, 20/s before exclusions |

Server adjustment is 0.66 / 0.75 / 1.0 for <5 / <9 / other active non-spectators, and major/bot sends avoid some coincident full-snapshot ticks (`reference/opensoldat/server/ServerLoop.pas:211-265`). Snapshots additionally suppress unchanged data (`reference/opensoldat/shared/network/NetworkServerSprite.pas:111-123,162-168`), so these are not guaranteed actual send rates.

Client movement opportunities occur every `Round(5*Adjust)` internet ticks, or force-send; at large player counts 12/s, and at <5 players with client Adjust=0.75 every 4 ticks, 15/s. LAN is `Round(3*Adjust)` (20/s at Adjust=1). Weapon/ammo and dead updates have separate schedules. See `reference/opensoldat/client/ClientGame.pas:365-373,408-442`. Actual movement sends have position/velocity/key/aim-change gates (`reference/opensoldat/shared/network/NetworkClientSprite.pas:327-345`), with thresholds POSDELTA=60, VELDELTA=0.27, MOUSEAIMDELTA=30 (`reference/opensoldat/shared/Constants.pas:137-140`). Human inbound movements immediately trigger server deltas, sent to other visible clients (`reference/opensoldat/shared/network/NetworkServerSprite.pas:502-517,353-365`). Therefore the low periodic major rate does **not** describe total visible-player update frequency.

### 1.4 Original packet contents and compensation

Full sprite snapshot includes player number, position/velocity, aim, stance, input keys, cosmetics/look, vest, health, ammo/grenades, primary/secondary weapons and server tick. Major snapshot omits much equipment/cosmetic state. Client movement has position/velocity, keys and aim, but no input sequence acknowledgment. See `reference/opensoldat/shared/network/Net.pas:390-418,450-466`.

Packed-record arithmetic gives: full snapshot 42 B; major 33 B; client movement 23 B; client projectile spawn 24 B; server projectile spawn 22 B, **excluding transport overhead**. These are derived field sums, not an executed Pascal `sizeof` check. Vector is packed two Singles (`reference/opensoldat/shared/Vector.pas:74-76`); packet definitions are `reference/opensoldat/shared/network/Net.pas:343-349,393-418,460-466,477-494`.

Lag compensation here is asymmetric:
- Server derives `PingTicksB = serverTick-clientTick`, clamps to 0..125, and stores it with spawned bullets (`reference/opensoldat/shared/network/NetworkServerBullet.pas:118-122`; `reference/opensoldat/shared/mechanics/Bullets.pas:219-222`).
- **The actual history lookup in `GetSpriteCollisionPoint` is guarded by `IFNDEF SERVER`.** Client human-target collision uses `OldSpritePos`; server collision uses current sprite positions. See `reference/opensoldat/shared/mechanics/Bullets.pas:2835-2857`. MAX_OLDPOS=125 (~2.08 s at 60 Hz) is therefore not evidence of a 2-second server hit-rewind policy.
- Receiving client fast-forwards remote bullets by locally estimated ping ticks using repeated Euler/update steps, and reconstructs pellet randomness from seed: `reference/opensoldat/shared/network/NetworkClientBullet.pas:112-118,123-181,192-199`.
- Bullet impact push uses ping-derived scheduling but MAX_PUSHTICK is 0 on server versus 125 on client; client shifts future pushes while server applies index 0 (`reference/opensoldat/shared/Constants.pas:226-231`; `reference/opensoldat/shared/mechanics/Bullets.pas:1596-1602`; `reference/opensoldat/shared/mechanics/Sprites.pas:505-510`). Explosion jumping/knockback need special reconciliation tests.

No conventional server-side target rewind was found in the inspected paths. This is a scoped code conclusion, not a proof about every historical release or every optional script. Original latency-dependent blood/no-damage disagreement is plausible [INFERENCE]; quantify with reference playtests before treating it as a requirement.

### 1.5 Browser transports, current as of research date

| Transport | Delivery | Dedicated-server feasibility | Main limitation |
|---|---|---|---|
| WebSocket/WSS | Reliable ordered application messages, normally TCP | Simple, supported by Node/Bun and ordinary HTTPS infrastructure | Lost underlying bytes delay later updates; stale data already queued cannot be unsent |
| WebRTC DataChannel | Reliable or partially reliable; ordered or unordered | Yes: server is a WebRTC peer; no requirement to connect players peer-to-peer | ICE/signaling, UDP reachability, optional TURN, native stack/deployment complexity |
| WebTransport | HTTP/3/QUIC streams plus unreliable unordered datagrams | Explicit client-server model; Node native bindings, Go/Rust libraries | Server ecosystem/version interop still maturing; UDP can be blocked; older browsers need fallback |

WebSocket has no built-in receive backpressure; `bufferedAmount` exposes queued outgoing bytes. https://developer.mozilla.org/en-US/docs/Web/API/WebSocket . Application latest-wins coalescing helps before `send`, but cannot remove TCP head-of-line blocking after send. Do not move asset downloads onto the gameplay WebSocket.

DataChannel's browser configuration should be `{ordered:false,maxRetransmits:0}` for disposable snapshots; `ordered:false` alone is **still reliable by default**. Alternatively set maxPacketLifeTime, but not both lifetime and retransmit count. Reliable ordered control can use a separate channel. https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel . This is SCTP over DTLS over ICE/UDP, not a raw browser UDP socket: https://www.ietf.org/rfc/rfc8831.html . Congestion control, packetization and send buffering still exist; 'unreliable means no latency' is false.

**WebTransport Safari status materially changes the earlier tradeoff.** Safari 26.4 shipped it on 2026-03-24; WebKit explicitly lists datagrams and reliable/unreliable modes: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/#webtransport . MDN marks the core API Baseline newly available since March 2026: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API . BCD lists Chrome 97, Firefox 114, Safari/iOS Safari 26.4 for core WebTransport: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/WebTransport.json . Core support does not imply every optional option/property matches; that same data shows `requireUnreliable` and `congestionControl` constructor options absent in Chrome. Feature-detect; test actual datagram exchange; do not rely solely on constructor existence or a browser name.

WebKit describes HTTP/2/TCP fallback, but it loses UDP-style loss behavior. `WebTransport.reliability` distinguishes reliable-only from supports-unreliable where implemented: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/reliability . Do not assume uniform automatic fallback across clients/libraries; retain explicit WSS fallback. WebTransport needs HTTPS and a WebTransport-capable HTTP/3 endpoint, not merely any HTTP/3 web server. Validate Origin and authenticated session admission (https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API).

#### WebRTC server library options

- **libdatachannel:** C/C++ standalone ICE/DTLS/SCTP implementation, compatible with Chromium/Firefox/Safari, optional media, supports single-UDP-port multiplexing. MPL-2.0. https://github.com/paullouisageneau/libdatachannel . Good native substrate; not itself a TS gameplay server.
- **node-datachannel:** Node bindings for libdatachannel; current README targets N-API 8 and Node >=18.20 with prebuilt Linux/macOS/Windows artifacts including arm64. https://github.com/murat-dogan/node-datachannel . Beware option spelling: server API uses `unordered:true`, browser uses `ordered:false`; both expose maxRetransmits. Also offers UDP mux, bind address/port range, TURN UDP/TCP/TLS. https://raw.githubusercontent.com/murat-dogan/node-datachannel/master/API.md . Recommended WebRTC candidate if that route is needed; validate packaged binary/runtime pair and all three browsers.
- **werift:** inspectable TypeScript implementation for Node, including ICE/DTLS/SCTP and partial reliability; current README declares Node >=22, and lists Chrome-focused E2E, Firefox runner, community Safari evidence. https://github.com/shinyoshiaki/werift-webrtc . Removes native build dependency but shifts transport CPU/allocation work into TS [INFERENCE]; performance on this game is unknown, not proven inferior.
- **geckos.io:** higher-level game-oriented Node client/server API built on node-datachannel; its v3 README says based on node-datachannel 0.5.x, ESM, Node >=16. Provides raw messages, custom UDP ranges, default multiplexing. https://github.com/geckosio/geckos.io . Easiest event API but adds protocol/dependency coupling; do not import its 'UDP much faster than TCP' marketing as a measured universal fact. Check the actual chosen geckos/node-datachannel version compatibility rather than mixing their README minimums.

#### WebTransport server options

- **Node:** `@fails-components/webtransport` plus `@fails-components/webtransport-transport-http3-quiche` native transport. Provides browser-like server sessions/streams/datagrams, but README calls HTTP/3 a 'duct tape-style solution', lists incomplete API fields and warns about heavy native builds. https://github.com/fails-components/webtransport . Appropriate interop spike, not evidence of turnkey production reliability.
- **Bun:** built-in `Bun.serve({http3:true,tls:...})` is **experimental HTTP/3**, not a documented built-in WebTransport session API: https://bun.com/docs/runtime/http/server . A real candidate exists: `@webtransport-bun/webtransport`, using Rust wtransport via napi-rs, supports Bun/Node/Deno; current README calls version 0.3.0 a release candidate, not stable/GA, and interoperability Chromium-focused. https://github.com/vmeansdev/webtransport-bun . Thus neither 'Bun cannot do WebTransport' nor 'Bun has production-ready native WebTransport' is justified.
- **Go:** quic-go/webtransport-go, current README implements HTTP/3 draft-16 and provides server/client examples: https://github.com/quic-go/webtransport-go . Could be a small same-host transport gateway to TS sim, but IPC and a second language are real costs [INFERENCE]. Do not rewrite the simulation in Go merely for transport.
- **Rust:** wtransport, pure Rust asynchronous API, browsers supported, but README explicitly says not completely production-ready: https://github.com/BiagioFesta/wtransport . Alternative gateway/native binding substrate. HTTP/3/WebTransport draft/version interop must be pinned and tested.

### 1.6 Node, Bun, and Colyseus

**No evidence establishes either runtime's capacity for this simulation before the port exists.** A 60 Hz step has 16.667 ms wall-time budget; serving 60 messages/s is not proof that collision/particles/projectiles plus encoding stay within it.

Node documents noninteger timer delay truncation and explicitly no exact callback-time guarantees: https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/timers.md . `setInterval(1000/60)` alone is therefore not an accurate simulation clock: integer delays and event-loop stalls must not change simulation dt. Use a monotonic elapsed-time accumulator with fixed 1/60 steps. Define overload handling; do not silently substitute variable dt or replay an unbounded backlog.

Bun uses JavaScriptCore with a garbage collector and heap diagnostics; forcing collection is not a no-pause guarantee: https://bun.com/blog/debugging-memory-leaks.md . Node and Bun both need allocation-aware code and measured tail-latency/GC behavior. Node's event-loop histogram is documented at https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions . Browser Safari/JSC versus Chrome/V8 already means a shared TS module is not the same as guaranteed bitwise native-Pascal equivalence.

**Important current framework correction:** Colyseus 0.18 now supplies first-class input buffering, fixed-step scheduling, prediction/reconciliation, remote smoothing, lag compensation and predicted projectile handoff; older claims that it only does state sync are stale. Official release: https://github.com/colyseus/colyseus/releases/tag/0.18 ; architecture: https://docs.colyseus.io/netcode ; determinism contract: https://docs.colyseus.io/netcode/determinism . It still requires our shared deterministic step and replay-safe events; it cannot port Soldat mechanics for us.

Colyseus also has an experimental WebTransport transport using fails-components. It supports unreliable fields and redundant unreliable inputs. **Crucial trap:** `.unreliable()` schema fields stop updating after initial full state on WebSocket transports; they do not transparently become reliable. Unreliable input does fall back to reliable. See https://docs.colyseus.io/server/transport/webtransport . A WSS fallback must intentionally encode state appropriately, or choose reliable state fields initially. WebRTC room-signaling plugins are not proof of a dedicated-server unreliable gameplay transport.

Recommended runtime default is **Node 24 LTS** for server and Bun for tooling. This is an ecosystem/native-addon/diagnostics choice, not a measured performance win. Compare Bun only after the same load trace exists; retain it if it passes with clear operational advantages.

### 1.7 Hosting

Ordinary static/CDN hosting can serve client assets; the match needs a persistent process with region placement and its own CPU budget. WSS can pass through ordinary HTTPS reverse proxies. WebRTC and HTTP/3 need an explicitly supported UDP ingress path, certificates/admission, and compatible load balancing/session affinity. A host advertising WebSockets is not evidence it permits WebRTC or QUIC.

Practical first deployment: a regional Linux VM/container with dedicated public networking, WSS on TCP/443 and reserved UDP ingress for the transport experiment; no scale-to-zero during active matches [RECOMMENDATION]. GameLift supports containerized dedicated servers: https://docs.aws.amazon.com/gameliftservers/latest/developerguide/containers-howitworks.html . It brings orchestration/SDK integration beyond the first two-player milestone [INFERENCE].

Fly.io is a possible alternative but has unusually specific UDP constraints: dedicated IPv4 (not shared IPv4 or public IPv6), bind UDP to `fly-global-services`, same internal/external port, and reduced effective MTU. https://docs.fly.io/networking/udp-and-tcp . Verify the chosen native transport's bind/mux capability; a copy-pasted generic Node web app deployment is insufficient. WebRTC's public server does not inherently need TURN for every client; budget and test TURN for blocked UDP/restricted networks rather than assuming universal direct reachability. TURN over TCP/TLS preserves reachability, not loss-independent UDP behavior.

## 2. Chat assumptions

| Claim | Verdict | Evidence / consequence |
|---|---|---|
| Node authoritative dedicated matches are a suitable default | Nuanced | Architecturally sound; capacity/GC unmeasured. Authority should include movement/ammo, deliberately stricter than source. Node timer docs above. |
| Server decides damage/deaths/scores | Confirmed as viable, partly source-aligned | Inspected bullets already apply real damage on server; client damage zero multiplier. Movement differs. |
| Shared simulation + prediction preserves immediate controls | Confirmed concept; fidelity unverified | Local predict/replay need full hidden state, deterministic inputs and replay-safe FX. Colyseus determinism docs; source self snapshots do not ordinarily correct local position. |
| Soldat trusted client positions | Confirmed for checkout | NetworkServerSprite:502-503 directly assigns client position/velocity. |
| Soldat client decided hits | Refuted for inspected damage paths; historical unknown | Client detects visual collisions, but damage multiplied by zero, server simulates validated projectiles. |
| Conventional server rewind is already present | Refuted for inspected collision path | Bullets:2846-2857 history is client-only. |
| Fixed simulation tick equals network send rate | Refuted | 60 Hz sim versus adaptive ~12–15/s human movement and lower periodic state rates. |
| WebSockets first is pragmatic | Confirmed with boundary | Good local/two-player milestone and fallback; must test actual TCP loss early, cannot erase queued stale packets. |
| WebRTC later is the obvious competitive upgrade | Nuanced | Valid, but WebTransport now supports Safari 26.4 and fits dedicated-server semantics; compare it first rather than committing to ICE/TURN. |
| Safari rules out WebTransport | Refuted as of date | Safari 26.4 shipped March 2026; older Safari still needs fallback. |
| UDP-ish transport is always faster | Refuted | Main benefit is avoiding stale retransmitted state under loss; RTT, congestion, relay routing and queueing still dominate. |
| Colyseus does not supply shooter prediction/reconciliation | Refuted as a current claim | 0.18 supplies these primitives; game-specific step/hit policy still custom. |
| Bun tooling commits us to Bun server runtime | Refuted | Separate decisions; server package/native binding compatibility matters. |
| Regional static CDN + persistent matches is enough detail for hosting | Nuanced | Need explicit UDP ingress, certificate renewal, session affinity, quotas, DDoS posture, and fallback behavior. |

## 3. Hidden assumptions and whether they hold

1. **'Plays like original' specifies a version and latency experience.** Does not yet hold. Which Soldat release/weapon config, and should old misregistration/correction quirks be preserved? This is the most important human decision.
2. **Authority can be retrofitted after porting physics.** False as a safe planning assumption. Input sequencing, state capture, RNG ownership, collision side effects and knockback event application must be designed into the shared module.
3. **Position+velocity is sufficient rollback state.** False [INFERENCE from inspected mechanics]: ammo/reload/fire counters, jets, stance/animation state relevant to muzzle/collision, RNG, prior position/forces and scheduled push affect future ticks. Full required state must come from SimulationCore's mechanics inventory.
4. **Shared TS automatically stays synchronized in every browser/runtime.** Unverified. Matching simulation step, float-rounding policy, RNG sequence, input quantization, iteration order and exact starting state are required; replay fixtures across V8/JSC/SpiderMonkey are necessary.
5. **A reliable channel makes button events safe without sequencing.** False. Connection recovery, transport switches, batching and replay still need event IDs/acks/idempotence. On lossy channel, repeat recent inputs so a dropped fire/release does not become stuck/missing forever.
6. **All browser transport upgrades preserve protocol semantics.** False. WSS cannot express unreliable delivery; WebTransport optional APIs vary; Colyseus unreliable state has a documented WSS behavior trap.
7. **Lag compensation means rewind the target for every projectile forever.** False [design analysis]. Soldat uses moving projectiles, not generic instant hitscan. Historical catch-up must simulate projectile and target at the same historical timeline, then join current time; indiscriminate current-time bullet versus permanently old target produces incoherent hits.
8. **Background tabs can keep playing at 60 Hz.** Unverified/unsafe [INFERENCE]. Handle focus loss/resume explicitly, neutralize stale inputs, and never let a browser stall advance arbitrary trusted game time.
9. **WebRTC makes clients trusted or provides anti-cheat.** False. Encryption authenticates transport/session, not input intent. Browser code and packets are inspectable/modifiable; even full authority cannot prevent aim assistance based on available state.
10. **Original packet loss semantics must be copied.** Not established. Faithful movement/weapons can coexist with reliable kill/pickup records and robust resync; those are netcode policy improvements, not asset incompatibilities.

## 4. Risks and mitigations

| Severity | Risk | Mitigation |
|---|---|---|
| High | Server movement authority introduces correction/knockback feel absent from source's self-position handling | Predict full local movement immediately; reconcile from complete state; smooth presentation only; benchmark jetting/slopes/impact pushes against versioned reference |
| High | TCP loss stalls movement even with good prediction | Kernel/network loss tests at first online slice; datagram adapter behind identical message semantics; preserve WSS fallback |
| High | False promise of classic hit fidelity from source-level collision matching | Separate visual hit FX from confirmed damage; test source reference at same RTT/jitter; explicitly choose projectile catch-up/rewind policy |
| High | New input-only server accepts fabricated timestamps, excessive tick rate or wrong weapon/ammo | Server-owned tick budget, bounded input sequence lead, replay rejection, finite/range validation, server-derived muzzle/velocity/spread/ammo/cooldowns; never accept client damage/position as truth |
| High | Physics allocations or map collision cost cause GC/deadline misses | Reuse bounded buffers/arrays, avoid allocations in hot loops, one match worker/process boundary initially, load profiles and 30-minute soak before capacity claim |
| Med | WebTransport server stack incomplete or draft incompatibility | Pin browser/library builds and protocol draft, test all target browsers and certificate renewal; retain WSS; don't turn optional unimplemented APIs into requirements |
| Med | WebRTC native binding/reachability/TURN costs | Build/interop/deploy spike, public UDP/mux verification, fallback and selected-candidate metrics; assess TURN relay costs before rollout |
| Med | Framework fallback silently drops state updates | Do not use Colyseus `.unreliable()` state unconditionally with WSS; transport-specific schema/delivery handling must be exercised |
| Med | Replay repeats sounds, projectiles or score changes | Deterministic event IDs, live-step versus replay separation, server-confirmed final events |
| Med | Full-state fanout grows quadratically | Budget 32-player all-to-all traffic, use compact messages, sensible interest management only after correctness; avoid giant reliable baselines blocking combat |
| Low | Port uses original packed protocol's layout/endianness accidentally | New explicit versioned binary encoding; preserve content hashes and gameplay rules, not original wire protocol |

## 5. Concrete recommendations / decisions for the spec

### 5.1 Authority and timing

**Recommend strict server authority for legal movement, projectiles/hits, ammo/reload/cooldowns, health, pickups and score, with immediate client prediction.** Clients send timestamped/numbered **intent**, not authoritative world position, projectile velocity, hit reports or damage. Retain local-only speculative muzzle flash, recoil, movement, shot/projectile and impact effects; indicate confirmed hit/kill only from server evidence. This is a deliberate networking modernization compatible with original art/maps, not a claim of identical historical netcode.

Initial parameters [RECOMMENDATION, pending measurement]:
- Simulation: **60 Hz**, fixed 1/60 s. Rendering independent. Do not change movement coefficients to fit a different rate.
- Inputs: **60 logical input frames/s**; initially send each frame (small messages). A later 30 packets/s batching experiment must still preserve 60 individual frames and explicitly accept its extra batching delay.
- Authoritative snapshots: **30/s** initially; compare 20/s. Include server tick, highest consumed input sequence, full local prediction state, and remote state/events. Do not just echo position/velocity.
- Datagram redundancy: current plus previous **2 input frames** (3 total), sequence-based deduplication. Define how gaps are filled and late one-shot actions rejected; bounded replay window is not unlimited catch-up permission.
- Remote interpolation: start **50 ms**, adapt within **33–100 ms** and expose actual render timestamp for hit-policy validation. Local player never waits for interpolation.
- Keep **500 ms** of compact server history (30 ticks) for experiments; initially cap allowed historical shot catch-up at **200 ms** (12 ticks), with max allowance constrained by measured RTT/jitter and server time mapping. Storing 500 ms does not grant 500 ms of rewind. Reject implausible future timestamps (initial allowance <=2 ticks) and never trust client-provided latency alone.
- For moving bullets: on receipt of an admissible delayed fire command, derive muzzle/aim/cooldown from historical shooter state and step the projectile through historical target states to server-now; then continue current simulation. Avoid implementing instant hitscan rewind for weapons whose original behavior is ballistics. Rockets/grenades/melee and already-applied explosions need explicit policies, not accidental reuse of a hitscan recipe.
- Prediction ring: **128 frames** (~2.13 s) as a bounded storage starting point, not permission for 2 s of input delay; request authoritative resync when missing history overflows.
- Deadlines: monotonic fixed-step accumulator. Wake timers are hints. Permit bounded catch-up (initial max **4 ticks/wakeup**); record overload and apply an explicit resync/admission policy if debt persists rather than silently altering dt. Set target sim+encode p99 **<8 ms**, scheduled tick lateness p99 **<4 ms**, no sustained >16.667 ms work at chosen capacity [targets, not observed].

For scale sense, an uncompressed 48-byte remote record × 32 players × 30 snapshots/s = **46,080 B/s (~45 KiB/s) per receiver**; 32 receivers = **1,474,560 B/s (~1.41 MiB/s)** server payload egress before projectiles/events/transport. This is arithmetic planning, not a bandwidth benchmark. Choose explicit encoding before claiming bandwidth savings. Retain float32 state initially if required for source fidelity; quantify quantization error rather than assuming arbitrary integer packing is harmless.

### 5.2 Transport and framework path

1. **First two-player slice: Node 24 LTS + WSS**, with binary/versioned message semantics and explicit tick/input acknowledgment. Keep asset fetches separate. Avoid application compression for tiny high-rate packets until measured. Cap pre-send transient queues; keep only newest unsent disposable snapshot. `bufferedAmount` can detect congestion but cannot remove already-sent stale TCP bytes.
2. **Do not commit to 'WebRTC later'.** Run the first datagram comparison with **WebTransport** now that Safari 26.4 exists. Compare WSS against Node fails-components WebTransport with public trusted TLS on UDP/443, across Chrome/Firefox/Safari. Prove datagrams, not just streams. A simple `reliableControl` / `latestState` transport boundary is sufficient; no elaborate pluggable networking framework is needed.
3. **If WebTransport server/browser interop or older-Safari requirements fail**, compare **node-datachannel/libdatachannel** with unreliable unordered movement and a separate reliable channel. Prefer direct server connections; add TURN only where measured reachability requires it. geckos.io is an ergonomic alternative, werift an inspectable pure-TS alternative; choose based on actual compatibility/tails, not marketing.
4. Keep **WSS as the explicit compatibility fallback**, selected once during session admission, with visible transport/degraded-network status. Avoid an untested mid-combat transport switch; switching requires a fresh snapshot and sequence continuity.
5. **Framework decision:** shortlist **Colyseus 0.18 versus thin custom**, not old Colyseus tutorials versus hand-written netcode. Recommend a Colyseus 0.18 WSS prediction spike with the actual Soldat step and full-state rollback first, because it now supplies substantial required machinery. Accept it only if custom simulation state, projectile handoff, bounded replay and later datagram/WSS state semantics fit without bypassing its core. Otherwise a custom binary protocol is justified by concrete mismatch. Do not couple the simulation types to Schema decorators. [INFERENCE estimate] Custom production-grade transport/protocol/prediction/interpolation/history harness is likely several thousand handwritten LOC (roughly **3–7k**, excluding gameplay), versus perhaps **1–3k** adapter/policy code if framework primitives fit; these are sizing heuristics, not source-derived estimates or effort promises.
6. Node versus Bun: same golden replay and load trace, same hardware, same runtime warm-up and memory ceiling. Choose based on p99/p99.9 scheduled lateness, sim+encode time, RSS plateau and deployed native dependency compatibility. Bun HTTP throughput benchmarks do not answer this question.

### 5.3 Latency / packet-loss test plan

This is a proposed acceptance plan, **not tests already run**.

**Reference and fixtures**
- Pin reference Soldat/OpenSoldat version, map hash, weapon config and simulation build. Record deterministic input traces: run/jump/roll/prone, jet burst and exhaustion, slope edges, fire while airborne, reload/switch, bullet push/explosion jump, simultaneous deaths, pickup contention, grenade detonation and respawn.
- Run TS simulation fixtures in server runtime and real Chromium/Firefox/Safari; compare per-tick state and isolate numerical divergence from packet effects. Replaying the same runtime twice alone is insufficient cross-engine evidence.
- Capture reference-client footage/state timing at matching impairment. Separate 'same local control response' from 'same historical misregistration'.

**Network matrix**
- RTT: **0/20/50/100/150/250 ms**, symmetric and **asymmetric 10+90 ms** paths. Specify the added delay per direction; do not accidentally label 100 ms each-way as 100 ms RTT.
- Jitter: **0/5/15/30 ms** standard deviation or documented bounded distribution. Seed it for reproducibility.
- Independent IP packet loss: **0/0.1/1/3/5%**. Burst loss: **3–8 consecutive packets**, plus **100/250/500 ms outages**. Add reordering/duplication **1–3%** on datagram paths and asymmetric one-way loss.
- Bandwidth limits/bufferbloat: uplink **128/512 kbps**, downlink **512 kbps/2 Mbps**, cross traffic and real Wi-Fi/cellular. Small path MTU **1200–1280 B** and oversized-message cases; target application datagrams **<=1000 B** and obey negotiated maxDatagramSize where available.
- Crucial: impair **actual packets with a network emulator/router** (e.g. Linux tc/netem in a dedicated test environment), not just delaying JS callbacks. Dropping an application WebSocket message does not reproduce TCP retransmission/head-of-line blocking. Add application-level deterministic packet simulation for unit tests separately.
- For deployment: UDP blocked entirely, HTTPS-only egress, TLS/TCP TURN where applicable, IPv4/IPv6, NAT, proxy idle timeout, certificate renewal and stalled handshake fallback. Test real Safari/iOS Safari, including pre-26.4 fallback if supported by product policy.

**Workload and metrics**
- **2, 8, 16, 32** players with worst realistic projectiles/grenades and map polygon loads; **30-minute** steady soaks plus **2-hour** memory/capacity soak at intended per-process match count. Measure join/disconnect churn separately.
- Record input-to-local-present (instrumented event/frame timestamps plus high-speed-camera subset), server input arrival age, server consumption delay, tick lateness, step/encode percentiles, GC pause/event-loop tails, snapshot age at render, interpolation underruns, correction vector/magnitude/frequency, replay length, event duplicates/loss, byte rates, send queue age, RTT/jitter and actual transport/relay type.
- Deterministic invariant tests: no extra ammo/fire rate, no travel teleport/speedhack, no duplicate shot/pickup/kill after replay; reject NaN/infinity, malformed packets, huge seq jumps, future/stale shot timestamps, replayed token, forged position and excessive input rate. A client stall must not gain free simulation time.

**Initial pass gates [proposed]**
- LAN: local movement visible by next rendered frame after input sampling, no RTT-dependent local input wait, no persistent numerical correction drift. Prediction/effects happen once per logical event.
- 100 ms RTT + 15 ms jitter + 1% loss: maintain 60 Hz sim at intended capacity, no unbounded queue growth, reliable game events delivered exactly once logically, no stuck fire/jet/release. Track correction p95 **<2 world units** and >10-unit corrections **<1/min/player** on ordinary movement fixtures as starting targets; tune to source scale and distinguish external impact/teleport events.
- Datagram loss: after a dropped state update, a later update can supersede it without waiting for retransmission; verify in captures/timestamps. Under WSS, document the measured head-of-line tail rather than treating it as a bug the game can erase.
- 250 ms RTT / 5% bursty loss: degraded feel allowed, but game time/ammo/security invariants still hold, no memory leak or permanent desync, explicit recover/resync/disconnect behavior. Recovery from a 500 ms outage must not apply stale held actions as an instantaneous burst.
- Promote transport/runtime only when median responsiveness is not worse and p99 snapshot/input age under 1–3% loss improves materially, with acceptable connection success and hosting complexity. No universal percentage target can be defended before traces exist.

## 6. Open questions only the user can answer

1. Which release/configuration is the feel reference: classic 1.7.1.1, current OpenSoldat, or a named competitive server weapon balance?
2. Does 'like original' mean locally familiar movement/weapons with fairer modern authority, or preserving latency-dependent quirks (client-position trust, delayed hit disagreement, old knockback timing)? Recommend the former.
3. Target supported browsers/devices: current desktop only, older Safari/iOS, or mobile controls too? This directly affects transport fallback coverage and QA, not the simulation clock.
4. Target match sizes and regions, acceptable monthly dedicated-server/TURN budget, and expected competitive seriousness?
5. Preferred hit fairness under latency: favor shooter within a bounded rewind window, favor defender's present position, or source-matching behavior? This cannot be inferred from 'authoritative'.
