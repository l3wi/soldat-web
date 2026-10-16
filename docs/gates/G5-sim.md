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
| Presentation/render/menu/bink checks | **PASS**: 3 weather lanes; 722 render publications; 180 replay comparisons; limbo, bink and bot snapshot checks |
| Five-minute robustness, eight bots, DM + CTF | **194 / 194 complete**, zero crashes; 281 bot-run stall flags / 433 episodes |
| Optional thirty-minute probes, Arena/Ash/Laos, DM + CTF | 0 / 6 |

Safari is excluded by the user's decision, not passed. Five-minute robustness covers all 97 bot-capable stock maps; ctf_Aftermath and ctf_Amnesia have no bot paths and are excluded. Every alive bot's unchanged-current-waypoint streak is measured; more than 600 consecutive ticks flags a stall, including potentially legitimate combat/camping. Mode-inappropriate stock maps are still exercised. All 29 unprefixed DM maps and 19 `htf_` maps lack one or both CTF flag spawns; their CTF runs are stress coverage, not proof of a playable CTF map. The other 49 maps have both flag spawns. Exact spawn booleans and per-bot score/path histories are retained in the robustness JSON.

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

`build-out/sim/g5/final/execution.json` records zero-exit captures, movement/combat/bot T1 and all three T2/Node corpus stages. The authoritative-control command exits 1 for the three deliberate C08 secondary-inventory differences; its explicit `movementAndPoseIdentical:98` acceptance passes. Full results are `movement-t1/results.json`, `movement-authoritative/results.json` (including exhaustive differences in each failed fixture's `comparison.stdout`), and `{movement,combat,bots}/results-{t1,t2}.json` under that directory (movement T1 uses `movement-t1/`). T1 bot fixtures include both complete 10,000-tick Arena runs, each comparing 10,002 records / 10,001 states with zero float differences: the original-world call at tick 5,607 and fixture-world call at tick 5,020 and all subsequent ticks through 10,000 are covered, not shortened away before the kill limit.

The original serial runner was deliberately stopped as its first Chrome lane opened, to obey coordinator browser-slot arbitration and mandatory audio muting. No incomplete browser lane is counted. Remaining stages resume with the same documented commands and frozen inputs; native/oracle/T1/T2/Node evidence is not discarded or rerun just because browser scheduling was interrupted.

## Presentation checks

Final-artifact render evidence (`final/render-check.json`) records 722 publications, 577 bullet and 282 Thing observations, cross-instance creation-facing `[1,0]`, and 180 replay comparisons. Immediate limbo secondary/primary application and rejection after closure pass. Exact-input bink amount 65 is observed, replay suppresses its presentation event, and gameplay hashes are identical. Explicit bot respawn retains AI, waypoints are observed, and an AI-off instance loads the authoritative snapshot with identical hash.

The three 600-tick weather lanes each pass 600 FX-on/off hash comparisons and 600 rewind/replay comparisons, with alpha 105. Rain observes 1,867 sounds / 24,250 active-spark observations; sand 1,866 / 27,836; snow 1,866 / 29,317. Commands are `node sim/build/check-render.mjs build-out/sim/sim.wasm build-out/sim/g5/final/render-check.json` and `node sim/build/check-presentation.mjs N build-out/sim/g5/final/presentation-N.json` for N=1,2,3, each preceded by `memory_pressure`. These checks ran during the coordinator-imposed browser hold, without overlapping another G5 heavy job.

## Five-minute full-stock robustness

Command: `node --expose-gc sim/build/check-bots.mjs --minutes 5 --out build-out/sim/g5/final/robustness-5min.json`. Node v24.14.0 fast-forwards **18,000 ticks per match**, eight bots, AI enabled, original-world default, keyed RNG, seed 123456789. All **194/194 map/mode runs complete**, **0 crashes**, 3,492,000 total simulated match ticks. Wall time is 649.42 seconds. DM totals: 17,206 kills / 17,758 deaths; CTF totals: 8,923 kills / 9,410 deaths / 98 individual captures. Scores are original counters, not inferred bullet/health events.

There are **281 bot-run stall flags** (DM 126, CTF 155), comprising **433 episodes** (DM 180, CTF 253). This is **not a zero-stuck-bot claim**. The detector identifies unchanged `CurrentWaypoint` for >10 simulated seconds while alive; no progress threshold was weakened, and no original AI behavior was changed to hide the results. Combat, authored camping and mode-inappropriate map layouts can flag legitimately. These measurements alone do not establish an extracted-simulation defect or prove every flag benign; no oracle long-run comparison is claimed for the full stock set.

In the table, paired columns are **DM/CTF**. “Stalled” counts distinct bot instances per run, not unique profiles across maps; “episodes” counts threshold crossings after resets. K:D sums all eight players. CTF A:B is original alpha/bravo team score. Full per-slot kills/deaths/captures, longest streaks, waypoint changes, alive/combat ticks and final hashes are in `final/robustness-5min.json`.

| Map | Crashes DM/CTF | Stalled DM/CTF | Episodes DM/CTF | DM K:D | CTF K:D | CTF A:B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aero | 0/0 | 0/7 | 0/7 | 237:244 | 69:78 | 0:0 |
| Airpirates | 0/0 | 1/6 | 1/12 | 151:172 | 64:120 | 0:0 |
| Arena | 0/0 | 0/2 | 0/2 | 176:178 | 101:101 | 0:0 |
| Arena2 | 0/0 | 1/0 | 1/0 | 251:254 | 153:157 | 0:0 |
| Arena3 | 0/0 | 0/0 | 0/0 | 227:233 | 184:186 | 0:0 |
| Bigfalls | 0/0 | 2/1 | 2/1 | 161:164 | 153:160 | 0:0 |
| Blox | 0/0 | 0/0 | 0/0 | 154:212 | 106:156 | 0:0 |
| Bridge | 0/0 | 0/0 | 0/0 | 226:232 | 63:65 | 0:0 |
| Bunker | 0/0 | 4/0 | 5/0 | 226:227 | 0:0 | 0:0 |
| Cambodia | 0/0 | 0/0 | 0/0 | 139:144 | 12:12 | 0:0 |
| CrackedBoot | 0/0 | 0/1 | 0/1 | 174:174 | 116:117 | 0:0 |
| Daybreak | 0/0 | 4/0 | 4/0 | 174:175 | 116:116 | 0:0 |
| DesertWind | 0/0 | 0/0 | 0/0 | 256:258 | 167:170 | 0:0 |
| Factory | 0/0 | 1/0 | 1/0 | 203:210 | 101:104 | 0:0 |
| Flashback | 0/0 | 1/0 | 1/0 | 218:219 | 129:134 | 0:0 |
| HH | 0/0 | 0/3 | 0/3 | 134:137 | 14:15 | 0:0 |
| Island2k5 | 0/0 | 1/1 | 1/1 | 179:200 | 126:160 | 0:0 |
| Jungle | 0/0 | 2/0 | 2/0 | 183:203 | 136:140 | 0:0 |
| Krab | 0/0 | 2/4 | 2/10 | 146:147 | 99:103 | 0:0 |
| Lagrange | 0/0 | 1/0 | 1/0 | 209:210 | 0:0 | 0:0 |
| Leaf | 0/0 | 0/0 | 0/0 | 229:232 | 172:176 | 0:0 |
| MrSnowman | 0/0 | 0/2 | 0/2 | 176:177 | 49:49 | 0:0 |
| RR | 0/0 | 0/0 | 0/0 | 236:236 | 197:200 | 0:0 |
| RatCave | 0/0 | 0/0 | 0/0 | 187:191 | 121:122 | 0:0 |
| Rok | 0/0 | 2/0 | 2/0 | 190:191 | 41:43 | 0:0 |
| Shau | 0/0 | 2/0 | 2/0 | 177:199 | 60:94 | 0:0 |
| Tropiccave | 0/0 | 0/0 | 0/0 | 218:220 | 113:113 | 0:0 |
| Unlim | 0/0 | 0/0 | 0/0 | 204:207 | 45:48 | 0:0 |
| Veoto | 0/0 | 1/2 | 1/3 | 182:204 | 24:82 | 0:0 |
| ctf_Ash | 0/0 | 1/3 | 1/4 | 187:191 | 100:102 | 3:1 |
| ctf_B2b | 0/0 | 4/2 | 8/2 | 120:121 | 62:63 | 2:1 |
| ctf_Blade | 0/0 | 1/2 | 1/2 | 211:212 | 108:109 | 0:0 |
| ctf_Campeche | 0/0 | 1/1 | 1/1 | 199:201 | 91:91 | 4:2 |
| ctf_Cobra | 0/0 | 1/1 | 1/2 | 195:201 | 118:119 | 3:2 |
| ctf_Crucifix | 0/0 | 2/2 | 2/4 | 170:175 | 43:43 | 1:0 |
| ctf_Death | 0/0 | 2/3 | 2/3 | 216:220 | 111:112 | 1:3 |
| ctf_Division | 0/0 | 3/2 | 3/2 | 187:189 | 114:116 | 1:1 |
| ctf_Dropdown | 0/0 | 1/0 | 1/0 | 212:220 | 131:132 | 0:0 |
| ctf_Equinox | 0/0 | 3/1 | 4/2 | 119:128 | 90:98 | 2:1 |
| ctf_Guardian | 0/0 | 1/1 | 1/2 | 210:211 | 136:137 | 4:2 |
| ctf_Hormone | 0/0 | 0/1 | 0/1 | 238:245 | 38:38 | 0:1 |
| ctf_IceBeam | 0/0 | 2/3 | 2/3 | 190:194 | 87:87 | 2:2 |
| ctf_Kampf | 0/0 | 1/0 | 1/0 | 189:191 | 122:123 | 0:0 |
| ctf_Lanubya | 0/0 | 0/1 | 0/1 | 153:156 | 81:81 | 0:1 |
| ctf_Laos | 0/0 | 0/1 | 0/1 | 135:136 | 78:78 | 1:1 |
| ctf_MFM | 0/0 | 3/5 | 4/7 | 172:173 | 96:98 | 1:0 |
| ctf_Maya | 0/0 | 2/0 | 2/0 | 146:150 | 84:84 | 1:0 |
| ctf_Mayapan | 0/0 | 0/1 | 0/1 | 174:182 | 74:77 | 0:2 |
| ctf_Nuubia | 0/0 | 0/2 | 0/2 | 188:194 | 98:98 | 1:5 |
| ctf_Raspberry | 0/0 | 0/1 | 0/1 | 153:155 | 102:103 | 0:0 |
| ctf_Rotten | 0/0 | 0/1 | 0/1 | 176:181 | 124:131 | 0:0 |
| ctf_Ruins | 0/0 | 2/2 | 2/2 | 143:146 | 101:102 | 2:1 |
| ctf_Run | 0/0 | 0/3 | 0/3 | 162:162 | 81:83 | 2:1 |
| ctf_Scorpion | 0/0 | 1/2 | 1/4 | 201:203 | 71:73 | 3:0 |
| ctf_Snakebite | 0/0 | 1/0 | 1/0 | 164:165 | 110:110 | 2:0 |
| ctf_Steel | 0/0 | 1/0 | 1/0 | 191:195 | 95:100 | 1:3 |
| ctf_Triumph | 0/0 | 0/1 | 0/1 | 178:179 | 100:102 | 2:0 |
| ctf_Viet | 0/0 | 0/1 | 0/1 | 159:160 | 76:76 | 1:3 |
| ctf_Voland | 0/0 | 5/3 | 6/3 | 162:176 | 83:88 | 3:1 |
| ctf_Wretch | 0/0 | 0/2 | 0/2 | 217:219 | 117:118 | 4:1 |
| ctf_X | 0/0 | 0/1 | 0/1 | 198:203 | 128:130 | 2:0 |
| htf_Arch | 0/0 | 0/0 | 0/0 | 196:199 | 87:89 | 0:0 |
| htf_Baire | 0/0 | 2/2 | 2/3 | 158:162 | 94:98 | 0:0 |
| htf_Boxed | 0/0 | 0/1 | 0/1 | 256:260 | 129:129 | 0:0 |
| htf_Desert | 0/0 | 0/0 | 0/0 | 188:204 | 126:135 | 0:0 |
| htf_Dorothy | 0/0 | 0/1 | 0/1 | 168:171 | 99:102 | 0:0 |
| htf_Dusk | 0/0 | 0/1 | 0/1 | 154:159 | 73:75 | 0:0 |
| htf_Erbium | 0/0 | 0/0 | 0/0 | 218:219 | 132:136 | 0:0 |
| htf_Feast | 0/0 | 0/2 | 0/3 | 180:184 | 143:147 | 0:0 |
| htf_Mossy | 0/0 | 0/0 | 0/0 | 210:217 | 116:117 | 0:0 |
| htf_Muygen | 0/0 | 0/0 | 0/0 | 186:189 | 124:125 | 0:0 |
| htf_Niall | 0/0 | 0/2 | 0/2 | 194:231 | 119:153 | 0:0 |
| htf_Nuclear | 0/0 | 2/1 | 2/1 | 199:202 | 156:158 | 0:0 |
| htf_Prison | 0/0 | 1/0 | 1/0 | 216:223 | 147:149 | 0:0 |
| htf_Rubik | 0/0 | 0/2 | 0/2 | 160:162 | 60:61 | 0:0 |
| htf_Star | 0/0 | 0/0 | 0/0 | 178:180 | 59:62 | 0:0 |
| htf_Tower | 0/0 | 1/4 | 1/8 | 182:183 | 106:106 | 0:0 |
| htf_Void | 0/0 | 0/0 | 0/0 | 163:164 | 60:60 | 0:0 |
| htf_Vortex | 0/0 | 0/0 | 0/0 | 209:209 | 108:109 | 0:0 |
| htf_Zajacz | 0/0 | 0/2 | 0/4 | 158:160 | 101:103 | 0:0 |
| inf_Abel | 0/0 | 4/6 | 4/11 | 117:120 | 17:19 | 0:0 |
| inf_April | 0/0 | 3/4 | 3/5 | 161:165 | 83:85 | 0:0 |
| inf_Argy | 0/0 | 4/4 | 4/5 | 86:98 | 25:30 | 0:0 |
| inf_Belltower | 0/0 | 0/4 | 0/13 | 225:227 | 83:84 | 5:1 |
| inf_Biologic | 0/0 | 0/0 | 0/0 | 170:174 | 94:98 | 1:0 |
| inf_Changeling | 0/0 | 0/1 | 0/1 | 184:185 | 98:102 | 1:0 |
| inf_Flute | 0/0 | 2/0 | 2/0 | 181:183 | 112:115 | 0:0 |
| inf_Fortress | 0/0 | 8/5 | 21/15 | 73:74 | 31:31 | 0:0 |
| inf_Industrial | 0/0 | 6/4 | 7/6 | 100:102 | 48:49 | 1:0 |
| inf_Messner | 0/0 | 4/4 | 5/6 | 123:124 | 46:47 | 0:0 |
| inf_Moonshine | 0/0 | 1/4 | 1/12 | 103:141 | 60:69 | 0:0 |
| inf_Motheaten | 0/0 | 8/6 | 25/24 | 109:118 | 37:58 | 3:0 |
| inf_Outpost | 0/0 | 2/3 | 2/5 | 115:121 | 51:57 | 1:0 |
| inf_Rescue | 0/0 | 4/1 | 8/2 | 90:100 | 31:38 | 0:0 |
| inf_Rise | 0/0 | 4/4 | 6/4 | 102:104 | 101:102 | 0:0 |
| inf_Warehouse | 0/0 | 6/5 | 13/9 | 144:147 | 52:53 | 0:0 |
| inf_Warlock | 0/0 | 1/4 | 1/8 | 212:213 | 134:136 | 0:1 |

## Browser harness upload correction

The first muted Chrome matrix accepted all 196 movement and 104 combat receipts, then failed in the first bot lane with `TypeError: Failed to fetch` rather than a simulation mismatch. The two long eight-bot Node receipt files are 33,797,024 and 33,950,261 bytes; each exceeds the receipt server's previous 32 MiB (33,554,432-byte) request ceiling. The harness ceiling is now 64 MiB, with all fixture/artifact identity, per-tick hash/event, restored-lane and checkpoint comparisons unchanged. The failed browser stage is retained in `final/logs/browser-chrome.log` and is not counted as completed bot evidence; only the bot lanes require recollection. This changes no frozen simulation code, fixture or predicate.
