# Binary protocol reference — version 7

Reference for client/server integrators implementing SPEC §4.4. `@soldat-web/protocol` is dependency-free at runtime. It does not interpret simulation save-state schemas or deliver assets. The simulation ABI is independently versioned; see [`sim-abi.md`](../../docs/formats/sim-abi.md).

## Codec and ownership

`encodeMessage(message)` returns one binary packet. `decodeMessage(packet)` returns the discriminated `Message` union or throws `ProtocolError` with a stable `code` and byte `offset`. All decoder failures, including invalid UTF-8 and native bounds failures, are typed. `readChannel(packet)` checks only outer framing; applications must still call `decodeMessage`.

All integers are unsigned, little-endian, except the signed i16 aim fields inside simulation input. There is no implicit padding. Strings are UTF-8 with byte lengths, not character counts, and must be well-formed Unicode. Invalid UTF-8, unknown versions/types/channels, nonzero reserved controls, truncation, trailing fields, and oversized declarations are rejected. Encoding rejects invalid numeric ranges rather than truncating them. Step commands are bounded UTF-8 JSON bytes, validated without rewriting their original representation. `welcome.rules` remains a bounded opaque byte string; applications interpret the sim rules.

Decoded byte fields are **borrowed views** into the packet, not copies. Keep packets immutable while retained. Encoders allocate a new packet; transport `send` copies before returning. IDs/sequences are u32 without wraparound; restart/reconnect before exhaustion. Slots are one-based 1–32; zero input acknowledgement means none consumed. Version 7 adds typed gestures, authenticated administration, voting, radio and voice signaling to version 6 chat/round/input relay. Older wire versions are rejected; simulation ABI remains independently versioned at 6. Input relay has no snapshot IDs, acknowledgements, baselines or full-state deltas.

## Packet header

One WebSocket binary message contains exactly one packet. There is no stream concatenation or fragmentation at the application layer (WebSocket itself may fragment frames).

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u16 | Wire version, exactly `7` |
| 2 | u8 | Message type from the table below |
| 3 | u8 | Channel: `0` reliableControl, `1` latestState |
| 4 | u32 | Payload byte length, excluding this 8-byte header |
| 8 | bytes | Message-specific payload |

Only `state` and `ticks` use channel 1. Every other type uses channel 0; mismatches are invalid. Both channels are ordered/reliable on WSS. Server→client decoder limit remains `32 MiB + 512` bytes. WebSocket ingress uses `MAX_CLIENT_PACKET_BYTES` (**60,416 bytes**), derived from legal client payloads plus framing, rounded up to 1 KiB. Per-type limits below also apply. Voice media never travels over this connection.

| ID | Type | Direction | Maximum payload bytes |
| ---: | --- | --- | ---: |
| 1 | hello | client → server | 113 |
| 2 | welcome | server → client | 4,249 |
| 3 | input | client → server | 73 |
| 4 | ticks | server → client | 1,048,576 |
| 5 | state | server → client | 32 MiB + 20 |
| 6 | events | server → client | 1,048,576 |
| 7 | eventAck | client → server | 4 |
| 8 | chat | client → server | 1,027 |
| 9 | ping | either | 8 |
| 10 | pong | reply to ping | 8 |
| 11 | resync | client → server | 0 |
| 12 | disconnect | either | 260 |
| 13 | weapon-choice | client → server | 3 |
| 14 | lobby-join | client → server | 116 |
| 15 | lobby-update | host → server | 8,448 |
| 16 | lobby-ready | client → server | 1 |
| 17 | lobby-start | host → server | 0 |
| 18 | lobby-leave | client → server | 0 |
| 19 | lobby-state | server → client | 16,384 |
| 20 | lobby-error | server → client | 258 |
| 21 | lobby-kick | host → server | 34 |
| 22 | team-change | client → server | 1 |
| 23 | appearance | client → server | 23 |
| 24 | chat-message | server → client | 1,078 |
| 25 | notice | server → client | 258 |
| 26 | gesture | client → server | 60,004 |
| 27 | self-kill | client → server | 60,004 |
| 28 | admin-auth | client → server | 60,004 |
| 29 | admin-logout | client → server | 60,004 |
| 30 | admin-action | client → server | 60,004 |
| 31 | vote-start | client → server | 60,004 |
| 32 | vote-cast | client → server | 60,004 |
| 33 | radio | client → server | 60,004 |
| 34 | voice-configure | client → server | 60,004 |
| 35 | voice-signal | client → server | 60,004 |
| 36 | control-state | server → client | 60,004 |
| 37 | admin-bans | server → client | 524,292 |
| 38 | radio-message | server → client | 60,004 |
| 39 | voice-state | server → client | 262,148 |
| 40 | voice-signal-delivery | server → client | 60,004 |

The direction column describes application policy, not a different wire encoding. The authoritative server rejects messages inappropriate to its admission/session state.

### Feature payloads (IDs 26–40)

Payload is `u32 JSON UTF-8 byte length`, then that many bytes. The JSON object includes its `type`, which must exactly match the outer message ID. `features.ts` defines the discriminated request/delivery schemas; `feature-codec.ts` rejects unknown fields, missing fields, wrong scalar/discriminant types, malformed Unicode and field bounds. Generic client feature JSON is at most 60,000 bytes. SDP is audio-only at the relay, at most 32,768 UTF-8 bytes; ICE candidates are at most 2,048 bytes. Signaling is authenticated and rate-limited separately from ordinary controls.

- `gesture {gesture}` and `self-kill` carry no target slot: admission determines the actor.
- `admin-auth {token}` / `admin-logout` change operator authority. `admin-action {action}` accepts only kick, timed ban/unban/list, mute/unmute, force-team/kill, compatible map/next/restart and pause/unpause. Tokens never enter server responses. Host privilege comes from a validated lobby reservation, not hello fields.
- `vote-start {proposal}` proposes a map or kick target; `vote-cast {id,choice}` binds yes/no to the active vote and admission nonce. Personalized `control-state` includes host/admin/paused/muted and the vote tally, eligibility, ballot, deadline and result. Reused slots do not inherit votes.
- `radio {category,direction}` carries two integers 1–3, never client text/name/team. `radio-message` supplies authenticated name/slot and canonical choice codes; the authority routes exact native teams and rejects spectator/muted senders.
- `voice-configure {enabled,channel,transmitting}` opts in to public/team audio. `voice-state` includes `selfId`, ICE configuration and admission-nonce peers with server-owned positive-safe-integer `generation`, directional `canSend`/`canReceive` and talking policy. `voice-signal {peerId,generation,signal}` routes offer/answer/candidate only to an authorized current pair; delivery supplies its authenticated sender nonce and matching generation. Revoked/re-enabled pairs get a new generation, so old same-admission SDP/ICE cannot attach to a replacement connection.

Pause freezes native/predicted ticks and gameplay input, not control messages, heartbeats or vote deadlines. Resume installs authoritative state and resets input/clock debt. WebRTC carries only voice; native mechanics and hashes remain server-authoritative.


## Admission

Offsets below and in the remaining message tables are relative to payload start.

### hello

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u16 | Admission protocol version (must match server policy) |
| 2 | 32 bytes | Raw SHA-256 content-set hash, not hexadecimal text |
| 34 | u32 | Simulation ABI version, currently `0x00010006` |
| 38 | u16 | Nickname UTF-8 byte length N, 1–48 |
| 40 | N bytes | Nickname |
| 40+N | u8 | Primary weapon original number, server admission accepts 1–10 |
| 41+N | u8 | Secondary weapon original number: 0 (USSOCOM), 11 (knife), 12 (chainsaw), 13 (LAW) |
| 42+N | 23 bytes | Player appearance: five u32 RGB colors, then three u8 style indices |

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
| 21+N+R | u32 | Round epoch |

### Gameplay settings and round bootstrap

Mode IDs use the original order: `dm=0`, `pm=1`, `tm=2`, `ctf=3`, `rambo=4`, `inf=5`, `htf=6`. `normalizeMatchRules` fills omitted defaults and rejects unknown keys, non-booleans, non-finite/fractional numbers and invalid enum values. Rules include realistic, survival, advance/advanceAmount (1..9999), bulletTime, five bonus switches, bonusFrequency (0..5), friendlyFire, balanceTeams, stationaryGuns, sniperLine, timeLimitTicks (0..2147483647), scoreLimit (0..9999), and unique original enabled weapon numbers (0..13). Zero time/score disables that limit. Defaults are the native 360000-tick time limit, no score limit, bonuses enabled but frequency zero, all weapons, and alternate rules/balancing off.

Appearance field order is shirtColor, pantsColor, skinColor, hairColor, jetColor (RGB 0..0xffffff), then hairStyle (0..4), headStyle (0..2), chainStyle (0..2). Team shirts override custom shirts through native simulation policy. `appearance` carries that same 23-byte structure; `team-change` carries one u8 team. The server derives the slot and mode: FFA team0, TM1..4, CTF/INF/HTF1..2, spectator5. Both controls share a worker player-change bucket (burst4, refill2/s), independent of the weapon-choice bucket; all also consume aggregate connection control tokens. Neither can write arbitrary sim commands or change match rules.

With `balanceTeams` enabled, native admission selects a least-populated playable team, voluntary switches cannot worsen imbalance, and departures/spectator transitions move genuine AI bots before humans until team counts differ by at most one. FFA is unchanged and spectators do not count. Automatic departure rebalancing extends the original admission-only enforcement; all moves still call native `ChangeTeam`, including flag drops and Survival waiting/deaths. A trusted bot replacement leave defers rebalancing until its immediate refill. Expected balance denials and rapid repeated team requests produce `notice` rather than disconnecting the player; malformed/unauthorized messages remain errors.

The native simulation owns match-end scoring, results and countdown. At roundPhase2 the server commits remaining old-map events, loads the next compatible map without removing players, and broadcasts a new `welcome` followed immediately by `state`. Tick numbers, input sequences, reliable event IDs, identity, team, loadout and appearance continue across maps; roundEpoch increments. Clients discard old replay/input history, call loadMap on both existing hosts, then load the following full state; they must not reinitialize at a transition. A late join's first welcome describes the current map/epoch, not the original URL map. Browser `connectOnline` processes bootstrap, records and timing probes synchronously, independently of asynchronous `onRound` render preparation. Generation guards discard stale asset results, with neutral local input and suspended world drawing until the latest map is ready. `BrowserOnline.round` exposes current metadata.


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

## Confirmed timeline and full-state recovery

### ticks

The public `TickRecord` union is:

```ts
type TickRecord =
  | { type: "step"; tick: number; commands: Uint8Array[]; inputs: { slot: number; input: Uint8Array }[] }
  | { type: "correct"; tick: number; slot: number; input: Uint8Array }
  | { type: "hash"; tick: number; hash: bigint };
```

`{type:"ticks", lastConsumedInputSeq, records}` contains u32 recipient-specific `lastConsumedInputSeq` at payload offset 0, then u16 record count (1–128) at offset 4, then the ordered records. The entire payload is bounded to 1 MiB. Each record starts with a u8 tag and u32 tick; fields following that prefix are:

| Tag | Record | Remaining wire fields |
| ---: | --- | --- |
| 1 | step | u8 command count (0–64); each command as u16 byte length (1–4,096) and UTF-8 JSON bytes; u32 human roster mask; u8 changed-input count (0–32); changed inputs |
| 2 | correct | u8 slot (1–32), exactly 12 validated input bytes |
| 3 | hash | u64 simulation state hash |

A changed-input entry is u8 slot then 12 validated input bytes. Entries must have strictly ascending slots and belong to that step's roster. Roster bit `slot−1` denotes a human slot, including bit 31 for slot 32. The roster allows joins and departures without synthesizing inputs. Bots never appear in human input lists.

Callers pass **every current human input** in ascending slot order for each step, with at most 32 entries. The first step in each message encodes all of them. Later steps encode only inputs different from the immediately preceding step; newly present slots always include input bytes, and absent slots are removed. Corrections and hashes do not change this compression context. Decoder output expands every step back to the full sorted human input list. A newly present slot with no changed entry is malformed. Compression never depends on another packet.

Commands preserve the exact bytes applied through `sim_command`, in order, before that step. The codec rejects invalid UTF-8, empty commands, invalid JSON, and commands over 4,096 bytes; semantic command authorization remains the application's responsibility. JSON is not parsed into the public API or reserialized. The codec preserves record order without imposing monotonic ticks: a correction refers to an earlier tick.

For one shared encoding across recipients:

```ts
const recordBytes = encodeTickRecords(records);
for (const recipient of recipients) {
  recipient.transport.send("latestState",
    encodeTicksMessage(recipient.lastConsumedInputSeq, recordBytes));
}
```

`encodeTickRecords` validates and encodes the shared batch. `encodeTicksMessage` frames its immutable output with a recipient-specific sequence without parsing or encoding each record again. This low-level framing helper checks sequence, byte/count bounds, not the record payload; pass only unchanged `encodeTickRecords` output. As with `readChannel`, complete untrusted-payload validation belongs to `decodeMessage`.

### state and resync

`{type:"state", tick, hash, lastConsumedInputSeq, bytes}` contains a raw, opaque `sim_save_state`, not an encoded delta:

| Payload offset | Type | Field |
| ---: | --- | --- |
| 0 | u32 | Tick boundary represented by the state |
| 4 | u64 | `sim_hash_state` at that boundary |
| 12 | u32 | Last consumed input sequence for this recipient |
| 16 | u32 | Save-state length N, 0–32 MiB |
| 20 | N bytes | Unmodified save-state bytes |

The codec bounds bytes without interpreting the save-state schema. The simulation host must validate and load the state, then compare its hash before replay. `{type:"resync"}` has no payload or extra fields. Join/resync sends a full state followed by the ordered record stream from its boundary. A correction older than the recipient's sync boundary requires a fresh full state, not replay against missing history.

Per SPEC §4.4, server timeline batches flush every two simulation ticks, with a hash every 30 ticks and after corrections. Confirmed and prediction instances run the original AI; bot commands and deterministic state are shared through the timeline, not bot control frames. Confirmed replay applies commands, then human inputs, then `sim_step`, retaining sparse anchors for corrections. Prediction holds remote human inputs and replays unacknowledged local inputs when confirmed history changes. Application timeline gaps, unavailable history, or hash mismatch request full resync.

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

`eventAck` contains one nonzero cumulative high-watermark u32 event ID at offset 0. Application consumers must remember handled IDs and ignore duplicate effects; socket reliability alone is not an exactly-once application policy. The client sends one ACK after each successfully handled batch, including an all-duplicate retransmission, rather than one packet per event. Failed callbacks do not acknowledge unhandled events; successful earlier effects remain deduplicated on retry. Acknowledgement/retransmit retention and deduplication are session responsibilities, not side effects of decoding. Reusing an event ID for a different event is invalid application behavior.

## Chat, timing and disconnect

| Type | Payload layout |
| --- | --- |
| chat | Offset 0 u8 channel (0 public, 1 team); offset 1 u16 text byte length N (1–1,024); offset 3 UTF-8 text |
| chat-message | Offset 0 u8 chat channel; offset 1 u8 authenticated slot (1–32); offset 2 u16 nickname byte length M (1–48); offset 4 nickname; offset 4+M u16 text byte length N; offset 6+M text |
| notice | Offset 0 u16 text byte length N (1–256); offset 2 UTF-8 text |
| ping / pong | Offset 0 u64 sender timestamp; pong echoes it unchanged |
| disconnect | Offset 0 u16 application reason code; offset 2 u16 reason byte length N (0–256); offset 4 UTF-8 reason |

Timestamp units are sender-defined monotonic microseconds. A pong is an echo, not a synchronization of two unrelated clocks. `disconnect.code` is the application's reason code, independent of WebSocket close status.

Chat is reliable presentation traffic, not a simulation event or rollback record. The worker derives sender identity from admission and teams from the current native render view. Public messages reach active human sessions; team messages reach exactly matching teams, including solo team0 and spectator team5. Clients cannot send `chat-message` or forge a sender. Text rejects controls/invisibles and must fit 1,024 UTF-8 bytes. Separate chat buckets allow a burst of four and refill one token per second before IPC and in the worker; abuse closes the offending session. Taunts and `/say`/`say_team` use this same path; text never grants server command authority.

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

Both channels share one **bounded FIFO**: controls cannot overtake a full state or tick batch, and a newer timeline packet never replaces an unsent one. The default combined backlog is bounded by MAX_PACKET_BYTES and 1,024 packets (configured through `maxReliableBytes` and `maxReliablePackets`); these limits cover both channels despite the option names. Overflow produces an explicit error and closes the connection, rather than silently losing confirmed history. Queued bytes are copied on enqueue. Adapters do not send more while WebSocket bufferedAmount is nonzero; the browser polls only while backlog exists (10 ms), and Node uses send completion callbacks with bounded polling when necessary. Close/error clears pending data and scheduling. A future WebTransport adapter must explicitly repeat unacknowledged timeline ranges; this package currently implements WSS, not datagrams.

Browsers permit application close codes rather than arbitrary protocol close codes. Fatal browser adapter codes are 4002 (protocol), 4009 (size), 4013 (backpressure), 4011 (socket failure); Node uses 1002/1009/1013/1011 respectively. Closing a failed session is explicit failure, not delivery of its queued reliable messages.

## Node 24 authoritative match server

Start the configured WSS listener from the repository root:

```sh
SOLDAT_SERVER_CONFIG=/absolute/path/server.json node packages/server/src/main.ts
```

The configuration file contains `wasmPath`, `contentRoot`, `map`, `matchSeed` (u64 decimal string), `rules` (object), `tlsKeyPath`, and `tlsCertPath`. Optional `host` and `port` default to `0.0.0.0` and `443`; `targetPlayers` defaults to **12** and accepts 1–32; `maxMatches` defaults to eight. `publicUrl` is the external HTTPS origin, required behind a reverse proxy. `regions` is an explicit list of `{id,name,url}` HTTPS origins; without it the server advertises its single Local listener. Paths are relative to the process working directory. Never commit private TLS keys. `contentRoot/index.json` supplies the validated bot-capable map catalog and spawn-evidenced mode lists, and `sim/manifest.json` supplies the admission hash. Match workers are created lazily; each independently verifies content before mounting it.

The programmatic `createGameServer` API accepts either `{ match, tls: { key, cert } }` or `{ match, httpsServer }`, never HTTP or an insecure fallback. A caller-supplied HTTPS listener remains caller-owned; closing the game service stops only its WSS connections and match worker. Internally managed HTTPS listeners are closed too. One `worker_thread` owns one real `SimHost`/WASM instance.

Missing WASM/content, an incompatible ABI, unsupported rules/seed policy, or failed sim initialization rejects match creation explicitly. The server enables `ai:true` and defaults `rules.world` to `"original"` for native flags, medikits, grenade kits and map-authored stationary guns. Explicit `"fixture"` retains the controlled legacy harness world; welcome carries this match-identity rule unchanged. `rules.botDifficulty` accepts an integer in 0–300 (sim default 100). Product matchmaking uses dynamic `targetPlayers`; standalone qualification callers may still specify fixed `botCount:0..31` when no target is configured.

With a population target, each human join removes one original bot with `leave` before admission; each departure joins an original profile in a free slot. Profiles rotate through Admiral, Billy, Blain, Boogie Man, Commando, D Dave, Danko, Dutch, John, Kruger, Poncho, Roach, Sgt. Mac, Sniper, Stevie, and Terminator, loaded from `bots/<lowercase basename>.bot`. Profile names, cosmetics and weapons remain native. FFA modes use team zero; TM balances four teams, and CTF/INF/HTF balance two, choosing original team order on ties. Without a target, fixed bots retain highest-slot reservations. Human slots are not reused until the worker confirms leave; replacement connections wait in a bounded queue during that race.

Human joins explicitly use `control:"authoritative"` and the admitted loadout. Welcome carries the effective server rules, including `ai:true`; confirmed and prediction hosts retain AI execution so bots evolve deterministically.

The worker uses monotonic integer nanoseconds and an exact 60 Hz scaled accumulator. Each wake advances at most four fixed ticks; simulation never receives variable dt. Protocol encoding, transport enqueue, and successful simulation replay are not evidence of packet delivery or acceptance under real network impairment.

Delayed-input validation and rollback execute between fixed steps. Their measured CPU work remains charged to the next tick's legacy `simEncodeMs`/`workerSimEncodeMs`, overlapping `replayMs` and the interval's all-request `messageWorkMs`. Complete worker-cycle work, actual tick-start/completion deadline lateness, worker publication delay and application queue age are reported separately; these nested work totals are not end-to-end latency. The worker borrows its pre-wake render observation only for the first synchronous step, with fresh views after subsequent mutations and map transitions. Fixed-step/catch-up/native slow-motion semantics and the wire layout remain unchanged.
`onDisconnect(slot,code,reason)` observes the listener's actual policy close before socket teardown. Qualification records it separately from the client's WebSocket close code: TCP failure can prevent the close frame from reaching the client, which then sees 1006 rather than the originating policy reason.

The server relays consumed human inputs and commands as confirmed timeline records rather than serializing state every two ticks. Full save-state bytes are reserved for join/resync. There are no baseline caches or snapshot acknowledgements. Initial and recovery state plus every following tick record must retain WSS send order; transport backlog exhaustion is an explicit connection failure.

Input IDs start at 1. Inputs admitted early are queued and consumed at their own fixed tick; arriving early never buys simulation time. SPEC §4.4 bounds target ticks at arrival to `[current,current+8]`, with adaptive jitter margin at most six ticks. Redundant input frames are processed oldest first. Admission, sequence/rate/lead checks, one-shot clearing on gaps, and explicit resync recovery remain application responsibilities, not effects of the binary codec.

View age selects **lag compensation**, not permission to move. All classes retain genuine `viewTick <= targetTick` and `viewTick <= current+2`, the eight-tick queued arrival window, sequence/rate/replay checks, and original native cooldown/ammo/animation rules:

| Input class | View/target policy | Authoritative application |
|---|---|---|
| Current movement, jets and other ordinary controls | Old genuine views allowed; target must be current or at most eight ticks ahead | Queued until its ordinary fixed tick; elapsed movement is never rewritten |
| Delayed Fire/grenade eligible for compensation | Existing trusted-RTT shot window, at most 12 simulation ticks (200 ms at 60 Hz; 600 ms at sustained 20 Hz); existing RTT/interpolation view bounds; original historical weapon and rewind budgets | Coherent original historical projectile replay; only action bits and aim inserted |
| Fire/grenade older than compensation/view bounds, or with no retained membership-safe anchor | Still validates genuine/nonfuture view and all sequence/rate/lead/control fields | **Present-time, uncompensated** native action, not silently dropped. For stale target ticks, merge only Fire/grenade and aim onto current movement; never retroactively replay stale movement/reload/switch |
| Duplicate, malformed, future view, excessive lead or sequence/rate abuse | Rejected before application | No authority/time/ammo granted |

`uncompensatedShots` counts accepted uncompensated Fire/grenade **input frames**, including held intent; it is not a projectile/ammo counter. The native sim alone decides whether an admitted frame actually fires. Historical melee and historical action-retargeting/budget bypasses remain rejected rather than being converted into compensation.

`inputBufferOccupancy` and `inputBufferLeadTicks` report per-player/per-tick queued-count and furthest-queued-lead samples. The practical lead target is 1–3 ticks; hard bounds are nine queued inputs and eight future ticks. They expose starvation or systematically excessive prediction lead instead of hiding it in an average RTT.

Reliable gameplay events use only the canonical `SIM_GAMEPLAY_EVENTS` kinds `0x1001..0x1007` (death, flag info, Thing pickup/state, respawn, team scores and match end), with exact payloads documented in [sim-abi](../../docs/formats/sim-abi.md). Presentation kinds and legacy raw network-packet events are excluded. IDs are assigned only once their timeline is committed (12 ticks after simulation), retained until cumulative acknowledgement, retransmitted every 30 ticks, and must be deduplicated by the client. Event overflow explicitly closes the session and requires reconnect/full resync; it never silently discards a kill/pickup/capture. Future/unknown acknowledgements are rejected. The server also issues ping probes and accepts only the matching pong; historical-shot allowance uses this measured RTT, never a client-declared latency.

### Historical projectile policy and trade-offs

The server keeps consumed human inputs and sparse full-state anchors for historical replay. An accepted lag-compensation rewind emits `correct` records for replaced historical inputs, followed by the hash of the resulting boundary. Consumers must replay from a retained anchor and must not treat a correction as a newly advanced tick. A recipient whose sync boundary is newer than the corrected tick receives a fresh full state instead.

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
node --test packages/server/scripts/bots.test.ts
```

Protocol unit tests cover minimum/maximum messages, shared tick encoding, human roster changes and changed-input compression, state framing, JSON/UTF-8 validation, byte/record limits, malformed/truncated packets, and structured fuzzing. Transport queue tests cover cross-channel FIFO, ownership, combined capacity limits, and storage compaction.

Server/client integration and real-network qualification require the current frozen WASM and verified content. These commands are acceptance checks, not a claim that they have passed for this revision. Current qualification status belongs in [G4](../../docs/gates/G4.md). The obsolete v3 delta probe and its idle/synthetic ratios do not measure v4 input-relay bandwidth and have been removed; SPEC §6.4 targets still require actual v4 multiplayer measurement.

## Matchmaking HTTP reference

The HTTPS origin corresponding to the game WSS endpoint serves JSON endpoints. All responses use `Cache-Control: no-store`; allowed development origins receive explicit CORS headers. POST requests require `Content-Type: application/json`, at most 1,024 body bytes for quickplay or 8,192 for lobby setup, and no unknown fields. Errors are `{error:string}` with 400 (invalid), 403 (origin), 404 (missing), 409 (full), 413/415 (body), 429 (rate), or 503 (server capacity). Successful POSTs return 201; GETs return 200.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/ping` | — | `{ok:true}`; measure actual RTT, not a configured latency |
| `GET /api/regions` | — | `[{id,name,url}]`; `url` is an HTTPS origin; only configured regions exist |
| `POST /api/quickplay` | `{nickname}` | `{matchId,wsUrl,map,mode,humans:string[],bots:number}` |
| `POST /api/lobbies` | `{mode:GameMode,map,rules?:MatchRules,mapRotation?:string[]}` | `{code,hostToken,wsUrl}` |
| `GET /api/lobbies/:code` | — | `LobbyLookup`: `LobbyState` plus canonical lobby `wsUrl`, without host token or admission ticket |

Quickplay selects the available public match with the lowest human-plus-reservation load, otherwise starts a separate worker/WASM with a rotating bot-capable stock DM map. The response roster includes pending reservations. `wsUrl` includes a random, single-use admission ticket valid for 30 seconds. Connect there using the ordinary binary `hello`; there is no new simulation admission message. Unconsumed reservations expire and cannot exhaust capacity permanently.

The eight-character lobby code uses random Crockford base32 (40 bits; alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`). Input and lookups are case-insensitive; old six-character links fail clearly. The creator keeps the random host capability private and sends it only in `lobby-join`. Share `/?lobby=CODE`, never the token. Use the canonical lobby `wsUrl` returned by create/lookup, not the browser's possibly proxied HTTP origin. Lobby state is `{code,mode,map,rules,mapRotation,targetPlayers,players:[{id,nickname,ready,host}],started,matchId?,matchWsUrl?}`. WSS personalizes `matchWsUrl` with that member's ticket; the public GET does not. `selfId` identifies the receiving member. Started lobbies update their map as rounds advance and admit late members to the current round.

## Lobby binary payload reference

Every lobby message uses reliableControl and the existing eight-byte binary header. Strings below use the codec's u16 UTF-8 byte length prefix; modes use original u8 IDs 0..6 above, booleans u8 (`0` false, `1` true), and populations u8 (`1..32`). Rules are a bounded JSON string validated by `normalizeMatchRules`. Rotations are u8 count (1..32) followed by distinct map strings (1..128 bytes); the server validates every entry against bot-capable mode metadata and requires the selected map in the list. Invalid flags, booleans, modes, bounds, truncation and trailing fields are rejected.

| Message | Ordered payload fields |
| --- | --- |
| `lobby-join` | nickname string (1..48 bytes), hostToken string (0..64; empty means guest) |
| `lobby-update` | u8 presence mask (mode=1, map=2, targetPlayers=4, rules=8, mapRotation=16; 1..31), then present fields in that order |
| `lobby-ready` | ready boolean |
| `lobby-start`, `lobby-leave` | empty |
| `lobby-kick` | guest id string (1..32 bytes) |
| `lobby-error` | reason string (1..256) |
| `lobby-state` | selfId string (1..32), code string (8), mode, map string (1..128), rules JSON string, mapRotation, targetPlayers, u8 roster length (0..32), roster entries, started boolean, then matchId string (1..64) and personalized matchWsUrl string (1..1024) only when started |
| roster entry | id string (1..32), nickname string (1..48), ready boolean, host boolean |

Only the host may update mode/map/target, start, or kick a guest. Kicking closes the guest with an explicit reason and blocks its source IP from that lobby for ten minutes. Send compatible mode/map changes together. Setup changes reset guest readiness; the host is always ready. Unchanged setup/readiness does not broadcast. Start requires all current guests ready. The server locks setup during worker creation, broadcasts the started state, and late joins receive a ticket to the same match, replacing a bot. Leaving closes that member's lobby session; closing an unstarted host session closes its lobby rather than transferring the capability to a stranger. Once started, the match survives host departure.

Lobby traffic has a 12-message burst and four messages/second refill per socket. Broadcasts coalesce to at most ten per second, encoding common state once and personalizing only member ID/ticket. API creation has an eight-request burst per source and one request/10 seconds refill; rejected POSTs consume that budget too. Default ownership quotas are two hosted lobbies, two private matches, and four outstanding quickplay reservations per source. At least 25% of match slots (rounded up, minimum one) are reserved for public quickplay. Unstarted lobbies expire after thirty minutes; matches with no humans or live reservations close after sixty seconds. Sources use direct socket addresses, with IPv6 grouped by /64. Global creation/failed-lookup limits, pending admissions, TCP/WebSocket counts and outbound buffering are bounded; see the [server configuration reference](../server/README.md#configuration-reference) for all configurable defaults. Population targets count humans plus original bots, never exceed 32, and preserve CTF team balance on replacement/refill.

