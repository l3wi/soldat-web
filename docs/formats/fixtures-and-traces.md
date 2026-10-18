# Simulation fixtures and oracle traces

Reference for developers implementing the Phase 1 native simulation emitter and comparing it with the original server. Version 1 describes server-role mechanics, not classic-client numerical equivalence. The gate evidence is in [G0.3](../gates/G0.3.md).

## Fixture JSON, version 1

`tests/fixtures/arena-run-jump-jet.fixture.json` is the first concrete fixture.

| Field | Meaning |
|---|---|
| `version` | Integer `1`. |
| `map` | Exact base map basename, without `.pms`; `Arena` is a DM map. |
| `contentSetHash` | Declared combined simulation-content hash from `dist/content/sim/manifest.json`. The first fixture uses `855f61f831c5c74efbf267483d21c509baddc760d4dfbcfce2b77eba8aa0c109`. The harness echoes this trusted-fixture identity, rather than recomputing the importer hash. The gate additionally records exact upstream/base pins and archive/map hashes. |
| `seed` | FPC `RandSeed` before initialization, animation/map loading and sprite creation. Sprite creation itself consumes RNG; initial trace state records the resulting seed. |
| `ticks` | Positive number of fixed simulation steps. |
| `players` | Ordered array; index + 1 is the sprite slot. Each player has integer `team` and `spawnpoint`. Optional `x`/`y` override initial coordinates; `health` and `heldFlag` select environmental-damage and flag-filter initial state. |
| `inputs` | Run-length encoded input segments; omitted ticks are neutral input. |
| `mapSha256` | SHA-256 of the exact raw PMS bytes, including a synthetic test map when applicable. |
| `mapPath` | Optional repository-relative raw synthetic PMS path, mounted over `maps/<map>.pms`; synthetic maps are test-only. |
| `mapDirectory` | Optional native-oracle map-directory override for test assets; fixture-relative mounting details are recorded by the corpus regeneration tool. |
| `traceStages` | Optional `all` (default) or `tick` diagnostic verbosity. G1 T1 qualification requires `all`, including long runs. |

`spawnpoint` is the **one-based original PMS spawn array index**, not the Nth spawn of the chosen team. By default the harness uses that active spawn's exact X/Y coordinates without `RandomizeStart` jitter; explicit `x`/`y` overrides let stock-map fixtures reach a named polygon without modifying the map. Player slots are human-controlled, never bots. The first fixture uses Arena spawnpoint 1 at **(-409, -75)**, team 0. The optional `heldFlag` setup creates the fixture flag state through the same harness/native setup; it is not a client-authoritative gameplay input.

An input segment has `player` (one-based slot), `start` (one-based inclusive tick), `ticks` (duration), and `control`. Its interval is `[start, start + ticks)`. All controls reset each tick before segments are applied. Later segments win if segments overlap for the same player; they replace the whole control rather than merging fields.

`control` mirrors the original `TControl`:

- Booleans (omitted = false): `Left`, `Right`, `Up`, `Down`, `Fire`, `Jetpack`, `ThrowNade`, `ChangeWeapon`, `ThrowWeapon`, `Reload`, `Prone`, `FlagThrow`.
- Signed 16-bit integer world-space aim fields (omitted = 0): `MouseAimX`, `MouseAimY`, `MouseDist`.

Fixtures are trusted repository inputs. Movement fixtures extend version 1 with an optional segment-level `pressOrder` (also accepted within `control` by the TypeScript adapter). Zero means raw, already-resolved server `TControl`, preserving the original fixture. Nonzero opts into original client left/right conflict resolution at the injection boundary: left-first=1, right-first=2, up-first=4, down-first=8. Both horizontal-first bits or both vertical-first bits together are invalid. The resolver retains prior direction/jumping state per player; neutral ticks update history too. Last matching segment still replaces the whole input before one resolution per player per tick. These fields do not execute SDL or modify the server movement branches. The ABI's exact binary input layout is in [sim-abi](sim-abi.md).

The first fixture settles for 60 ticks, runs right for 120, holds jump for 20, holds jets for 230 (longer than the 226-unit capacity), then releases all movement for 170. Total: 600 steps.

## Trace JSONL, version 1

UTF-8, one JSON object per line, LF endings. No timestamps, process IDs, path names or wall-clock values enter the trace. Object and entity ordering are deterministic. Entity arrays are ascending original slot order; omitted entities are inactive.

The first row has `type: "header"`, `version`, upstream commit, compiler version, map, fixture `contentSetHash`, initial `seed`, `ticks`, and runtime `jetCapacity`.

All subsequent rows have `type: "state"`, `tick`, `stage`, `entity`, `randSeed`, `jetCapacity`, and arrays `sprites`, `bullets`, `things`. Tick zero has one `initial` row after entity creation. Each tick is advanced in the same order as the normal `AppOnIdle`: increment `Ticks`, `ServerTickCounter`, `MainTickCounter`; inject controls; call `UpdateFrame` once. There is no wall-clock accumulator or `AppOnIdle` networking/script work.

Stage order:

1. `sprite-parts`: after all active non-spectator main particles integrate.
2. `sprite`, `entity = slot`: immediately after each active sprite update.
3. `bullets`: after all active bullet updates.
4. `bullet-parts`: after bullet particle integration.
5. `things`: after all active Thing updates.
6. `tick`: after the entire `UpdateFrame`, including ordinary post-mechanics rules.

Each stage dumps the complete active state, not just the entity that changed. `entity` is zero except for `sprite`. The hooks are in `ServerLoop`, not the mechanics units.

### Float representation

Every Single is `{ "bits": "xxxxxxxx", "decimal": number }`. `bits` is the lowercase, eight-digit hexadecimal **IEEE-754 binary32 bit pattern**, obtained by a byte-preserving Pascal `Move` to `LongWord`. It is endian-independent as a numeric hexadecimal value. It is authoritative for comparison, including signed zero and NaN payloads. `decimal` is the same Single promoted to Double for JSON display; non-finite values use strings `NaN`, `Infinity`, `-Infinity` to retain valid JSON. A vector is `[x, y]`, each in that representation.

### Sprite fields

- `id`, `dead`.
- `particle`: `pos`, `oldpos`, `velocity`, `forces` from the sprite's `SpriteParts` slot.
- `skeleton`: exactly 24 points in one-based source order, represented as an array at indices 0–23; each point contains `pos` and `oldpos`.
- `onGround`, `onGroundForLaw`, `onGroundPermanent`, `onGroundLastFrame`.
- `position`: original posture/stance enum (`POS_STAND`, `POS_CROUCH`, etc.); there is no separate `Stance` member upstream.
- `jetsCount`, `direction`, `health`.
- `team`, `standingPolyType`, `heldThing`: original player team, last successful standing-point collision type, and held Thing slot. `standingPolyType` is existing gameplay state, not a fabricated contact event; combine it with fixture triangle/coordinates and observed trajectory to assess coverage.
- `backgroundStatus`, `backgroundPoly`, `backgroundTestResult`: original per-sprite background-transition state.
- `legs` and `body`: original animation `id`, current `frame`, and `count`.
- `weapon`, `secondaryWeapon`, `tertiaryWeapon`: weapon `num`, current `ammo`, `fireInterval`, `fireIntervalPrev`, `fireIntervalReal`, `startup`, `reload`, `reloadPrev`, `reloadReal`. Names refer to the original countdown/previous/real timer members, not configured durations.

### Bullet and Thing fields

Bullet entries contain `id`, `style`, `timeout`, and particle `pos`, `oldpos`, `velocity`, `forces` from `BulletParts`.

Thing entries contain `id`, `style`, `timeout`, and all `particles` in their original skeleton order. Each has `pos`, `oldpos`, `velocity`, `forces`. Thing motion uses Verlet: `pos - oldpos` is the effective displacement, whereas the original `Velocity` array is still recorded verbatim rather than fabricated from that displacement.

This is a **diagnostic projection**, not a complete rollback serialization: it deliberately does not claim that all hidden gameplay counters are included. Rollback uses the separate complete, versioned [simulation save-state layout](sim-abi.md).

## Run and compare

Prerequisites: Docker, pinned pristine checkouts under `reference/`, and the `soldat-web/fpc:bcd7288` image produced by `sim/build/build-image.sh`.

```sh
tools/oracle/build.sh
tools/oracle/run.sh tests/fixtures/arena-run-jump-jet.fixture.json build-out/oracle/arena-a.jsonl
tools/oracle/run.sh tests/fixtures/arena-run-jump-jet.fixture.json build-out/oracle/arena-b.jsonl
cmp build-out/oracle/arena-a.jsonl build-out/oracle/arena-b.jsonl
node tools/oracle/trace.mjs summary build-out/oracle/arena-a.jsonl
node tools/oracle/trace.mjs diff build-out/oracle/arena-a.jsonl build-out/oracle/arena-b.jsonl
```

`diff` streams both traces and reports the first divergent record/tick/stage/field, comparing float bits and ignoring descriptive decimal differences. Exit 0 means equal projected state; exit 1 means a difference. Use `cmp` separately for **byte equality**, as required by G0.3.

The build copies exact pinned Git archives to `build-out/oracle/source` and `base`; it never modifies `reference/` or `sim/opensoldat`. It applies the reviewed patch with `git apply --recount`, then copies `OracleHarness.pas`. GNS downloads/builds only in that writable source copy. The base copy runs the original `create_smod.py`, which merges shared/client/server paths in upstream precedence order into `soldat.smod`; runtime PhysFS mounts this archive at `/`. The normal bundled weapons INI is copied to the user directory and loaded with upstream `Server.LoadWeapons`.

Default platform is `linux/arm64`. For x86 fallback, build the pinned toolchain image for that platform, use `ORACLE_PLATFORM=linux/amd64`, and choose a separate image tag via `ORACLE_IMAGE` if keeping both architectures installed. Remove the architecture-specific `build-out/oracle/cmake` and source build outputs before changing platform; do not reuse cached native objects across architectures.

The startup bypasses `ActivateServer`/`StartServer`, including `Randomize`, networking, lobby, RCON, Fae and scripting. It initializes Cvars, loads original animation/PO objects, map and weapons, and calls the original `CreateSprite`. Scripts/RCON/Steam are also disabled at compile time. Fixture input is assigned **before all tick integration**. `NoClientUpdateTime[slot] := 0` every tick keeps original human-input gates in `Sprites.Update` and jet refill open without changing mechanics code. Outbound server sends exit at the transport boundary under `ORACLE`; no socket is constructed, and runs use Docker `--network none`.

### Restore the large bot goldens

The two 10,000-tick Arena bot trace gzip files are generated locally, not tracked in Git. Fixture definitions, the corpus, the small frozen `tests/fixtures/bots/sim-manifest.json`, original capture hashes/measurements and pickup sidecars remain committed.

After the [development setup and current content import](../development.md), build the independent pinned oracle explicitly, then restore:

```sh
tools/oracle/build.sh
bun tools/oracle/restore-bot-goldens.ts
```

Use the recorded Linux arm64 oracle/compiler setup and Bun 1.3.14 when reproducing the historical gzip bytes. `ORACLE_IMAGE` and `ORACLE_PLATFORM` select the already-built runtime image/platform as in `run.sh`; restoration does not build the compiler or oracle. `RESTORE_CONTENT_ROOT` can select a different complete raw import instead of `dist/content-next`.

Restoration checks every byte/hash in the frozen 174-file input manifest, builds an isolated input projection under ignored `build-out/`, runs the original native oracle for both fixtures, and requires both raw and compressed output identities to match `capture-results.json` before replacing either local golden. A later runtime import may add files without changing the historical input projection. Missing or changed required inputs, fixture drift or output differences fail; do not repin the receipt to accept them.

The command never rewrites the historical capture receipt or qualifies a new simulation artifact. It records only restoration results under `build-out/oracle/restored-bots/`, then removes its temporary input/raw-trace workspace. Native maps-list diagnostics are retained; compare the recorded output identities rather than suppressing original behavior. Run restoration before a bot T1 comparison that needs these goldens.
