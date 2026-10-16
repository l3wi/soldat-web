# G5 simulation — Original waypoint bots and world

## Gate status

**REQUALIFICATION IN PROGRESS.** The frozen ABI-4 artifact passes oracle/T1 **168/168**, T2 **336/336** across both RNG policies, and Node save/load **336/336**. Browser, presentation and robustness matrices remain pending; earlier ABI-3 G3 receipts and superseded ABI-4 client receipts do not qualify those remaining lanes.

## Frozen artifact and content

| Item | SHA-256 |
| --- | --- |
| WASM `build-out/sim/sim.wasm` | `210bcdbed42db537676e97a24b32510337ddde4a9d6c146aa2d14c2c213feaa1` |
| macOS arm64 native `build-out/sim/sim-native` | `94507919902999a170f831d62875f069d83e7f08b60a197297f61d6d212296fe` |
| Linux arm64 native `build-out/sim/linux/sim-native` | `8dde169fb1ed22012284c784ce25465daea31ce5abc3310248937df09c6ac56a` |
| Independent Linux oracle `build-out/oracle/cmake/bin/opensoldatserver` | `3c056d0a89b250dd58b1ec9061637311af8fe260df950b982f1d3315d7c37715` |
| Combined simulation content | `5a4affae0a9dc0ffd9b579367a2c338146e242d20a1c8293c35b920ead983b64` |

The native builds passed all 15 signed-packed-load compiler regression cases; the independent oracle rebuild also passed 15/15. ABI/save-state version is `0x00010004`. Content contains 174 raw entries, including all 16 unchanged pinned bot profiles. Source, base and compiler pins remain those in SPEC. The frozen WASM supersedes `18e60d802b936716f9fdc991a4c5454f9732f74d9e120318954d18e5b003439a` only by an optional human-join `name` field, with unchanged default `oracle-<slot>`; fixture behavior is unchanged.

## Implemented boundaries


The client coordinator reports final-artifact integration passes: three package typechecks; 92 client/protocol unit tests, 19 server unit tests, nine real Node prediction tests, three Node bot-fill tests; Vite build/invariants; and four actual private-Chrome original-world gameplay rows (4/8 bots in Arena DM and ctf_Ash CTF), zero console errors and dropped ticks. Those rows observed medikits/grenade kits, CTF flags, movement, shooting, deaths, respawns and scores. This is useful integration evidence, **not a replacement for the determinism matrices or five-minute full-stock robustness**.
- Original `AI.pas` and `Waypoints` execute inside authoritative/local instances. Bot profiles use original parsing and respawn/weapon selection. All original brain fields, controls and RNG state serialize explicitly.
- Original RNG retains the shared FPC stream; keyed AI decisions and bot respawn weapon selection use the separate serialized AI stream. Prediction instances disable decisions without changing snapshot identity.
- `world:"original"` is the product default. Original startup creates CTF flags, medical kits, grenade kits and conditional stationary guns in source order. `world:"fixture"` explicitly preserves controlled initial Things for legacy fixtures. Native pickup/out-of-bounds kit Respawn remains unchanged; no medical/grenade timer is invented.
- Immediate original limbo primary/secondary application is reliable-command driven, preserving menu-close/respawn opportunity. Bink remains client-owned through replay-suppressed exact-input presentation events.
- Explicit bot respawn preserves profile/AI; explicit bot ownership is separate from the internal BOT control method used by authoritative humans.

Detailed role decisions are ledger B01–B08 and updated C06–C08 in [the role ledger](../role-divergence-ledger.md). The complete public contract is [sim-abi](../formats/sim-abi.md).

## Oracle corpus and outstanding evidence

The bot corpus has **18 captured, repeated-byte-identical oracle fixtures**: 14 fixture-world cases across Arena, ctf_Ash, ctf_Laos and ctf_B2b, plus four original-world cases including Arena eight bots/10,000 ticks, Ash CTF, Ash human-input versus bot and Airpirates stationary guns. All **106/106 required predicates** were observed without fixture or predicate changes. Short cases run at least 1,500 ticks. Original-world kit pickup is proven at the independent original `ServerThingTaken` send site in separate oracle sidecars: Arena 40, Ash four bots 6, Ash human/bot 1, Airpirates 8. Captures retain `captured-with-limitations`: this proves the declared required observations, not every possible combat/flag/stationary-gun interaction. Evidence: `tests/fixtures/bots/capture-results.json` and its referenced goldens/sidecars.

| Requested lane | Final-artifact completed / required |
| --- | ---: |
| Oracle/T1 movement | **98 / 98 bit-exact** |
| Oracle/T1 combat | **52 / 52 bit-exact** |
| Oracle/T1 bots | **18 / 18 bit-exact**, 106/106 required observations |
| Authoritative-control movement comparison | **98 / 98 movement/pose identical**; strict full trace 95/98, only ledger C08 inventory differences |
| T2 original + keyed | **336 / 336 bit-exact**, plus byte-identical hash/event sidecars; 168 per policy |
| Node T3 original + keyed, save/load every 50 ticks | **336 / 336**, 168 per policy |
| Chrome T3 original + keyed | 0 / 336 |
| Firefox T3 original + keyed | 0 / 336 |
| Presentation/render/menu/bink checks | Not run on final artifact |
| Five-minute robustness, eight bots, DM + CTF | 0 / 194 map/mode runs |
| Optional thirty-minute probes, Arena/Ash/Laos, DM + CTF | 0 / 6 |

Safari is excluded by the user's decision, not passed. There is **no measured bot robustness table yet**: no crash count, stalled-bot count or score is fabricated. The runner discovers 97 bot-capable stock maps; ctf_Aftermath and ctf_Amnesia have no bot paths. It records every alive bot's unchanged-current-waypoint streak and flags more than 600 ticks, including potentially legitimate combat/camping. Mode-inappropriate stock maps are still exercised and their absent flag spawns are recorded.

## Serial qualification command

After the client coordinator releases the heavy-job slot, run from the repository root:

```sh
node sim/build/run-g5.mjs build-out/sim/g5/final \
  210bcdbed42db537676e97a24b32510337ddde4a9d6c146aa2d14c2c213feaa1
```

The runner checks memory pressure before heavy steps and freezes the WASM identity throughout. It builds corrected Linux native/oracle targets, captures/repeats goldens, executes T1, exhaustively reports the ledgered authoritative-inventory differences, runs T2/Node, actual Chrome then Firefox with private profiles, validates receipts, checks presentation, and runs five-minute full-stock plus thirty-minute selected-map robustness. It stops on a failure and preserves the stage log and execution receipt rather than manufacturing a completed gate. All Docker writes remain host-bound; nothing prunes Docker or touches user browsers/dev server 5195.

## Pre-qualification corrections

Integration rejected superseded artifacts after finding two source-initialization/admission omissions: server secondary WeaponSel entries could not be used as vanilla client-menu eligibility, and omitted `WeaponsInGame` startup counting caused original Respawn to disarm real bots. The exact original startup count/primary-selection block was restored in both extracted initialization and oracle harness. Boundary review also found explicit bot spawn entering the human Dummy adapter; it now calls original Respawn directly. Earlier client results remain historical only, especially after the explicit decision to restore the original initial world.

## Oracle startup correction during qualification

The first full bot capture attempt passed 16 short fixtures, but both Arena 10,000-tick fixtures exited 217 in original `Server.NextMap`: fixture-world after tick 5,019 and original-world after tick 5,606. Resolving the existing executable's stack through an unstripped relink of the same objects identified `NextMap <- SortPlayers <- Die <- HealthHit <- CheckSpriteCollision <- UpdateFrame`. `SortPlayers` invokes `NextMap` at the original kill limit. Original startup allocates `MapsList` before gameplay; the independent harness had bypassed that allocation, leaving `MapsList.Count` to dereference nil. The extracted simulation already allocated the list in `Server` initialization. The harness now allocates and frees its own list; no simulation mechanics, frozen artifact, fixture inputs or observation predicates changed. Failed attempts do not count as golden evidence.

Both harness and extracted simulation intentionally have an **empty map-rotation list for the admitted single-map match**, not a one-entry rotation/restart list. Original `NextMap` with an empty list reports “Can't load maps from mapslist”; it does not invoke `PrepareMapChange`, set a map-change countdown, reset scores, restart the map or emit a successful map-transition notification. Gameplay continues on the current map. The 10,000-tick T1 fixtures must therefore cover the first kill-limit call and the remaining ticks; a passing comparison is not evidence of a successful rotation/restart, which remains outside this ABI.

## Completed deterministic tiers

`build-out/sim/g5/final/execution.json` records zero-exit captures, movement/combat/bot T1 and all three T2/Node corpus stages. The authoritative-control command exits 1 for the three deliberate C08 secondary-inventory differences; its explicit `movementAndPoseIdentical:98` acceptance passes. Full results are `movement-t1/results.json`, `movement-authoritative/{results,all-differences}.json`, and `{movement,combat,bots}/results-{t1,t2}.json` under that directory (movement T1 uses `movement-t1/`). T1 bot fixtures include both complete 10,000-tick Arena runs, not a shortened pre-kill-limit comparison.

The original serial runner was deliberately stopped as its first Chrome lane opened, to obey coordinator browser-slot arbitration and mandatory audio muting. No incomplete browser lane is counted. Remaining stages resume with the same documented commands and frozen inputs; native/oracle/T1/T2/Node evidence is not discarded or rerun just because browser scheduling was interrupted.
