# Simulation ABI 0x00010003

Reference for TypeScript hosts of the original-mechanics simulation and isolated presentation subsystem. This ABI is distinct from the retained G0.2 particle-spike ABI. One WebAssembly instance owns one match; the host must not share an instance between matches.

## Calling convention and ownership

Exports use numeric WebAssembly arguments, a standard exported `memory`, and little-endian linear-memory buffers. Pointers and byte lengths are wasm32 numbers. Text is UTF-8 without a terminating NUL. JSON is encoded as ordinary JSON, not a Pascal record. Host-owned buffers come from `sim_alloc` and are released with `sim_free`; input/file/command/state bytes are consumed synchronously. Returned render pointers are borrowed, not freed by the host. Refresh borrowed views after simulation calls or memory growth.

`sim_version()` returns `0x00010003`. Signed i32 status results are:

| Value | Meaning |
| ---: | --- |
| 0 | OK |
| -1 | Invalid argument |
| -2 | Not initialized |
| -3 | Not found |
| -4 | Unsupported |
| -5 | Insufficient capacity |
| -6 | Malformed data |

`SimHost` preserves negative module statuses. `requireStatus` is the explicit exception-raising adapter used by fixture runners. Host-side encoding errors and incompatible module layouts throw instead of being converted into successful module statuses. Unknown WASM imports and missing required exports fail loading.

## Required exports

| Export | Arguments and result |
| --- | --- |
| `sim_version()` | u32 module/presentation ABI version (independent of save-state version) |
| `sim_alloc(n)` | Byte count → allocated pointer |
| `sim_free(ptr)` | Release host allocation |
| `sim_vfs_put(path,pathLen,data,dataLen)` | Raw virtual file bytes → status |
| `sim_init(rules,len,seedLow,seedHigh,flags)` | Rules JSON → status |
| `sim_load_map(name,len)` | Map basename UTF-8 → status |
| `sim_command(tick,ptr,len)` | Reliable command JSON → status |
| `sim_set_input(slot,tick,ptr)` | One 12-byte input → status |
| `sim_step(flags)` | Advance exactly one 60-Hz tick → new tick i32, or negative status |
| `sim_events(out,capacity)` | Drain events → byte count, or negative status |
| `sim_render_view()` | Borrowed render pointer; zero before init/map load |
| `sim_save_state(out,capacity)` | Written/required byte count, or negative status; `(0,0)` queries size |
| `sim_load_state(ptr,len)` | Restore explicit serialized state → status |
| `sim_hash_state()` | i64 bit pattern, normalized by JS with `BigInt.asUintN(64, value)`; zero before init/map load |
| `fx_step()` | Advance cosmetics once for the current non-replay gameplay tick; repeated calls are idempotent |
| `fx_render_view()` | Borrowed cosmetic-buffer pointer, or negative status before init/map load |
| `fx_set_view(x,y,width,height,slot)` | Set finite world-space camera centre, positive logical viewport dimensions and local sprite slot (0 = no local player), without changing gameplay |

`_initialize`, when exported by the Pascal reactor, is called once before `sim_version`. The shared deterministic WASI imports supply empty argv/environment, zero clock/entropy, captured stdout/stderr, and explicit BADF/NOTCAPABLE/NOSYS errors for unavailable services. Simulation files enter only through `sim_vfs_put`; WASI does not pretend to read gameplay content.

`sim_step` accepts `REPLAY=1`, which suppresses presentation events, or zero; other bits return `-4`. Gameplay still advances once. `sim_events(0,0)` reports queued bytes without draining. An undersized event buffer also reports required bytes without draining; sufficient capacity copies and drains all queued records. `SimHost.events()` performs this size query automatically. Each event is five little-endian u32 fields (`kind`, `tick`, `source`, `target`, `payloadBytes`, 20 bytes total), followed by opaque payload bytes. Bit 31 of kind denotes presentation-only events; console/log/idle kinds are `0x80000001/2/3`. Queue capacity is 1,048,576 bytes; overflow is a capacity failure, not silently dropped events.

## Initialization, virtual content, commands

The fidelity configuration uses original FPC RNG, AI disabled: `flags=0`, `seedHigh=0`, and `seedLow` carrying the original 32-bit seed. `{}` selects normal DM defaults. Supported rules are `mode:"dm"|"ctf"`, `rng:"original"|"keyed"`, `ai:false`, `realistic:false`, `survival:false`, `bonusFrequency:0`, `tickRate:60`, and diagnostic `traceCombat:boolean`. Flag bit 1 (`2`) also selects keyed RNG; other init flag bits are rejected. Keyed mode accepts the full 64-bit low/high match seed. Original mode rejects nonzero seedHigh. Unsupported keys/values return `-4`.

Mount raw bytes before initialization, then initialize, load a map and join players. Virtual IDs are lowercase slash-separated paths (`maps/arena.pms`, `anims/…`, `objects/…`, `configs/weapons.ini`, `mod.ini`). The content loader reads `sim/manifest.json` schema 1, verifies every raw file's SHA-256 and byte count, and verifies the combined identity: SHA-256 of sorted `canonical-id<TAB>file-sha256<LF>` records. It does not send parsed render JSON to the sim. The manifest's `path` is relative to the content output root.

Command JSON has `kind: "join" | "leave" | "team" | "spawn"`, one-based `slot`, and applicable optional `team`, `spawn`, `x`, `y`. Setup supports `health`, `heldFlag`, `weapon`, `secondaryWeapon` (original weapon numbers), `ammo` (default original magazine), `grenades`, and `vest`. `spawn` is the original PMS spawn-array index. Commands apply at exactly the current tick, including tick zero. `thing` commands create original Things from `{style,owner,x,y,ammo}`. Diagnostic-only `bullet` and `fixture-sprite` injections require `traceCombat:true`; their canonical schemas are the `SimCommand` union in `packages/sim-host/src/sim.ts`. They are harness inputs, not admissible untrusted network messages.

`control:"authoritative"` explicitly selects the original server-owned firing/switch/drop/grenade path with injected human inputs and AI disabled. Default `"human"` exists for pinned legacy oracle fixtures that model the original networked server's HUMAN role; product input-only players must choose authoritative. Both the sim and independent oracle harness apply the original HUMAN semi-auto release/burst guard at the input boundary. `weapon-choice` commands `{slot,weapon,secondaryWeapon?}` set serialized next-respawn choices; the original respawn runs before the shim reapplies both chosen guns. See the complete control-method audit in the role-divergence ledger.

An input for fixture step 1 is submitted with current simulation tick 0; stepping returns 1. The fixture runner resets controls every step, applies matching segments in source order, and uses the last overlapping segment as a whole-record replacement.

## Input record: 12 bytes

| Byte offset | Type | Meaning |
| ---: | --- | --- |
| 0 | u16 | Control bits |
| 2 | i16 | MouseAimX |
| 4 | i16 | MouseAimY |
| 6 | i16 | MouseDist |
| 8 | u16 | Press-order bits |
| 10 | u16 | Reserved, zero |

Control bits 0–11, in order: `Left`, `Right`, `Up`, `Down`, `Fire`, `Jetpack`, `ThrowNade`, `ChangeWeapon`, `ThrowWeapon`, `Reload`, `Prone`, `FlagThrow`. Bits 12–15 are zero. Aim values are signed integer world coordinates/distance, not browser pixels. Press-order bits are left-first=1, right-first=2, up-first=4, down-first=8; the other bits are zero. Corpus segments may provide `pressOrder` outside `control`; this takes precedence over `control.pressOrder`, then zero.

Sim rejects both left-first and right-first set together, or both up-first and down-first. Zero order denotes already-resolved server controls. The host encodes the requested order and preserves the module's validation status.

## Render view

Constants live in `packages/sim-host/src/render.ts`; consumers should import `RENDER_LAYOUT`, `SPRITE_FLAGS`, `RenderView` and `RenderSprite`, rather than duplicating offsets.

The 32-byte header consists of eight u32 values:

| Offset | Field |
| ---: | --- |
| 0 | ABI/layout version, `0x00010003` |
| 4 | Current tick |
| 8 | Active sprite count |
| 12 | Fixed slot count, 32 |
| 16 | Sprite stride, 636 |
| 20 | Bullets offset, relative to render-view start |
| 24 | Things offset, relative to render-view start |
| 28 | Total byte length |

Thirty-two fixed sprite records follow at `32 + index * 636`. Host index 0 corresponds to original slot 1; the record's `slot` is authoritative for active records. Inactive records are zero-filled slots, not a compacted active array.

| Record offset | Type | Field |
| ---: | --- | --- |
| 0, 4 | u32 | slot, flags |
| 8 | i32 | direction |
| 12, 16 | i32 | legs animation ID/frame |
| 20, 24 | i32 | body animation ID/frame |
| 28, 32 | i32 | aim X/Y |
| 36 | i32 | weapon |
| 40, 44 | f32 | sprite particle X/Y |
| 48 | f32 | health |
| 52 | i32 | jet fuel |
| 56 | 48 × f32 | Previous skeleton: 24 `(x,y)` points in original one-based point order |
| 248 | 48 × f32 | Current skeleton, same order |
| 440 | u32 | Original player team |
| 444 | u32 | Inventory: ammo bits 0–7, grenade ammo bits 8–15, reload ticks bits 16–31 |
| 448, 452 | u32 | Fired counter, primary clip texture ID |
| 456, 460 | u32 | Primary clip-in / clip-out reload tick thresholds |
| 464, 468 | u32 | Original secondary / tertiary weapon numbers |
| 472 | f32 | Vest |
| 476 | u32 | Control.Jetpack boolean (0/1), not inferred from fuel |
| 480, 484, 488 | u32 | Alpha, WearHelmet, HasCigar |
| 492, 496, 500 | u32 | Player Chain, HeadCap (original graphic ID), HairStyle |
| 504, 508, 512, 516 | u32 | Original shirt, pants, skin, hair colors |
| 520 | i32 | CeaseFireCounter |
| 524, 528, 532 | u32 | Visible, Style, player DemoPlayer boolean |
| 536, 540, 544, 548 | u32 | Primary magazine capacity, ReloadTime, FireInterval, FireIntervalCount |
| 552, 556 | i32 | Player kills, deaths |
| 560, 564, 568 | u32 | RealPing (milliseconds), player Flags (captures), ControlMethod |
| 572 | u32 | Player-name UTF-8 byte length (0–48) |
| 576 | 48 bytes | UTF-8 name without terminator; unused bytes zero |
| 624 | u32 | Original player JetColor |
| 628, 632 | i32 | Primary / secondary WeaponNumToIndex result |

Names longer than the network's 48-byte admission limit are truncated at a UTF-8 codepoint boundary for presentation only. Original player-name/gameplay state is unchanged. `RenderSprite.playerName` decodes exactly the published bytes. Weapon capacity (`weaponAmmo`) is distinct from current magazine contents (`ammo`); the reload/fire interval fields are the original counters and configuration, not host estimates.

Flag bits: active=1, dead=2, grounded=4, permanently grounded=8, crouching=16, prone=32. Borrowed skeleton `Float32Array`s must never be mutated. Render state is presentation data, not a rollback or oracle-state substitute.

The original server leaves a newly created skeleton in local template coordinates until its first pose evaluation. Publication recognizes only an exact match of the full 24-point immutable template and translates that render-only pose to the authoritative sprite position. Both initial current and previous render poses are world-space; gameplay skeletons remain untouched.

Bullet and Thing sections have fixed-capacity storage. Bullet offset is **20,384**; Thing offset is **44,776**; the globals trailer starts at **73,944**; total render bytes are **73,988**. Consumers use the header's actual section offsets and exported `RENDER_LAYOUT` constants. Each section starts with u32 active count and u32 stride, then capacity for 254 bullets or 90 Things. Active records are compacted in ascending original slot order; unused capacity is zero. `RenderView.bullet(index)` and `.thing(index)` use compact zero-based indices and expose each record's original `slot`. `RENDER_LAYOUT.bullet` and `.thing` export offsets for allocation-free direct reads in hot render loops.

Both records begin with u32 slot/style at 0/4, f32 current X/Y at 8/12, f32 original particle OldPos X/Y at 16/20 and u32 owner at 24.

Bullet stride is **96**, preserving the ABI 2 prefix:

| Record offset | Type | Field |
| ---: | --- | --- |
| 28 | u32 | Owner weapon |
| 32, 36 | f32 | Current velocity X/Y |
| 40, 44 | i32, u32 | Timeout, image style |
| 48, 52 | f32 | Previous velocity X/Y |
| 56, 60 | f32 | HitMultiply, HitMultiplyPrev |
| 64 | i32 | Previous timeout |
| 68, 72 | f32 | Initial X/Y |
| 76 | u32 | HitBody |
| 80, 84 | i32 | PingAdd, PingAddStart storage |
| 88, 92 | u32 | Active boolean, presentation flags |

`BULLET_PRESENTATION_FLAGS.pingUnavailable=1`: PingAdd/PingAddStart are client-network extrapolation fields absent from the original SERVER simulation. Their zero storage is explicitly unavailable, not sampled client latency. Hosts rendering this authoritative view use the ordinary non-PingAdd branch. No gameplay extrapolation or hit history is invented. Current/previous velocity, timeout and hit multiplier are source state, allowing the original renderer's interpolation without overwriting gameplay.

Thing stride is **324**: ammo u32 at 28, holding sprite u32 at 32, flags u32 at 36 (static=1, in-base=2), point count u32 at 40, reserved zero at 44, then 16 skeleton records of four f32 `(x,y,oldX,oldY)` starting at 48. Consume only `pointCount` records. Thing position in the common prefix refers to skeleton point 1. OldPos values are source particle history, not invented render-frame history. Appended fields: timeout i32 at 304, interest i32 at 308, color u32 at 312, presentation flags u32 at 316 and creationFacing u32 at 320. `THING_PRESENTATION_FLAGS.colorAvailable=1` identifies a parachute tint projected from its valid owner's original shirt color, matching `NetworkClientThing` snapshot handling; otherwise color storage is zero/unavailable. CreationFacing is the exact original CreateThing texture variant `k` (right/default-owner-255=0, left=1), captured once and serialized even for inactive slots; never derive it from the owner's later direction. Hosts map original Tex1/Tex2 graphics from style, this variant, and the original texture table. Flag/kit textures also use native style/game mode.

The **44-byte globals trailer**, exposed as `RenderView.globals`, contains six i32 original `TeamScore[0..5]` values at 0–20, then i32 `startHealth` at 24, `mapStartJet` at 28, `gameMode` at 32, `killLimit` at 36 and `ceaseFireTime` at 40. The team scores are in native team order, not sorted. All presentation fields are projections; calling the render view does not mutate gameplay, state encoding, hashes or event semantics.

`tick`, `spriteCount`, `bulletCount`, `thingCount` and globals scalar properties are live getters into the latest published buffer; team scores are borrowed. A retained view still requires reconstruction after memory growth, and publication itself requires `sim_render_view()`. Reading an existing view does not implicitly invoke the simulation.

## Gameplay notifications

ABI 3 publishes stable semantic events in addition to retained legacy packet events. `SIM_GAMEPLAY_EVENTS` and `SIM_GAMEPLAY_PAYLOAD` in `packages/sim-host/src/gameplay-events.ts` are the shared kind and payload-offset contract. These kinds have bit 31 **clear**: both ordinary and `REPLAY=1` steps emit them, permitting authoritative rollback to recompute confirmations. Consumers deduplicate/replace replayed confirmations using the authoritative event envelope, not health changes or rendered effects. Events never mutate simulation state, consume RNG or enter save-state bytes.

All payload entries below are consecutive little-endian **i32** words, inside the standard 20-byte event envelope. Source/target are original slots, not compact render indices. Stable kinds start at `0x1001` to avoid the original network packet-ID namespace.

| Kind | Source / target | Payload in order | Original source send |
| --- | --- | --- | --- |
| `0x1001` DEATH | Killer / victim | weapon number, native KillBullet feed code, bullet style, Where body part, killer kills, killer team, victim team | `TSprite.Die` → `NetworkServerSprite.ServerSpriteDeath`; native KillBullet overrides preserved |
| `0x1002` FLAG_INFO | Who / 0 | Original flag-info style (RETURNRED/RETURNBLUE/CAPTURERED/CAPTUREBLUE) | `TThing.Update` → `NetworkServerGame.ServerFlagInfo` |
| `0x1003` THING_TAKEN | Who / Thing slot | Thing style, ammo | `TThing.CheckSpriteCollision` → `NetworkServerThing.ServerThingTaken`, before removal; covers flag grab, kits and weapons |
| `0x1004` THING_STATE | Holding sprite / Thing slot | Thing style, owner, holding sprite, InBase (0/1), timeout | `CreateThing`, `TThing.Respawn`, `TSprite.FlagThrow` → `ServerThingMustSnapshot`; source-state notification covers dropped/returned flags without inventing a reason |
| `0x1005` RESPAWN | Sprite / sprite | Team, current weapon number, secondary weapon number | `TSprite.Update` after `Respawn` → `ServerSpriteSnapshotMajorSingle(NETW)`; not periodic snapshots |
| `0x1006` TEAM_SCORES | 0 / 0 | Six TeamScore values, indices 0–5 | Scoreboard values at the genuine death and flag-info sends; a notification snapshot, not a synthetic score delta |
| `0x1007` MATCH_END | 0 / 0 | Map-change counter, game mode, six TeamScore values | `Server.PrepareMapChange` → broadcast `NetworkServerGame.ServerMapChange(ALL_PLAYERS)`; targeted reconnect sends do not end a match |

An environmental death has weapon=250 and bulletStyle=0, matching the original no-projectile path; the killer/victim header remains native attribution. Unsupported rules/map transitions do not fabricate an end-of-match event. Thing state messages can repeat (creation/respawn sends do so upstream); their existence does not by itself prove a new pickup or score. Respawn weapon values are those at the original send site, before any ABI input-owner loadout restoration. These facts remain separate from gameplay state and render projections.

## Presentation events and FX view

`0x80000004` is the original-sound event. Its **32-byte** packed payload is i32 sample ID at 0, i32 channel at 4 (`-1` = automatic), i32 operation at 8 (0 = play if channel not already playing, 1 = stop, 2 = set volume, 3 = pause, 4 = resume), u32 flags at 12 (loop=1, nonpositional=2), f32 emitter X/Y at 16/20, f32 volume at 24 (default 1), f32 maximum attenuation distance at 28 (750 world units). Sample IDs are the pinned `Constants.pas` SFX IDs; hosts resolve these through the original `Sound.pas` sample-name table. Loops are rocket jets, chainsaw-running and flamer samples. Original reserved channels are reload `slot-1`, jets `32+slot-1`, weapon startup `64+slot-1`, weapon ending `96+slot-1`, and weather 127. Automatic channels must not suppress unrelated simultaneous sounds. Distance/panning/listener settings stay in the host. `0x80000005` carries UTF-8 large-message text, with source=duration and target=color. Presentation events are suppressed during replay.

Call `fx_set_view` before the first cosmetic step to anchor weather to the real camera. Call `fx_step` after each ordinary `sim_step`, never once per rendered frame. Replay suppresses spark requests and cosmetic RNG calls; `fx_step` after a replay step leaves cosmetics untouched. Spark state, queues, channels and the independent xorshift32 FX RNG are excluded from save/load/hash. Loading gameplay does not rewind already-presented effects. Rendering uses interpolation and never writes back.

`packages/sim-host/src/fx.ts` exports `FX_LAYOUT`, `FxView`, `FxSpark` and `readFxView`; `SimHost` exposes `fxStep`, `fxRenderView` and `fxSetView`. FX header is eight u32 words: ABI version, gameplay tick, active count, capacity (558), stride (64), total bytes (35,744), map weather, reserved zero. Records are compacted by original spark slot:

The FX header version follows module/presentation ABI `0x00010003`; its byte layout is otherwise unchanged from ABI 2.

| Offset | Type | Input |
| ---: | --- | --- |
| 0,4,8,12 | u32 | Slot, original style, owner, life |
| 16,20,24,28 | f32 | Current X/Y, particle OldPos X/Y |
| 32 | u32 | Previous life |
| 36,40,44 | f32 | Current-life main-layer scale X/Y, rotation in radians |
| 48,52 | u32 | RGB tint, alpha 0–255 |
| 56,60 | f32 | Main-layer draw offset X/Y |

Life/lifePrev permit the renderer to evaluate original `TSpark.Render` formulas at interpolated life, including explosion/smoke frame selection and multiple layers. If evaluating these formulas, do not apply the already-computed current-life scale/offset a second time. Weather styles are rain=38, sand=39, snow=53, alpha 105, eight spawns every 17 ticks, with original velocities/lifetimes `(0,12)/60`, `(10,7)/80`, `(1,2)/80`. Camera-dependent culling and screen wobble are host presentation concerns, not gameplay.

## Save-state identity and diagnostic traces

Save-state bytes have their own explicit field-wise serialization. They are not native record dumps, pointer graphs, JSON, or the render view. Header prefix:

| Offset | Type | Meaning |
| ---: | --- | --- |
| 0 | u32 | Magic bytes `SST1` |
| 4 | u32 | Version `0x00010003` |
| 8 | u32 | Total byte length |
| 12 | u32 | Map-name byte length N |
| 16 | N bytes | Original map-name bytes |
| 16+N | u32 | Map identity |
| 20+N | u32 | Loaded weapons checksum |
| 24+N | u64 | Cached simulation VFS identity (`SimVFSHash`) |
| 32+N | u32 | Original-policy `SimRandom.RandSeed` bit pattern |
| 36+N | u32 | `SimRandom.OldRandSeed` reseed sentinel |
| 40+N | 4 × u32 | `SimRandom.RandomState` xoshiro128** words, indices 0–3 |

The normative field-by-field schema is [`SimState.pas`](../../sim/opensoldat/sim/SimState.pas): `TCodec.State` defines top-level order and the named `Particle`, `Animation`, `Gun`, `Control`, `Background`, `Brain`, `Player`, `Soldier`, `Projectile`, `Polygon` and `ObjectThing` methods define nested record order. This is executable serialization, not a native-record memory layout. Consumers must not derive offsets from Pascal `SizeOf` or the render view.

Primitive widths are fixed: Byte/ShortInt/Boolean=1 byte, Word/SmallInt=2, LongWord/LongInt/Single=4, identity QWord=8, all little-endian with no padding. Boolean values are exactly 0 or 1. Single is its IEEE-754 binary32 bit pattern; nonfinite values are rejected. AnsiString/ShortString use a u32 byte length and exact bytes (maximum 65,535/255), without a terminator. Vectors are consecutive f32 X/Y. Variable Thing-collision lists have a u32 count at most 90, then u8 Thing slot and i32 cooldown-end per entry. Sprite-collision sets serialize 32 consecutive bool bytes, not compiler-dependent Pascal set storage.

The pinned original FPC RNG is xoshiro128**. Restoring `RandSeed` alone is insufficient. `SimRandom` implements public-domain SplitMix64/xoshiro128** and the pinned FPC mappings; all six original words serialize. An all-zero four-word generator is malformed. After byte `56+N`, ABI 2 adds policy bool, 64-bit match seed, mode byte, 64-bit miscellaneous counter, 64-bit separate AI seed, 33 `(shotCounter,eventCounter)` pairs of u32, then 32 `(chosenPrimary,chosenSecondary)` pairs of u8. Policy, seed and mode are match identity and must agree on load. Keyed spread uses a per-owner shot scope; projectile/Thing events use per-owner event scopes. Each scope seeds SplitMix64 from match seed, entity, domain and counter; nested scopes are restored on exit. Cosmetic randomness never consumes these streams. See the role-divergence ledger for the deliberate keyed-policy divergence.

After the prefix, top-level order is:

1. Remaining tick/render-rate/game globals, match/round/respawn/vote counters and text, team arrays, weapon-activity array, and dummy-player fields, exactly as `TCodec.State` lists them.
2. `SpriteParts`, `BulletParts`, then template skeleton particle systems in declared order (gostek, box, flag, parachute, stationary gun, eleven rifle skeletons).
3. The 44 shared animation templates in their explicit `State` order, then interleaved `Guns[J]` and `DefaultGuns[J]` for all weapon slots.
4. Every one of 32 sprite slots, active or inactive: full `Soldier` record, press-history booleans, old-position array, weapon selections, scoreboard/vote/input-silence/flood/ping/combat-warning counters and previous render pose. `Soldier` includes full skeleton, legs/body animations, three guns, original controls, bot/background data, next-push/bullet-check arrays, and an ownership bool followed by player fields only for independently owned players.
5. All 254 bullet slots, including previous velocity/hit/initial vectors and dynamic collision histories.
6. All 90 Thing slots, including complete particle systems/background state, four collision counters and two polygons, followed by the ABI 3 one-byte cosmetic CreationFacing value (validated 0–1) for every active or inactive slot.
7. Outgoing sprite/bullet snapshot and per-sprite-pair movement/aim/weapon/helmet delta histories, including inactive-slot entries.

Each particle system serializes timestep/gravity/damping and bounded part/constraint counts, followed by two lossless sparse lists. Each list begins with u32 entry count (at most 560), and strictly ascending u16 one-based slot indices. Particle entries contain bool active, four f32 vectors (position, old position, velocity, force), and f32 inverse mass. Constraint entries contain bool active, i32 endpoints and f32 rest length. Slots absent from a list are exactly bitwise zero; apply clears each destination array before restoring its list. Inactive but nonzero stale fields and signed zero are retained. No native padding participates. Each animation serializes ID/frame count/speed/count/current frame/loop and a u64 immutable-frame identity (zero for an uninitialized zero-frame animation). Its POA frame coordinates are rebound from the 44 content-bound templates on load, not repeatedly serialized. Loading rehashes those templates and checks their IDs/counts against initialization bindings; mutated or mismatched frame content is rejected. The source write audit found frame-coordinate writes only in `Anims.LoadFromFile`, not runtime mechanics.

The maximum accepted state size is 32 MiB. Loading requires the same initialized map name, map ID, loaded weapons checksum and VFS identity. A complete read-only schema traversal checks version/magic, byte length, identity, primitive/range/reference bounds and exact end-of-buffer before a second traversal applies state. Malformed, truncated, trailing-byte or identity-mismatched blobs return `-6` without mutation. Insufficient save/trace capacity returns `-5`; null output with nonzero capacity returns `-1`. Loading clears pending events and restores their current tick; event queues are not rollback gameplay state.

Gameplay hashing is FNV-1a-64 over canonical encoded bytes, excluding previous-render-pose coordinates and representing the snapshot byte-length word as zero. Save encodes and validates once into reusable grow-only storage and hashes that contiguous buffer. Save/hash calls reuse the encoding until the next mutating ABI call; every mutation entry invalidates before any potentially partial change, and load invalidates internally. This cache is not dirty-field tracking and drops no state. No native padding participates. The VFS identity is an insertion-order-independent aggregate, not a replacement for the manifest SHA-256. Hosts keep state blobs opaque and version-bound.

ABI 3 keeps all added render fields presentation-only except the explicitly authorized **CreationFacing** byte per Thing. It preserves creation-time dropped-weapon texture selection through rollback and cross-instance snapshots without consulting the owner's later direction. `SST1` state version is therefore **0x00010003**; the version word and 90 appended field bytes intentionally change state bytes and hashes relative to ABI 2. The SIM-only capture hook copies the existing CreateThing `k` without changing original arithmetic, control flow, RNG or mechanics; see ledger C10. Qualification must use the final ABI 3 artifact, not compare its hashes to a frozen ABI 2 receipt. Render/FX buffers remain distinct from loadable states.

The optional diagnostic export `sim_trace_state(out,capacity)` returns a UTF-8 current-state JSON record in the existing [oracle trace format](fixtures-and-traces.md), with a `(0,0)` length query. It is not required for ordinary production loading. `readTraceState` fails explicitly if a trace-enabled build is unavailable. It captures tick boundaries; it does not fabricate intermediate upstream stage snapshots. Native/oracle traces retain their original stages. Use the existing streaming comparator's `--ticks-only` mode for target equivalence, not render-view comparisons.

## Running fixtures and collecting receipts

These are integration commands, not claims of completed qualification. Run them after the real sim and movement corpus are built, from the repository root with Node 24 and Bun available:

```sh
node packages/sim-host/src/fixture-node.ts \
  --wasm build-out/sim/sim.wasm --content dist/content \
  --corpus tests/fixtures/movement/corpus.json \
  --out build-out/sim/receipts/node --trace

bun packages/sim-host/src/fixture-serve.ts \
  --wasm build-out/sim/sim.wasm --content dist/content \
  --corpus tests/fixtures/movement/corpus.json \
  --baseline build-out/sim/receipts/node \
  --out build-out/sim/receipts/browser
```

The focused ABI 3 decode check uses real combat fixtures and supports a scratch artifact without replacing the production WASM:

```sh
SIM_OUT="$PWD/build-out/sim-abi3" bash sim/build/build-sim.sh all
node sim/build/check-render.mjs build-out/sim-abi3/sim.wasm \
  build-out/sim-abi3/render-check.json
```

It checks the appended TypeScript decoder fields against published bytes on combat fixtures, render-call hash invariance, both creation-facing variants after cross-instance state load, live header getters, and canonical gameplay-event equivalence between live and replayed steps. Full movement/combat qualification remains separate.

The server listens on `http://127.0.0.1:4174/` (`PORT` overrides). Open that URL in actual Chrome, Firefox and Safari. Keep the page alive until it reports `complete`; mere successful navigation is not a result. Each browser reports its actual user agent and posts each full receipt. `/results` returns Node `baselines` and browser `results`, including accepted comparisons and failures. Hash/event mismatches include machine-readable earliest `tick`, `field`, `expected` and `actual` values. Accepted receipts are stored with a serial prefix, preserving independent browser runs. The server requires Node baseline receipts and rejects any identity, hash, event or checkpoint mismatch; it does not substitute a browser engine or declare success from a static page.

Both lanes instantiate fresh copies of the same WASM and mount verified raw content. The baseline is uninterrupted. The restored lane saves and reloads every 50 ticks (including a final tick divisible by 50), immediately checks hash preservation and compares every continuation tick against baseline. Receipts contain tick zero through the final tick, both per-tick `{tick,hash,events}` arrays (events are lowercase byte hex), checkpoint byte lengths/SHA-256 and before/after hashes, exact fixture-byte and WASM SHA-256, map/content identities, seed, runtime and ABI version. Events drain before each checkpoint. `identical` must be true; a mismatch throws instead of producing a pass receipt.

Synthetic fixtures may name a repository-relative `mapPath`. The runner verifies `mapSha256`, overlays the raw bytes at `maps/<lowercase-name>.pms`, and recomputes the combined content-set identity with that replacement/addition. The fixture's declared `contentSetHash` must equal this effective identity. The browser server serves only explicitly declared fixture assets, not arbitrary repository files.

The Node runner also writes `<name>.hashes.jsonl`, one baseline `{tick,hash,events}` object per line, directly comparable with the native runner's `SIM_RECEIPT_OUT` sidecar. `--trace` writes baseline tick-boundary diagnostic JSONL beside Node receipts, starting with the original version-1 oracle header. Header upstream/compiler values follow the repository's pinned source/FPC 3.3.1 build contract; runtime `jetCapacity` comes from the actual tick-zero diagnostic, not a fixture assumption. For each corresponding native trace and Node trace:

```sh
node sim/build/compare-traces.mjs --target --ticks-only \
  build-out/sim/native/flat-left.trace.jsonl \
  build-out/sim/receipts/node/flat-left.trace.jsonl
```

Use the actual native output path from the integrated corpus run. The comparator owns T2 numeric thresholds and exact discrete-field comparison; T3 receipts require identical hashes, with no numeric tolerance. G0.2 scripts `src/node.ts`, `src/browser.ts` and `src/serve.ts` remain the separate particle-spike entry points.
