# G5 — client practice bots and online bot fill

## Scope

The React practice menu selects DM/CTF, 0–31 bots, original difficulty (300 stupid, 200 poor, 100 normal, 50 hard, 10 impossible), human CTF team, and balanced/all-Alpha/all-Bravo bot teams. Balanced assignment counts the local human; DM uses solo team zero. Bot profiles are the 16 pinned original server profiles. Maps with `botCapable:false` warn **bots need waypoints on this map** before launch.

Offline practice initializes the real original-mechanics module with `ai:true`, keyed RNG and the selected difficulty, mounts SHA-256-verified raw bot profiles, joins the human through the explicit input-authoritative path, and joins opponents with `control:"bot"`. The Phaser renderer, original-scoreboard projection and genuine death-event feed consume original bot names/teams/scores. ABI4's explicit bot flag distinguishes true AI ownership from input-authoritative human players (both use the upstream internal BOT control method).

The original limbo menu stores next-respawn choices and attempts immediate `weapon-apply` without spawning/healing/teleporting. Secondary selection applies slot two while leaving limbo open; primary applies the chosen pair and closes the original once-per-spawn eligibility window. Rejected immediate application preserves next-respawn fallback. Online choices use reliable protocol `weapon-choice {primary,secondary,selection}` and authoritative server commands; prediction never grants itself weapons.

Hit-spray is client-only cosmetic state. Native BINK presentation events (`0x80001001`) carry original eligible hit/shot/posture/grenade increments and respawn reset. `render/bink.ts` applies original `Weapons.CalculateBink` with ties-to-even rounding and Word wrapping, followed by `UpdateFrame`'s one-per-tick decay, and supplies the counter to crosshair enlargement. The ordinary prediction path publishes complete live-step batches only; reconciliation does not invoke that callback and the counter also guards already-presented ticks. No bink state enters gameplay serialization, hashing, or authoritative accuracy.

Online prediction/extraction hosts explicitly initialize with `ai:false` even when server welcome rules contain `ai:true`. Bots render as remote authoritative snapshots, and their last emitted controls are held for prediction like remote human controls. Hash comparisons are at each loaded authoritative snapshot tick, not between speculative predicted and server timelines.

## Qualification boundary

This client integration is separate from the full G5 requirement for every bot-capable map, 30-minute DM/CTF runs, native side-by-side bot review, and the simulation T1/T2/T3 matrices. Those remain the simulation qualification owner's evidence; no client smoke check substitutes for them.

The serial browser harness is `packages/client/scripts/bot-capture.mjs`. It requires an explicit frozen `WASM_SHA256`, verifies local and served module bytes, checks `memory_pressure`, launches exactly one private installed headless Chrome/page, and starts 4/8-bot Arena DM and ctf_Ash CTF matches through the production React menu. Its read-only `?bots-check` hook observes the running match; it cannot inject positions, health, kills, scores or controls. It records actual movement, firing-counter changes, deaths, alive-after-dead respawns, kill scores, player names/teams, and immediate secondary/primary limbo application. Screenshots include the F1 scoreboard and use `tests/fixtures/render/bots-*.png`; aggregate receipts use `build-out/client-g5/bots-browser.json`. It does not claim every bot fires or respawns, and CTF captures are reported from team scores rather than inferred from kills.
