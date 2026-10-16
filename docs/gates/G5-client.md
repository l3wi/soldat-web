# G5 — client practice bots and online bot fill

> **Original-world cutover:** the coordinator subsequently required native initial/periodic flags, medikits, grenade kits and map-authored stationary guns. Product sandbox/server now explicitly use `world:"original"`; controlled combat/prediction and legacy network fixtures explicitly use `world:"fixture"`. The results below bind the preceding `e8c4fbe…` module, not the yet-to-be-refrozen original-world implementation. New world-mode browser/Node assertions require observed medikit/grenade-kit Things and CTF flags. Original-world verification must replace these receipts after the simulation owner announces its final artifact.

## Client integration result — PASS, 2026-10-16

Final module: **`e8c4fbe214eca1559e2a407e4ac8a973a09c592ff443bd6b3862f6a9b9679dd1`**, ABI/state `0x00010004`. Raw content set: `5a4affae0a9dc0ffd9b579367a2c338146e242d20a1c8293c35b920ead983b64`. Earlier artifact checks below are defect history only.

Installed **Chrome 155.0.8059.80**, one disposable private headless profile and one page, passed **4/4** production-menu sandbox matches on this final artifact. Each ran at least 3,600 real simulation ticks. All runs observed original bot movement, shooting, death, automatic respawn and kill scores; every initial secondary→primary menu selection immediately equipped knife + M79 without a forced respawn. **Zero runtime/console/resource errors and zero dropped simulation ticks** were reported. The module remained byte-identical through capture.

| Match | Final tick | Bots moved / total | Bots seen firing | Bots seen respawning | Bot kills / deaths | CTF captures Alpha:Bravo |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Arena DM, 4 bots | 3,605 | 4/4 | 4 | 4 | 15 / 11 | N/A |
| Arena DM, 8 bots | 3,607 | 8/8 | 8 | 8 | 38 / 33 | N/A |
| ctf_Ash CTF, 4 bots | 3,605 | 4/4 | 4 | 3 | 8 / 6 | 1:0 |
| ctf_Ash CTF, 8 bots | 3,608 | 8/8 | 7 | 6 | 14 / 14 | 0:0 in this bounded run |

Final receipt: `build-out/client-g5/bots-browser.json`. Screenshots: `tests/fixtures/render/bots-dm-{4,8}-arena.png` and `bots-ctf-{4,8}-ctf_ash.png`. F1 scoreboard screenshots show original profile display names, native team colors and live scores/kill feed. Visual review also found and corrected a team-header/last-player row overlap; the final CTF screenshot and focused canvas-command test show distinct rows.

```sh
bun run --cwd packages/client dev --port 5199 --strictPort
CLIENT_URL=http://127.0.0.1:5199 \
WASM_SHA256=e8c4fbe214eca1559e2a407e4ac8a973a09c592ff443bd6b3862f6a9b9679dd1 \
node packages/client/scripts/bot-capture.mjs
```

`memory_pressure` was checked before heavy jobs (54% system-wide memory free before the final code/browser runs). All Node/browser work was serial; only the owned private Chrome and port-5199 dev server were closed afterward. The coordinator's user dev server on 5195 was not stopped. No Docker objects or user's browser windows were touched.


## Scope

The React practice menu selects DM/CTF, 0–31 bots, original difficulty (300 stupid, 200 poor, 100 normal, 50 hard, 10 impossible), human CTF team, and balanced/all-Alpha/all-Bravo bot teams. Balanced assignment counts the local human; DM uses solo team zero. Bot profiles are the 16 pinned original server profiles. Maps with `botCapable:false` warn **bots need waypoints on this map** before launch.

Offline practice initializes the real original-mechanics module with `ai:true`, keyed RNG and the selected difficulty, mounts SHA-256-verified raw bot profiles, joins the human through the explicit input-authoritative path, and joins opponents with `control:"bot"`. The Phaser renderer, original-scoreboard projection and genuine death-event feed consume original bot names/teams/scores. ABI4's explicit bot flag distinguishes true AI ownership from input-authoritative human players (both use the upstream internal BOT control method).

The original limbo menu stores next-respawn choices and attempts immediate `weapon-apply` without spawning/healing/teleporting. Secondary selection applies slot two while leaving limbo open; primary applies the chosen pair and closes the original once-per-spawn eligibility window. Rejected immediate application preserves next-respawn fallback. Online choices use reliable protocol `weapon-choice {primary,secondary,selection}` and authoritative server commands; prediction never grants itself weapons.

Hit-spray is client-only cosmetic state. Native BINK presentation events (`0x80001001`) carry original eligible hit/shot/posture/grenade increments and respawn reset. `render/bink.ts` applies original `Weapons.CalculateBink` with ties-to-even rounding and Word wrapping, followed by `UpdateFrame`'s one-per-tick decay, and supplies the counter to crosshair enlargement. The ordinary prediction path publishes complete live-step batches only; reconciliation does not invoke that callback and the counter also guards already-presented ticks. No bink state enters gameplay serialization, hashing, or authoritative accuracy.

Online prediction/extraction hosts explicitly initialize with `ai:false` even when server welcome rules contain `ai:true`. Bots render as remote authoritative snapshots, and their last emitted controls are held for prediction like remote human controls. Hash comparisons are at each loaded authoritative snapshot tick, not between speculative predicted and server timelines.

Server JSON configuration accepts `botCount:0..31` alongside existing `rules` (`mode:"dm"|"ctf"`, optional `botDifficulty:0..300`). The authoritative instance always enables AI; bots occupy reserved highest slots and CTF humans join the smaller team. Admission capacity excludes those reserved slots. Example: `"botCount":4,"rules":{"mode":"ctf","rng":"keyed","botDifficulty":100}`.

## Qualification boundary

This client integration is separate from the full G5 requirement for every bot-capable map, 30-minute DM/CTF runs, native side-by-side bot review, and the simulation T1/T2/T3 matrices. Those remain the simulation qualification owner's evidence; no client smoke check substitutes for them.

The serial browser harness is `packages/client/scripts/bot-capture.mjs`. It requires an explicit frozen `WASM_SHA256`, verifies local and served module bytes, checks `memory_pressure`, launches exactly one private installed headless Chrome/page, and starts 4/8-bot Arena DM and ctf_Ash CTF matches through the production React menu. Its read-only `?bots-check` hook observes the running match; it cannot inject positions, health, kills, scores or controls. It records actual movement, firing-counter changes, deaths, alive-after-dead respawns, kill scores, player names/teams, and immediate secondary/primary limbo application. Screenshots include the F1 scoreboard and use `tests/fixtures/render/bots-*.png`; aggregate receipts use `build-out/client-g5/bots-browser.json`. It does not claim every bot fires or respawns, and CTF captures are reported from team scores rather than inferred from kills.

## Defects found during integration

- The initial immediate-secondary command rejected original knife/LAW choices because it consulted SERVER-side secondary `WeaponSel` entries, which the original CLIENT initializes differently. The simulation owner corrected the original menu eligibility boundary; the direct server command test then passed secondary → primary → closed-menu fallback without respawn/healing.
- The Node control-relay assertion exposed `Buffer.slice()` aliasing in client `heldInput`: Node's borrowed decoded snapshot controls were masked in-place when deriving held remote input. Using an explicit `new Uint8Array(input)` owns the copy for both browser arrays and Node Buffers. A focused Buffer regression test preserves every raw wire byte.
- A browser qualification hook initially retained a render view across `sim_hash_state` allocation/memory growth. The read-only hook now hashes before reacquiring the borrowed render view; this failure was not hidden by ignoring the exception.
- The superseded `0b1abc…f509` run showed DM movement/combat but CTF bots fighting with fists: four bots moved, died, respawned and captured flags (4:1) over 14,399 ticks, yet no shot was observed. This failed rather than substituting captures or kills for firing. The simulation owner traced it to the omitted original `Server.StartServer` `WeaponsInGame` count, whose zero value strips bot guns during the original respawn. No superseded-artifact row is final qualification.

## Online bot-fill check

On the final frozen ABI4 WASM `e8c4fbe214eca1559e2a407e4ac8a973a09c592ff443bd6b3862f6a9b9679dd1`, `node --experimental-transform-types --test packages/server/scripts/bots.test.ts` passed **3/3**: two real headless production-session clients plus four original bots in Arena DM and ctf_Ash CTF, and the direct secondary/primary/fallback/rate-validation worker check. The final run compared **359 DM** and **358 CTF** shared authoritative tick hashes between peers, with zero mismatches, across 737/736 collected bot-snapshot observations. It also checked all raw bot input fields against loaded authoritative render controls, original names, team assignments, waypoint movement and firing; invalid/flooding weapon-choice peers were rejected without stopping synchronized clients. `build-out/net-bots/{dm,ctf}/bots.json` binds the module/ABI/content identities and retains compact observations, not scratch full tick traces.

Node 24 requires `--experimental-transform-types` for the existing parameter-property-based harness. The initial strip-only invocation failed before running tests and is not counted as qualification.

## Final code checks

On the final frozen module, all three package typechecks passed, the selected client/protocol Bun suite passed **92/92**, server unit tests passed **19/19**, the real-WASM production prediction suite passed **9/9** in Node, client invariant checks passed, and the Vite production build passed. Vite retains its ordinary large-chunk warning (2,049.37 kB JavaScript before gzip); it is not a failure or a measured runtime performance claim.

```sh
bun run --cwd packages/client check
bun run --cwd packages/server typecheck
bun run --cwd packages/protocol typecheck
bun test packages/client/src packages/protocol/test packages/protocol/src/transport
bun run --cwd packages/server test
bun run --cwd packages/client verify
bun run --cwd packages/client build
node --experimental-transform-types --test packages/client/src/net/session.test.ts
node --experimental-transform-types --test packages/server/scripts/bots.test.ts
```
