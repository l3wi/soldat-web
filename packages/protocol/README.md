# Binary protocol reference — version 3

Reference for client/server integrators implementing SPEC §4.4. `@soldat-web/protocol` is dependency-free at runtime. It does not interpret simulation save-state schemas or deliver assets. The simulation ABI is independently versioned; see [`sim-abi.md`](../../docs/formats/sim-abi.md).

## Codec and ownership

`encodeMessage(message)` returns one binary packet. `decodeMessage(packet)` returns the discriminated `Message` union or throws `ProtocolError` with a stable `code` and byte `offset`. All decoder failures, including invalid UTF-8 and native bounds failures, are typed. `readChannel(packet)` checks only outer framing; applications must still call `decodeMessage`.

All integers are unsigned, little-endian, except the signed i16 aim fields inside simulation input. There is no implicit padding. Strings are UTF-8 with byte lengths, not character counts, and must be well-formed Unicode. Invalid UTF-8, unknown versions/types/channels, nonzero reserved controls, truncation, trailing fields, and oversized declarations are rejected. Encoding rejects invalid numeric ranges rather than truncating them. No JSON is used by the packet codec. `welcome.rules` is a bounded opaque byte string; the admission configuration may encode the sim's rules JSON in these bytes, outside the input/snapshot hot path.

Decoded byte fields are **borrowed views** into the packet, not copies. Keep the packet immutable for as long as a decoded field is retained. Encoders make a new packet; transport `send` copies it before returning so queued data cannot be changed by the caller. Delta decoding creates an owned state array. Protocol IDs/sequences are u32 without wraparound; restart/reconnect before exhaustion. Slot numbers are original one-based 1–32; zero input acknowledgement means no input has yet been consumed. Version 3 adds the friend-lobby control plane as a clean cutover: version-1/2 peers are rejected, not heuristically decoded.

## Packet header

One WebSocket binary message contains exactly one packet. There is no stream concatenation or fragmentation at the application layer (WebSocket itself may fragment frames).

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u16 | Wire version, exactly `3` |
| 2 | u8 | Message type from the table below |
| 3 | u8 | Channel: `0` reliableControl, `1` latestState |
| 4 | u32 | Payload byte length, excluding this 8-byte header |
| 8 | bytes | Message-specific payload |

Only snapshots use channel 1. Every other type uses channel 0; a mismatch is invalid. Global packet limit is `32 MiB + 512` bytes. The tighter per-type payload limits below also apply.

| ID | Type | Direction | Maximum payload bytes |
| ---: | --- | --- | ---: |
| 1 | hello | client → server | 90 |
| 2 | welcome | server → client | 4,245 |
| 3 | input | client → server | 73 |
| 4 | snapshot | server → client | 32 MiB + 450 |
| 5 | snapshotAck | client → server | 4 |
| 6 | events | server → client | 1,048,576 |
| 7 | eventAck | client → server | 4 |
| 8 | chat | client → server; server policy handles delivery | 1,026 |
| 9 | ping | either | 8 |
| 10 | pong | reply to ping | 8 |
| 11 | resync | client → server | 4 |
| 12 | disconnect | either | 260 |
| 13 | weapon-choice | client → server | 3 |
| 14 | lobby-join | client → server | 116 |
| 15 | lobby-update | host → server | 133 |
| 16 | lobby-ready | client → server | 1 |
| 17 | lobby-start | host → server | 0 |
| 18 | lobby-leave | client → server | 0 |
| 19 | lobby-state | server → client | 8,192 |
| 20 | lobby-error | server → client | 258 |

The direction column describes application policy, not a different wire encoding. The authoritative server rejects messages inappropriate to its admission/session state.

## Admission

Offsets below and in the remaining message tables are relative to payload start.

### hello

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u16 | Admission protocol version (must match server policy) |
| 2 | 32 bytes | Raw SHA-256 content-set hash, not hexadecimal text |
| 34 | u32 | Simulation ABI version, currently `0x00010004` |
| 38 | u16 | Nickname UTF-8 byte length N, 1–48 |
| 40 | N bytes | Nickname |
| 40+N | u8 | Primary weapon original number, server admission accepts 1–10 |
| 41+N | u8 | Secondary weapon original number: 0 (USSOCOM), 11 (knife), 12 (chainsaw), 13 (LAW) |

The outer wire version is checked before admission fields. Content identity must match the verified simulation content manifest, not a map filename alone.

### welcome

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u8 | Assigned slot, 1–32 |
| 1 | u32 | Current server tick |
| 5 | u16 | Tick rate, exactly 60 |
| 7 | u64 | Match seed (JavaScript bigint) |
| 15 | u16 | Map-name UTF-8 byte length N, 1–128 |
| 17 | N bytes | Map name |
| 17+N | u32 | Rules byte length R, 0–4,096 |
| 21+N | R bytes | Opaque rules bytes |

## In-match weapon choice

`{type:"weapon-choice", primary, secondary, selection}` uses `reliableControl`, only after welcome. Its exact three-byte payload is u8 `primary` at offset 0 (original weapon numbers 1–10), u8 `secondary` at offset 1 (0 = USSOCOM, 11 = knife, 12 = chainsaw, 13 = LAW), then u8 selection at offset 2 (0 = `"primary"`, 1 = `"secondary"`). `selection` is required; both encoder and decoder reject other values. The message carries intent only: no slot, ammo, position, health, or eligibility assertion.

The server derives the slot from the admitted connection. A separate token bucket permits a burst of four choices and refills at two per second, checked before worker IPC and again by the worker. Invalid bytes or rate abuse close only that connection. Every valid choice is stored with the sim's `weapon-choice` command for the next respawn. The server also attempts `weapon-apply` with the requested selection; original limbo rules determine eligibility. A secondary selection changes only the secondary gun and keeps the limbo window open; a primary selection applies the loadout and closes it until respawn. A sim status of `-4` leaves the next-respawn choice intact rather than terminating the match or granting a live reload. Reliable commands clear rewind history so delayed shots cannot roll back across a loadout change.

## Input batch

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u8 | Frame count N, 1–3 |
| 1+24i | u32 | Input sequence, 1–2³²−1 |
| 5+24i | u32 | Target simulation tick |
| 9+24i | u32 | Client-declared remote render/view tick |
| 13+24i | 12 bytes | Simulation input, for frame i |

Send current frame first, followed by previous two when available. Admission has no fabricated historical frames. The server's input buffer processes redundancy oldest first. Target tick T is the current sim tick before the step that advances T → T+1, consistent with `SimHost.setInput`.

| Input offset | Type | Field |
| ---: | --- | --- |
| 0 | u16 | Bits 0–11: Left, Right, Up, Down, Fire, Jetpack, ThrowNade, ChangeWeapon, ThrowWeapon, Reload, Prone, FlagThrow |
| 2, 4, 6 | i16 each | MouseAimX, MouseAimY, MouseDist |
| 8 | u16 | Press order: left-first=1, right-first=2, up-first=4, down-first=8 |
| 10 | u16 | Reserved, zero |

Bits 12–15 of control and bits 4–15 of press order are zero. Conflicting order pairs 1+2 or 4+8 are invalid. Coordinate ranges are the complete signed i16 range; browser floating-point/NaN coordinates are never transmitted as f32.

## Snapshots and acknowledgement

### snapshot

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u32 | Server tick represented by the state |
| 4 | u32 | Last consumed input sequence **for this recipient**, zero before first input |
| 8 | u32 | This snapshot's nonzero ID |
| 12 | u32 | Acknowledged baseline snapshot ID, or zero for empty baseline |
| 16 | u64 | `sim_hash_state` of this exact authoritative snapshot tick |
| 24 | u8 | Active input record count A, 0–32 |
| 25+13i | u8 | Original player slot, strictly ascending |
| 26+13i | 12 bytes | Last authoritative consumed input for that slot |
| 25+13A | u32 | Encoded state byte length D, 5–(32 MiB + 5) |
| 29+13A | D bytes | Delta-encoded opaque sim save-state |

Snapshot IDs and baseline IDs are per recipient. `snapshotAck` consists of a nonzero u32 snapshot ID at offset 0. A sender may choose a baseline only after receiving an acknowledgement for a state it actually sent. A receiver must acknowledge only after successful delta decoding and successful sim state loading. Never acknowledge an unreceived or rejected state. Do not assume that an unsent/coalesced snapshot became a baseline.

Input records include bots as well as humans. Bot records are projected from the simulation's published `controlBits`, `aimX`, `aimY`, and `mouseDist`; press-order and reserved words are zero. Names, teams, kills, deaths, appearance, and team scores remain in the authoritative sim state/render projection, not duplicated host-maintained player objects. Clients initialize their sim instances with `ai:false`, load the authoritative snapshots, and hold these remote inputs during prediction; clients never run bot policy.

`resync` consists of the unavailable/rejected u32 baseline ID at offset 0. Baseline zero requests a full state. The server resets this recipient's baseline and sends a delta against empty bytes. An unknown baseline must cause resync, not decoding against an unrelated state. Explicit resync also discards unsimulated queued/held intent and allows one next current/future input to rebase its forward sequence jump; IDs must still exceed the previously accepted floor. Clients keep sequences monotonic. This lets a >128-frame outage recover without granting extra simulation time; stale historical actions are not admitted during rebase.

### Delta byte format

`encodeDelta(state, baseline?)` and `decodeDelta(delta, baseline?)` treat both blobs as opaque. Omitted baseline is empty. Baseline bytes beyond its length are implicitly zero, so shrinking/growing/empty states round-trip exactly. Both state and baseline are bounded to 32 MiB. `validateDelta(delta)` validates framing and returns decoded byte length without allocation or baseline data; the snapshot codec calls it automatically. It cannot verify that a caller supplied the correct baseline ID/content.

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u8 | Mode: 0 raw XOR, 1 zero/literal runs |
| 1 | u32 | Decoded state length L |
| 5 | bytes | Mode-specific bytes |

Mode 0 contains exactly L XOR bytes (`state[i] XOR (baseline[i] ?? 0)`). Mode 1 is a sequence of u32 run tokens, each covering a nonzero count of output bytes. Bit 31 set means literal XOR bytes follow; bits 0–30 encode count. Bit 31 clear means a zero XOR run with no following bytes (copy baseline/implicit zero). Runs must cover exactly L bytes; zero-length, overflowing, truncated and trailing runs are invalid.

The deterministic encoder groups zero runs of at least 8 bytes; shorter zeros remain inside literal spans. It measures runs without an intermediate XOR allocation and falls back to raw XOR unless runs are strictly smaller. Encoded output never exceeds L+5 bytes. Decoder validates runs before allocating output. This is compression, not authentication; TLS and the admission identities protect the session.

## Reliable simulation events

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u16 | Event count N, 1–64 |
| 2 onward | records | N consecutive records, each as below |

| Record-relative offset | Type | Field |
| ---: | --- | --- |
| 0 | u32 | Nonzero application event ID |
| 4 | u32 | Event tick |
| 8 | 20 bytes | Unmodified simulation event header |
| 28 | P bytes | Opaque payload, at most 65,535 bytes |

The sim header is five u32 fields: kind, tick, source, target, payloadBytes. Its tick must equal the event envelope tick, and payloadBytes must equal P. Presentation-only kinds retain bit 31. The entire events payload, including count/record overhead, is capped at 1 MiB.

`eventAck` contains one nonzero u32 event ID at offset 0. Application consumers must remember handled IDs and ignore duplicate effects; socket reliability alone is not an exactly-once application policy. Acknowledgement/retransmit retention and deduplication are session responsibilities, not side effects of decoding. Reusing an event ID for a different event is invalid application behavior.

## Chat, timing and disconnect

| Type | Payload layout |
| --- | --- |
| chat | Offset 0 u16 text byte length N (1–1,024); offset 2 UTF-8 text |
| ping / pong | Offset 0 u64 sender timestamp; pong echoes it unchanged |
| disconnect | Offset 0 u16 application reason code; offset 2 u16 reason byte length N (0–256); offset 4 UTF-8 reason |

Timestamp units are sender-defined monotonic microseconds. A pong is an echo, not a synchronization of two unrelated clocks. `disconnect.code` is the application's reason code, independent of WebSocket close status.

## WSS transport and backpressure

Import browser transport and interfaces from `@soldat-web/protocol/transport`:

```ts
import { connectWss } from "@soldat-web/protocol/transport";
import { decodeMessage, encodeMessage } from "@soldat-web/protocol";

const connection = connectWss("wss://game.example.invalid/");
connection.onMessage = (_channel, packet) => {
  const message = decodeMessage(packet);
  // Dispatch the admitted session's actual message types here.
};
connection.onError = error => console.error(error);
connection.send("reliableControl", encodeMessage({ type: "ping", timestamp: 1n }));
```

`MessageTransport` exposes `send(channel, packet)`, `close(code?, reason?)`, and assignable `onMessage`, `onClose`, `onError` callbacks. The browser factory returns synchronously and queues until open. It requires `wss:` and uses native WebSocket with `binaryType="arraybuffer"`. The Node adapter is `createNodeTransport(socket)` in `packages/server/src/transport/ws-server.ts` and uses the server's `ws` dependency. WSS implements both channels over one ordered socket; it cannot undo head-of-line blocking for bytes already sent.

Reliable packets are FIFO and prioritized; they are never silently dropped. The default reliable backlog is bounded by MAX_PACKET_BYTES and 1,024 packets. Overflow produces an explicit error and closes the connection. Latest state retains exactly one **unsent** packet, replacing it on a newer snapshot. Queued bytes are copied on enqueue. Adapters do not send more while WebSocket bufferedAmount is nonzero; the browser polls only while backlog exists (10 ms), and Node uses send completion callbacks with bounded polling when necessary. Close/error clears pending data and scheduling. This is not a WebTransport implementation; that remains Phase 6.

Browsers permit application close codes rather than arbitrary protocol close codes. Fatal browser adapter codes are 4002 (protocol), 4009 (size), 4013 (backpressure), 4011 (socket failure); Node uses 1002/1009/1013/1011 respectively. Closing a failed session is explicit failure, not delivery of its queued reliable messages.

## Node 24 authoritative match server

Start the configured WSS listener from the repository root:

```sh
SOLDAT_SERVER_CONFIG=/absolute/path/server.json node packages/server/src/main.ts
```

The configuration file contains `wasmPath`, `contentRoot`, `map`, `matchSeed` (u64 decimal string), `rules` (object), `tlsKeyPath`, and `tlsCertPath`. Optional `host` and `port` default to `0.0.0.0` and `443`; `targetPlayers` defaults to eight and accepts 1–32; `maxMatches` defaults to eight. `publicUrl` is the external HTTPS origin, required behind a reverse proxy. `regions` is an explicit list of `{id,name,url}` HTTPS origins; without it the server advertises its single Local listener. Paths are relative to the process working directory. Never commit private TLS keys. `contentRoot/index.json` supplies the validated bot-capable map catalog, and `sim/manifest.json` supplies the admission hash. Match workers are created lazily; each independently verifies content before mounting it.

The programmatic `createGameServer` API accepts either `{ match, tls: { key, cert } }` or `{ match, httpsServer }`, never HTTP or an insecure fallback. A caller-supplied HTTPS listener remains caller-owned; closing the game service stops only its WSS connections and match worker. Internally managed HTTPS listeners are closed too. One `worker_thread` owns one real `SimHost`/WASM instance.

Missing WASM/content, an incompatible ABI, unsupported rules/seed policy, or failed sim initialization rejects match creation explicitly. The server enables `ai:true` and defaults `rules.world` to `"original"` for native flags, medikits, grenade kits and map-authored stationary guns. Explicit `"fixture"` retains the controlled legacy harness world; welcome carries this match-identity rule unchanged. `rules.botDifficulty` accepts an integer in 0–300 (sim default 100). Product matchmaking uses dynamic `targetPlayers`; standalone qualification callers may still specify fixed `botCount:0..31` when no target is configured.

With a population target, each human join removes one original bot with `leave` before the human is admitted; each human departure joins an original profile in a free slot. Profiles rotate through Admiral, Billy, Blain, Boogie Man, Commando, D Dave, Danko, Dutch, John, Kruger, Poncho, Roach, Sgt. Mac, Sniper, Stevie, and Terminator, loaded from `bots/<lowercase basename>.bot`. The simulation retains each profile's original name, cosmetics and weapon preference. DM uses team zero; every CTF join/refill selects the less populated current team (Alpha on ties). Without a target, standalone fixed bots retain their highest-slot reservations for qualification. Human slots are not reused until the worker confirms leave; a replacement connection waits in a bounded admission queue during that acknowledgement race.

Human joins explicitly use `control:"authoritative"` and the admitted loadout, and record both next-respawn choices with `weapon-choice`. Welcome carries the effective server rules, including `ai:true`; prediction and extraction hosts must override only AI execution to `ai:false` before loading server snapshots.

The worker uses monotonic integer nanoseconds and an exact 60 Hz scaled accumulator. Each wake advances at most four fixed ticks; overdue whole steps are discarded and counted, retaining the fractional remainder. Simulation never receives variable dt. `onMetrics` reports per-tick total sim+save+delta/IPC-post plus all listener wire encodings attributed to that tick (`simEncodeMs`), the original worker-only samples (`workerSimEncodeMs`), scheduled tick lateness (`tickLatenessMs`), per-packet listener wire encoding (`wireEncodeMs`), and historical rollback durations/ticks/rejections. The total is summed work across the worker/listener, not a fabricated single-thread elapsed span. These are samples, not a performance guarantee. The optional `onReliableEvent(slot,event)` observation runs after successful reliable enqueue, including retransmissions, so qualification can compare server-enqueued IDs against client-applied IDs without claiming enqueue is TCP delivery.

Delayed-input validation and rollback execute between fixed steps. Their measured CPU work is charged to the next tick's `simEncodeMs` (and `workerSimEncodeMs`), in addition to the separate `replayMs` diagnostics. This prevents a costly synchronous rewind from disappearing from the sim budget simply because it ran in a message callback rather than `step()`.
`onDisconnect(slot,code,reason)` observes the listener's actual policy close before socket teardown. Qualification records it separately from the client's WebSocket close code: TCP failure can prevent the close frame from reaching the client, which then sees 1006 rather than the originating policy reason.

Ordinary snapshots are produced every second simulation tick (30 Hz), against each recipient's last retained acknowledged baseline. Up to 128 candidates are retained; overflow resets that recipient to an empty baseline. Resync also resets to zero. **Only one full snapshot is outstanding while baseline zero awaits acknowledgement**: WSS already reliably carries it, so queuing additional fullstates at 30 Hz would multiply TCP head-of-line blocking. After the worker accepts that exact fullstate ACK, normal deltas resume. Initial/full-resync acknowledgement has a bounded 60-second deadline. The 10-second RTT-probe deadline runs only on a synchronized session, pauses through fullstate recovery, and resumes with a fresh deadline without falsifying the probe's original RTT timestamp. A future datagram transport must preserve reliable bootstrap delivery or explicitly add retransmission; it cannot assume this WSS rule makes a datagram reliable. The hash is taken after saving the same state and before another mutation. Clients compare it **after loading and before prediction replay**, acknowledge only successfully loaded states, and hold remote controls from the input records with action bits 6–11 cleared.
Repeated resync requests while a fullstate is already outstanding coalesce onto that reliable fullstate instead of generating more bulk data. Queued/held input is still cleared. This does not grant time or acknowledge a state on the client's behalf.

Input IDs start at 1, with maximum forward jump 128. Target ticks at **server arrival** are bounded to `[current,current+8]`, per the revised SPEC §4.4. These inputs are queued and consumed only at their own fixed tick; arriving early never buys simulation time. At most nine distinct target ticks (current plus eight future) fit the per-player queue. Client prediction estimates server-now from the last snapshot, its receipt age and smoothed RTT/2. Outbound lead targets `RTT/2 + min(p95 recent RTT deviation/2, six ticks) + two ticks`, bounded by the 128-frame ring minus eight safety ticks. The six-tick jitter cap reserves two ticks of the server's admission window for clock-estimate error. Lead increases at one tick/s and decreases at four; the local prediction clock stays within 0.9–1.1× and generates sampled ticks sequentially. Actual remote view ticks are never fabricated. Inputs remain capped at 90 packets/s with burst 128 in listener and worker. Redundancy is processed oldest first. Gaps repeat movement/Fire/Jetpack/aim but clear one-shot bits 6–11; after 15 silent ticks held controls become neutral. Stale ordinary target ticks, duplicate IDs, malformed controls, fabricated future views and excessive sequence jumps are rejected.

Clients also request explicit resync when the unconsumed sequence distance reaches 128, even if valid snapshots keep retiring tick-indexed history. This recovers an initially rejected/backlogged stream without relaxing the server's sequence-jump ceiling. The recovery remembers its sequence floor so the first rebased input can be sent instead of immediately requesting another resync.

View age selects **lag compensation**, not permission to move. All classes retain genuine `viewTick <= targetTick` and `viewTick <= current+2`, the eight-tick queued arrival window, sequence/rate/replay checks, and original native cooldown/ammo/animation rules:

| Input class | View/target policy | Authoritative application |
|---|---|---|
| Current movement, jets and other ordinary controls | Old genuine views allowed; target must be current or at most eight ticks ahead | Queued until its ordinary fixed tick; elapsed movement is never rewritten |
| Delayed Fire/grenade eligible for compensation | Existing trusted-RTT shot window, at most 12 ticks/200 ms; existing RTT/interpolation view bounds; original historical weapon and rewind budgets | Coherent original historical projectile replay; only action bits and aim inserted |
| Fire/grenade older than compensation/view bounds, or with no retained membership-safe anchor | Still validates genuine/nonfuture view and all sequence/rate/lead/control fields | **Present-time, uncompensated** native action, not silently dropped. For stale target ticks, merge only Fire/grenade and aim onto current movement; never retroactively replay stale movement/reload/switch |
| Duplicate, malformed, future view, excessive lead or sequence/rate abuse | Rejected before application | No authority/time/ammo granted |

`uncompensatedShots` counts accepted uncompensated Fire/grenade **input frames**, including held intent; it is not a projectile/ammo counter. The native sim alone decides whether an admitted frame actually fires. Historical melee and historical action-retargeting/budget bypasses remain rejected rather than being converted into compensation.

`inputBufferOccupancy` and `inputBufferLeadTicks` report per-player/per-tick queued-count and furthest-queued-lead samples. The practical lead target is 1–3 ticks; hard bounds are nine queued inputs and eight future ticks. They expose starvation or systematically excessive prediction lead instead of hiding it in an average RTT.

Reliable gameplay events use only the canonical `SIM_GAMEPLAY_EVENTS` kinds `0x1001..0x1007` (death, flag info, Thing pickup/state, respawn, team scores and match end), with exact payloads documented in [sim-abi](../../docs/formats/sim-abi.md). Presentation kinds and legacy raw network-packet events are excluded. IDs are assigned only once their timeline is committed (12 ticks after simulation), retained until cumulative acknowledgement, retransmitted every 30 ticks, and must be deduplicated by the client. Event overflow explicitly closes the session and requires reconnect/full resync; it never silently discards a kill/pickup/capture. Future/unknown acknowledgements are rejected. The server also issues ping probes and accepts only the matching pong; historical-shot allowance uses this measured RTT, never a client-declared latency.

### Historical projectile policy and trade-offs

The single server instance retains 31 tick-boundary history entries (500 ms span), consumed inputs and historical active weapons. Normal ticks save fullstate anchors; replay invalidates affected successor anchors and rebuilds overlapping history from the nearest valid retained anchor without serializing every intermediate state. A newly sequenced delayed Fire/grenade intent can rewind at most `min(12,ceil(RTT_ms*0.03)+2)` ticks (200 ms hard cap). The declared view tick must be no later than shot/current+2, no earlier than shot−18, and is further bounded by measured RTT plus an interpolation allowance. Accepted history inserts **only** Fire/ThrowNade and quantized aim; movement stays recorded. Every player's recorded input is replayed to now using `REPLAY`. This derives muzzle, spread/RNG, ammo, cooldown, collision, damage and explosions from original mechanics. An overlapping replay may include an already-corrected prefix before the inserted shot; its already committed events are drained, never confirmed twice. Replay metrics count all actual steps including that prefix. One rewind globally per current tick and one per player per six ticks bound abuse/cost. Membership changes invalidate history, preventing replay across joins/leaves.

These view-age bounds govern the historical branch only. Expired compensation uses the present-time policy in the table above, preserving the declared old view instead of pretending the client rendered a newer state.

Bullets, shotgun pellets, arrows, flame, M79 and LAW rockets use the same coherent historical timeline, not instant hitscan against displaced targets. Grenades rewind their original launch/fuse/bounces/explosion as a whole. Delayed knife/chainsaw/unarmed Fire is rejected: melee is present-time only; ordinary timely melee remains simulated normally. Weapon/drop/reload/prone/flag actions are not admitted retrospectively. Previously committed events cannot be undone; deferring gameplay events through the 12-tick rewind window prevents duplicate or phantom kill/pickup/capture notifications after historical replay. The user sees predicted movement/muzzle/audio effects immediately; kill-feed/score confirmations arrive approximately **200 ms plus server-to-client delivery time** after the simulated event. Speculative effects are not confirmation.

Compared with target-only rewind, full-state resimulation preserves projectile travel and explosion interaction. Compared with a second authoritative simulation, it avoids another live instance and state handoff. Its costs are state validation/copies and actual replay steps, plus delayed confirmed events. The measured cost, exercised weapons and acceptance status belong in [G4](../../docs/gates/G4.md), not an assumed capacity claim.

## Development commands and measurement

From the repository root after `bun install`:

```sh
bun run --cwd packages/protocol test
bun run --cwd packages/server test
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server typecheck
node packages/protocol/scripts/measure-delta.ts
node --test packages/server/scripts/bots.test.ts
```

The bot integration test requires the current ABI-4 WASM and regenerated content, including stock bot profiles and waypoint maps. It starts a real TLS/WSS server and two Node worker clients running the product `OnlineSession` with AI disabled. DM/Arena and CTF/ctf_Ash cases check snapshot hashes in both clients, relayed controls, profile names, balanced teams, scores, waypoint movement, and firing. It also checks malformed choices and choice flooding against a healthy match. `NET_G4_WASM`, `NET_G4_CONTENT`, and `NET_BOTS_OUT` override the module, content root, and test-artifact directory. This command is an acceptance test, not a claim that it has already passed.

The delta measurement command uses `build-out/sim/sim.wasm`, verified `dist/content/sim/manifest.json` content and the arena movement fixture when the real sim exists. It steps through 60 consecutive real states and checks byte-exact delta reconstruction. If WASM is absent (or `--synthetic` is supplied), it measures a deterministic sparse 64 KiB synthetic stream and explicitly reports the real save-state measurement as **pending**. A failed real module/content/fixture check fails the command instead of silently substituting synthetic results. Ratio is encoded delta bytes divided by uncompressed current-state bytes; headers outside the delta are excluded.

Measured before the real module was available: 60 synthetic consecutive-state pairs, 3,932,160 raw bytes → 9,176 delta bytes, ratio **0.00233358 (0.23336%)**.

Measured on the rebuilt real `sim.wasm` (ABI `0x00010001`): 60 consecutive arena state pairs, ticks 0→60, **307,276,440 raw bytes → 65,067 delta bytes**, ratio **0.000211754 (0.0211754%)**. Each raw state was 5,121,274 bytes; encoded deltas averaged 1,084.45 bytes. All 60 reconstructed states matched byte-for-byte. Content-set hash: `855f61f831c5c74efbf267483d21c509baddc760d4dfbcfce2b77eba8aa0c109`. This is the fixture's initial idle segment, not a combat/multiplayer bandwidth estimate. The earlier first-step tick-contract failure was fixed in the simulator before collecting these results; no synthetic fallback was used.

The ABI-1 idle delta measurement above is historical, not current combat/multiplayer evidence. Current online qualification, exact frozen binary identity, security results and all pending real-impairment/human/soak checks are recorded in [G4](../../docs/gates/G4.md).

## Matchmaking HTTP reference

The HTTPS origin corresponding to the game WSS endpoint serves JSON endpoints. All responses use `Cache-Control: no-store`; allowed development origins receive explicit CORS headers. POST requests require `Content-Type: application/json`, at most 1,024 body bytes, and no unknown fields. Errors are `{error:string}` with 400 (invalid), 403 (origin), 404 (missing), 409 (full), 413/415 (body), 429 (rate), or 503 (server capacity). Successful POSTs return 201; GETs return 200.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/ping` | — | `{ok:true}`; measure actual RTT, not a configured latency |
| `GET /api/regions` | — | `[{id,name,url}]`; `url` is an HTTPS origin; only configured regions exist |
| `POST /api/quickplay` | `{nickname}` | `{matchId,wsUrl,map,mode,humans:string[],bots:number}` |
| `POST /api/lobbies` | `{mode:"dm"|"ctf",map}` | `{code,hostToken,wsUrl}` |
| `GET /api/lobbies/:code` | — | `LobbyLookup`: `LobbyState` plus canonical lobby `wsUrl`, without host token or admission ticket |

Quickplay selects the available public match with the lowest human-plus-reservation load, otherwise starts a separate worker/WASM with a rotating bot-capable stock DM map. The response roster includes pending reservations. `wsUrl` includes a random, single-use admission ticket valid for 30 seconds. Connect there using the ordinary binary `hello`; there is no new simulation admission message. Unconsumed reservations expire and cannot exhaust capacity permanently.

The six-character lobby code is uppercase alphanumeric. The creator keeps the random host capability private and sends it only in `lobby-join`. Share `/?lobby=CODE`, never the token. Use the canonical lobby `wsUrl` returned by create/lookup; do not derive it from the browser's HTTP origin, which may be a development proxy. Lobby state is `{code,mode,map,targetPlayers,players:[{id,nickname,ready,host}],started,matchId?,matchWsUrl?}`. The WSS state personalizes `matchWsUrl` with that member's ticket; the public GET intentionally does not. `selfId` identifies the receiving member. Different users may have identical display names.

## Lobby binary payload reference

Every lobby message uses reliableControl and the existing eight-byte binary header. Strings below use the codec's u16 UTF-8 byte length prefix; modes are u8 (`0` DM, `1` CTF), booleans u8 (`0` false, `1` true), and populations u8 (`1..32`). Invalid flags, booleans, modes, bounds, truncation and trailing fields are rejected.

| Message | Ordered payload fields |
| --- | --- |
| `lobby-join` | nickname string (1..48 bytes), hostToken string (0..64; empty means guest) |
| `lobby-update` | u8 presence mask (mode=1, map=2, targetPlayers=4; 1..7), then present mode, map string (1..128), targetPlayers |
| `lobby-ready` | ready boolean |
| `lobby-start`, `lobby-leave` | empty |
| `lobby-error` | reason string (1..256) |
| `lobby-state` | selfId string (1..32), code string (6), mode, map string (1..128), targetPlayers, u8 roster length (0..32), roster entries, started boolean, then matchId string (1..64) and personalized matchWsUrl string (1..1024) only when started |
| roster entry | id string (1..32), nickname string (1..48), ready boolean, host boolean |

Only the host may update mode/map/target or start. Send compatible mode/map changes together. Setup changes reset guest readiness; the host is always ready. Start requires all current guests ready. The server locks setup during worker creation, broadcasts the started state, and late joins receive a ticket to the same match, replacing a bot. Leaving closes that member's lobby session; closing an unstarted host session closes its lobby rather than transferring the capability to a stranger. Once started, the match survives host departure.

Lobby traffic has a 12-message burst and four messages/second refill per socket. API creation has an eight-request burst per source IP and one request/10 seconds refill; rejected POSTs consume that budget too. Match workers, lobbies, roster lengths, pending admissions, request bodies and packet sizes are bounded. Default idle cleanup is five minutes with no humans or reservations; empty lobbies also expire. Population targets count humans plus original bots, never exceed 32, and preserve CTF team balance on replacement/refill.

