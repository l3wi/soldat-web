# Binary protocol reference — version 2

Reference for client/server integrators implementing SPEC §4.4. `@soldat-web/protocol` is dependency-free at runtime. It does not interpret simulation save-state schemas or deliver assets. The simulation ABI is independently versioned; see [`sim-abi.md`](../../docs/formats/sim-abi.md).

## Codec and ownership

`encodeMessage(message)` returns one binary packet. `decodeMessage(packet)` returns the discriminated `Message` union or throws `ProtocolError` with a stable `code` and byte `offset`. All decoder failures, including invalid UTF-8 and native bounds failures, are typed. `readChannel(packet)` checks only outer framing; applications must still call `decodeMessage`.

All integers are unsigned, little-endian, except the signed i16 aim fields inside simulation input. There is no implicit padding. Strings are UTF-8 with byte lengths, not character counts, and must be well-formed Unicode. Invalid UTF-8, unknown versions/types/channels, nonzero reserved controls, truncation, trailing fields, and oversized declarations are rejected. Encoding rejects invalid numeric ranges rather than truncating them. No JSON is used by the packet codec. `welcome.rules` is a bounded opaque byte string; the admission configuration may encode the sim's rules JSON in these bytes, outside the input/snapshot hot path.

Decoded byte fields are **borrowed views** into the packet, not copies. Keep the packet immutable for as long as a decoded field is retained. Encoders make a new packet; transport `send` copies it before returning so queued data cannot be changed by the caller. Delta decoding creates an owned state array. Protocol IDs/sequences are u32 without wraparound; restart/reconnect before exhaustion. Slot numbers are original one-based 1–32; zero input acknowledgement means no input has yet been consumed. Version 2 is a clean cutover: version-1 peers are rejected, not heuristically decoded.

## Packet header

One WebSocket binary message contains exactly one packet. There is no stream concatenation or fragmentation at the application layer (WebSocket itself may fragment frames).

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u16 | Wire version, exactly `2` |
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

The direction column describes application policy, not a different wire encoding. The authoritative server rejects messages inappropriate to its admission/session state.

## Admission

Offsets below and in the remaining message tables are relative to payload start.

### hello

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u16 | Admission protocol version (must match server policy) |
| 2 | 32 bytes | Raw SHA-256 content-set hash, not hexadecimal text |
| 34 | u32 | Simulation ABI version, currently `0x00010003` |
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

The configuration file contains `wasmPath`, `contentRoot`, `map`, `matchSeed` (u64 decimal string), `rules` (object), `tlsKeyPath`, and `tlsCertPath`. Optional `host` and `port` default to `0.0.0.0` and `443`. Paths are relative to the process working directory. Never commit private TLS keys. The server derives its admission hash from `contentRoot/sim/manifest.json`; the worker independently verifies that manifest and every raw content file before mounting them in the sim.

The programmatic `createGameServer` API accepts either `{ match, tls: { key, cert } }` or `{ match, httpsServer }`, never HTTP or an insecure fallback. A caller-supplied HTTPS listener remains caller-owned; closing the game service stops only its WSS connections and match worker. Internally managed HTTPS listeners are closed too. One `worker_thread` owns one real `SimHost`/WASM instance.

Missing WASM/content, an incompatible ABI, unsupported rules/seed policy, or failed sim initialization rejects startup explicitly. Rules are passed unchanged to the versioned sim; the server never substitutes an unsupported mechanic. Each join explicitly uses `control:"authoritative"` and the admitted loadout, and records both next-respawn choices with `weapon-choice`.

The worker uses monotonic integer nanoseconds and an exact 60 Hz scaled accumulator. Each wake advances at most four fixed ticks; overdue whole steps are discarded and counted, retaining the fractional remainder. Simulation never receives variable dt. `onMetrics` reports per-tick total sim+save+delta/IPC-post plus all listener wire encodings attributed to that tick (`simEncodeMs`), the original worker-only samples (`workerSimEncodeMs`), scheduled tick lateness (`tickLatenessMs`), per-packet listener wire encoding (`wireEncodeMs`), and historical rollback durations/ticks/rejections. The total is summed work across the worker/listener, not a fabricated single-thread elapsed span. These are samples, not a performance guarantee. The optional `onReliableEvent(slot,event)` observation runs after successful reliable enqueue, including retransmissions, so qualification can compare server-enqueued IDs against client-applied IDs without claiming enqueue is TCP delivery.

Delayed-input validation and rollback execute between fixed steps. Their measured CPU work is charged to the next tick's `simEncodeMs` (and `workerSimEncodeMs`), in addition to the separate `replayMs` diagnostics. This prevents a costly synchronous rewind from disappearing from the sim budget simply because it ran in a message callback rather than `step()`.
`onDisconnect(slot,code,reason)` observes the listener's actual policy close before socket teardown. Qualification records it separately from the client's WebSocket close code: TCP failure can prevent the close frame from reaching the client, which then sees 1006 rather than the originating policy reason.

Ordinary snapshots are produced every second simulation tick (30 Hz), against each recipient's last retained acknowledged baseline. Up to 128 candidates are retained; overflow resets that recipient to an empty baseline. Resync also resets to zero. **Only one full snapshot is outstanding while baseline zero awaits acknowledgement**: WSS already reliably carries it, so queuing additional fullstates at 30 Hz would multiply TCP head-of-line blocking. After the worker accepts that exact fullstate ACK, normal deltas resume. Initial/full-resync acknowledgement has a bounded 60-second deadline. The 10-second RTT-probe deadline runs only on a synchronized session, pauses through fullstate recovery, and resumes with a fresh deadline without falsifying the probe's original RTT timestamp. A future datagram transport must preserve reliable bootstrap delivery or explicitly add retransmission; it cannot assume this WSS rule makes a datagram reliable. The hash is taken after saving the same state and before another mutation. Clients compare it **after loading and before prediction replay**, acknowledge only successfully loaded states, and hold remote controls from the input records with action bits 6–11 cleared.
Repeated resync requests while a fullstate is already outstanding coalesce onto that reliable fullstate instead of generating more bulk data. Queued/held input is still cleared. This does not grant time or acknowledge a state on the client's behalf.

Input IDs start at 1, with maximum forward jump 128. Target ticks at **server arrival** are bounded to `[current,current+2]`, per SPEC §4.4. Client prediction estimates server-now from the last snapshot, its receipt age and smoothed RTT/2. Its outbound lead targets `(smoothed RTT + p95 recent RTT deviation)/2 + two ticks`, bounded by the 128-frame ring minus eight safety ticks. Lead increases at one tick/s and decreases at four; the local prediction clock stretches/compresses within 0.9–1.1× and generates every sampled tick sequentially, never skipping inputs or fabricating a newer remote view. This is not client-owned authoritative time. Input packets are capped at 90/s with a shared bounded burst of 128 before IPC and again in the worker. Redundancy is processed oldest first. Gaps repeat movement/Fire/Jetpack/aim but clear one-shot bits 6–11; after 15 silent ticks all held controls become neutral. No packet advances the server clock. Stale ordinary target ticks, duplicate IDs, malformed controls, fabricated future view ticks and excessive sequence jumps are rejected.

Clients also request explicit resync when the unconsumed sequence distance reaches 128, even if valid snapshots keep retiring tick-indexed history. This recovers an initially rejected/backlogged stream without relaxing the server's sequence-jump ceiling. The recovery remembers its sequence floor so the first rebased input can be sent instead of immediately requesting another resync.

View age selects **lag compensation**, not permission to move. All classes retain genuine `viewTick <= targetTick` and `viewTick <= current+2`, the two-tick arrival lead, sequence/rate/replay checks, and original native cooldown/ammo/animation rules:

| Input class | View/target policy | Authoritative application |
|---|---|---|
| Current movement, jets and other ordinary controls | Old genuine views are allowed; target must be current or at most two ticks ahead | Only the ordinary fixed tick; elapsed movement is never rewritten |
| Delayed Fire/grenade eligible for compensation | Existing trusted-RTT shot window, at most 12 ticks/200 ms; existing RTT/interpolation view bounds; original historical weapon and rewind budgets | Coherent original historical projectile replay; only action bits and aim inserted |
| Fire/grenade older than compensation/view bounds, or with no retained membership-safe anchor | Still validates genuine/nonfuture view and all sequence/rate/lead/control fields | **Present-time, uncompensated** native action, not silently dropped. For stale target ticks, merge only Fire/grenade and aim onto current movement; never retroactively replay stale movement/reload/switch |
| Duplicate, malformed, future view, excessive lead or sequence/rate abuse | Rejected before application | No authority/time/ammo granted |

`uncompensatedShots` counts accepted uncompensated Fire/grenade **input frames**, including held intent; it is not a projectile/ammo counter. The native sim alone decides whether an admitted frame actually fires. Historical melee and historical action-retargeting/budget bypasses remain rejected rather than being converted into compensation.

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
```

The delta measurement command uses `build-out/sim/sim.wasm`, verified `dist/content/sim/manifest.json` content and the arena movement fixture when the real sim exists. It steps through 60 consecutive real states and checks byte-exact delta reconstruction. If WASM is absent (or `--synthetic` is supplied), it measures a deterministic sparse 64 KiB synthetic stream and explicitly reports the real save-state measurement as **pending**. A failed real module/content/fixture check fails the command instead of silently substituting synthetic results. Ratio is encoded delta bytes divided by uncompressed current-state bytes; headers outside the delta are excluded.

Measured before the real module was available: 60 synthetic consecutive-state pairs, 3,932,160 raw bytes → 9,176 delta bytes, ratio **0.00233358 (0.23336%)**.

Measured on the rebuilt real `sim.wasm` (ABI `0x00010001`): 60 consecutive arena state pairs, ticks 0→60, **307,276,440 raw bytes → 65,067 delta bytes**, ratio **0.000211754 (0.0211754%)**. Each raw state was 5,121,274 bytes; encoded deltas averaged 1,084.45 bytes. All 60 reconstructed states matched byte-for-byte. Content-set hash: `855f61f831c5c74efbf267483d21c509baddc760d4dfbcfce2b77eba8aa0c109`. This is the fixture's initial idle segment, not a combat/multiplayer bandwidth estimate. The earlier first-step tick-contract failure was fixed in the simulator before collecting these results; no synthetic fallback was used.

The ABI-1 idle delta measurement above is historical, not current combat/multiplayer evidence. Current online qualification, exact frozen binary identity, security results and all pending real-impairment/human/soak checks are recorded in [G4](../../docs/gates/G4.md).
