# G5 simulation — Original waypoint bots and world

## Gate status

**NOT YET QUALIFIED.** The ABI-4 implementation and original-world artifact are built. The final artifact has not completed the requested oracle, target, cross-runtime, presentation or robustness matrices. Earlier ABI-3 G3 receipts and superseded ABI-4 client receipts do not qualify this artifact. This record deliberately makes no inferred pass claim.

## Frozen artifact and content

| Item | SHA-256 |
| --- | --- |
| WASM `build-out/sim/sim.wasm` | `18e60d802b936716f9fdc991a4c5454f9732f74d9e120318954d18e5b003439a` |
| macOS arm64 native `build-out/sim/sim-native` | `f16c30ea8ac6394bc127562a4c3df755afaee666aadb3201b3e0431c5471fd60` |
| Combined simulation content | `5a4affae0a9dc0ffd9b579367a2c338146e242d20a1c8293c35b920ead983b64` |

The final native build passed all 15 signed-packed-load compiler regression cases. The Linux native and independent oracle builds still require completion and final hashing. ABI/save-state version is `0x00010004`. Content contains 174 raw entries, including all 16 unchanged pinned bot profiles. Source, base and compiler pins remain those in SPEC.

## Implemented boundaries


The client coordinator reports final-artifact integration passes: three package typechecks; 92 client/protocol unit tests, 19 server unit tests, nine real Node prediction tests, three Node bot-fill tests; Vite build/invariants; and four actual private-Chrome original-world gameplay rows (4/8 bots in Arena DM and ctf_Ash CTF), zero console errors and dropped ticks. Those rows observed medikits/grenade kits, CTF flags, movement, shooting, deaths, respawns and scores. This is useful integration evidence, **not a replacement for the determinism matrices or five-minute full-stock robustness**.
- Original `AI.pas` and `Waypoints` execute inside authoritative/local instances. Bot profiles use original parsing and respawn/weapon selection. All original brain fields, controls and RNG state serialize explicitly.
- Original RNG retains the shared FPC stream; keyed AI decisions and bot respawn weapon selection use the separate serialized AI stream. Prediction instances disable decisions without changing snapshot identity.
- `world:"original"` is the product default. Original startup creates CTF flags, medical kits, grenade kits and conditional stationary guns in source order. `world:"fixture"` explicitly preserves controlled initial Things for legacy fixtures. Native pickup/out-of-bounds kit Respawn remains unchanged; no medical/grenade timer is invented.
- Immediate original limbo primary/secondary application is reliable-command driven, preserving menu-close/respawn opportunity. Bink remains client-owned through replay-suppressed exact-input presentation events.
- Explicit bot respawn preserves profile/AI; explicit bot ownership is separate from the internal BOT control method used by authoritative humans.

Detailed role decisions are ledger B01–B08 and updated C06–C08 in [the role ledger](../role-divergence-ledger.md). The complete public contract is [sim-abi](../formats/sim-abi.md).

## Authored corpus and outstanding evidence

The bot corpus has **18 runnable fixtures**, not captured goldens: 14 fixture-world cases across Arena, ctf_Ash, ctf_Laos and ctf_B2b, plus four original-world cases including Arena eight bots/10,000 ticks, Ash CTF, Ash human-input versus bot and Airpirates stationary guns. Short cases run at least 1,500 ticks. Original-world kit pickup is a required observation from the independent original `ServerThingTaken` send site, written to a separate oracle sidecar; proximity or health change is not promoted to pickup proof.

| Requested lane | Final-artifact completed / required |
| --- | ---: |
| Oracle/T1 movement | 0 / 98 |
| Oracle/T1 combat | 0 / 52 |
| Oracle/T1 bots | 0 / 18 |
| Authoritative-control movement comparison | 0 / 98 |
| T2 original + keyed | 0 / 336 |
| Node T3 original + keyed, save/load every 50 ticks | 0 / 336 |
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
  18e60d802b936716f9fdc991a4c5454f9732f74d9e120318954d18e5b003439a
```

The runner checks memory pressure before heavy steps and freezes the WASM identity throughout. It builds corrected Linux native/oracle targets, captures/repeats goldens, executes T1, exhaustively reports the ledgered authoritative-inventory differences, runs T2/Node, actual Chrome then Firefox with private profiles, validates receipts, checks presentation, and runs five-minute full-stock plus thirty-minute selected-map robustness. It stops on a failure and preserves the stage log and execution receipt rather than manufacturing a completed gate. All Docker writes remain host-bound; nothing prunes Docker or touches user browsers/dev server 5195.

## Pre-qualification corrections

Integration rejected superseded artifacts after finding two source-initialization/admission omissions: server secondary WeaponSel entries could not be used as vanilla client-menu eligibility, and omitted `WeaponsInGame` startup counting caused original Respawn to disarm real bots. The exact original startup count/primary-selection block was restored in both extracted initialization and oracle harness. Boundary review also found explicit bot spawn entering the human Dummy adapter; it now calls original Respawn directly. Earlier client results remain historical only, especially after the explicit decision to restore the original initial world.
