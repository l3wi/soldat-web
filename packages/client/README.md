# Browser client

Production Vite + React 19 shell and Phaser **4.2.1** sandbox. React owns menus/settings only; one Phaser game owns the canvas, input, fixed-step simulation and audio event boundary. The render spike remains an unchanged reference.

## Run locally

From the repository root:

```sh
bun install
bun packages/content/src/cli.ts --base reference/base --out dist/content
bun run --cwd packages/client dev --port 5195
```

Open `http://127.0.0.1:5195/`, choose a map, DM/CTF mode and 0–31 original waypoint bots, then start practice. CTF offers your team and balanced/all-Alpha/all-Bravo bot assignment; difficulty uses the original 300/200/100/50/10 skill settings. Maps marked bot-incapable show **bots need waypoints on this map**. Settings persist on this browser. Click the canvas to focus keyboard/mouse controls; use **Enable audio** for the explicit Web Audio unlock gesture. **Respawn** issues the simulation's reliable `spawn` command at its current tick. Credits & Licenses is available both from the main menu and in-game About.

The dev middleware serves `/content/` from `dist/content/` and `/sim.wasm` from `build-out/sim/sim.wasm`. Build the real module with `sim/build/build-sim.sh` before starting. Module/ABI/content failures leave the map visible with an explicit **simulation unavailable** notice; no placeholder soldier or TypeScript pose evaluator exists.

```sh
bun run --cwd packages/client check
bun run --cwd packages/client build
bun run --cwd packages/client verify
# With the dev server running, actual installed Chrome headless:
bun run --cwd packages/client capture
# Real installed Chrome + Firefox, serial private headless profiles; Safari skipped.
# Requires matching Node movement receipts for the currently built WASM.
node packages/client/scripts/qualify.mjs
# All 99 maps through the actual selector, init/join/step/render path:
bun run --cwd packages/client capture --maps
```

`build` writes `dist/client/`. Deploy that directory with `/content/` mapped to the imported `dist/content/` tree and `/sim.wasm` mapped to the real module, using `application/wasm`. Vite does not copy content into the browser bundle. The current Phaser bundle triggers Vite's ordinary large-chunk warning.

## Runtime reference

- Fixed 60 Hz monotonic accumulator; maximum four catch-up ticks per render. Excess whole-tick debt is discarded and counted. Hiding/resuming a tab resets the accumulator and input: hidden time is never stepped or caught up.
- Logical height 480; width is rounded clamped-aspect × 480. Camera zoom is exponential with quarter-step easing and 0.01 snap; ordinary unscoped follow/aim is the original 0.14 source formula. Mouse world/canvas transforms are inverses before integer input rounding. The movement ABI does not expose weapon scope state.
- The reused 12-byte input record contains original control bits, integer world aim, original unscoped MouseDist=150, press-order bits and zero reserved bytes. Defaults: A/D, W/S, X prone, mouse right jet, mouse left fire, R reload, Q switch, F drop, E grenade, Space flag throw. Settings can rebind keyboard and mouse inputs.
- `WorldView` is the presentation boundary. `SimWorldView` imports sim-host `RENDER_LAYOUT` and `RenderView`, reads borrowed WASM data, and copies previous/current skeletons and ABI3 appearance/inventory fields into reused client arrays. Gostek transforms interpolate actual world points, use normalized pivots, native flex/flip transforms, all 131 part definitions, authoritative player colors, blood/dead-head flags, secondary weapons, primary gun/clip/muzzle parts, bows, minigun, grenade inventory, vest, jets and cosmetics. No pose evaluation occurs in the client.
- Selected-map render JSON/PMS and required textures are lazy. Gostek metadata and decoded core images are cached across map mounts; scenery/terrain sources belong to the selected map. Raw core simulation files, original bot profiles and only the selected raw map are SHA-256 verified before VFS mount/init/load/join. Practice runs `ai:true`, keyed RNG and `world:"original"` (native startup/periodic flags, medikits, grenade kits and map-authored stationary guns), joins the human with `control:"authoritative"` and true AI opponents with `control:"bot"` plus a pinned original profile name. CTF balancing counts the local human. Controlled combat/prediction qualification explicitly uses `world:"fixture"`; online hosts preserve the server's world policy and disable only AI execution. The live sandbox intentionally has a selected-map VFS identity rather than preloading every map.
- `SoldatMap` preserves straight-alpha image inputs, a single GPU PMA upload, native vertex PMA and source-over blending, NPOT terrain repeat, absolute prop/edge rotation centers, world-anchored gradient and native layer order. Animation quads, batches, input/event buffers and render skeleton arrays are reused. Terrain/edge mipmaps follow the setting; atlas sprites stay base-level to prevent cross-sprite mip bleeding.
- Sound event `0x80000004` is mapped by the original 163-slot `Sound.pas` sample-ID table (slot 4 is intentionally unused), using the imported/converted WAV objects. Decoded buffers are cached across scene mounts; Phaser owns the voices. Native linear attenuation, volume conversion, reserved/free channels, loops/stops/volume/pause/resume and `(dx/2000,dy/2000,-0.5)` spatial coordinates are retained; Web Audio distance rolloff is disabled to avoid applying attenuation twice. Playback starts only after the explicit unlock gesture. Unknown presentation kinds remain counted as unmapped.
- `fx_set_view` supplies cosmetic camera bounds/local slot, `fx_step` advances once per gameplay tick, and `fx_render_view` supplies independent cosmetic particles. The renderer consumes shared `FX_LAYOUT` offsets without mutating WASM, interpolates position/lifetime, and ports `TSpark.Render` texture/frame, tint, alpha, rotation, scale and multilayer formulas. Weather styles 38/39/53 use native alpha 105. Source-over sparks draw after soldiers/Things and before scenery L1; unsupported FX remains explicit.
- React teardown is serialized with Phaser's asynchronous destroy. DOM listeners, resize observers and owned GL textures/buffers/programs are cleaned up; retained CPU sources restore the custom renderer on context restoration.

## Combat presentation

`render/combat.ts` ports the original `TBullet.Render`, `TThing.Render`, `TThing.PolygonsRender` and Thing interpolation constraints. Bullets draw before soldiers, Things after soldiers, sparks after Things, and flag cloth/kit polygons after scenery L1 but before foreground map polygons. Assets are the imported original graphics; there are no placeholder projectiles/items. Mutable geometry, particle records and quad outputs are reused.

The default interface uses original imported images and `InterfaceGraphics.pas` positions/cropping/alignment. Screen-space graphics reuse the WebGL LINEAR/PMA renderer; a separate canvas draws native-sized/stretched/shadowed text. Together they own per-frame health, ammo/reload, jets, grenades, vest, scores, ping and kill feed; React never receives frame state. **F1** holds the scoreboard (the original `+fragslist` binding). T/Enter opens the chat input shell; Escape cancels. Chat is explicitly local-only until a real chat protocol is connected. Gameplay input clears while chat or limbo is active, while mouse aim still updates. Native ABI3 death events feed the bounded kill history; online deaths arrive only through the deduplicated confirmed reliable stream, not prediction or health comparisons.

The original **limbo weapons menu**, not a buy menu, appears on initial spawn, death and respawn in ordinary gameplay. Click a secondary (USSOCOM, knife, chainsaw, LAW), or press **Ctrl+1–4**, then click a primary or press **1–0**. Primary selection closes the menu; clicking outside also closes it without firing. Original `BACK`/gun/`MENUCURSOR` images, native 480-high menu coordinates, original typeface, selected colors, hover offsets and unselected-secondary opacity are retained. **Tab** follows `ControlGame.pas:253–285`: while dead it toggles the menu and auto-show lock; while alive it closes the menu and toggles auto-show for subsequent lives, rather than reopening unrestricted live inventory selection. The status notice says whether the weapons menu is active or disabled. The frozen normal-rules sim enables all 14 menu weapons (`SimCore.pas:168`); native one-based `WeaponActive` and `WeaponSel` gating is supported by the menu logic, but these arrays are not currently exported by ABI3.

Local selection stores `weapon-choice` at the current tick and attempts the validated original `weapon-apply` command without healing, teleporting or forcing a respawn. Secondary selections keep limbo open; a primary selection closes its original once-per-spawn eligibility window. If original eligibility rejects immediate application, choices remain selected for next respawn. Online selection sends reliable protocol `weapon-choice {primary,secondary,selection}` to the server; only authoritative snapshots change inventory. Admission `weapon` / `secondaryWeapon` URL parameters remain supported.

The original `GFX_INTERFACE_CURSOR` is drawn centered at the sampled mouse position in the per-frame HUD, at native output-pixel size (not camera zoom size), with `GetMoveacc` animation/jetpack/ground rules and the original `1 + inaccuracy^0.6 / 20` enlargement. Death/limbo use the original menu cursor instead; chat/dialogs hide the gameplay crosshair and restore the browser cursor. Capture/G2/combat qualification surfaces retain their existing cursor/menu-free presentation so retained raster comparisons are not silently changed. New pure logic tests cover native key mapping, enabled-weapon rules, menu lifecycle/hit geometry and cursor scale/movement math; these are not browser visual qualification.

`render/bink.ts` owns the cosmetic original `HitSprayCounter`. Native presentation-only BINK events carry exact eligible shot/posture/hit increments and respawn reset; `CalculateBink` uses ties-to-even rounding and Word arithmetic. Each complete live-step batch applies those events then the original one-tick decay; replay never republishes the callback and a tick high-water mark prevents duplicate increments after correction. The HUD includes this client-only counter in crosshair enlargement; authoritative accuracy/state/hashes remain unchanged. Sniper-line and friendly/enemy-name cursor tint remain unavailable because native scope/sniper-line or cursor-target-name state is not implemented.

Remaining rules boundary:
- **Restricted weapon rules:** export native `WeaponActive` and per-player `WeaponSel` when introducing restricted/advance rules; the menu accepts both one-based arrays, but current frozen normal rules enable all weapons and protocol/render globals do not carry restrictions.

`/?combat&map=Arena` is an explicit qualification surface: two actual authoritative-control local players, CTF rules, diagnostic traces, paused clock and `window.__soldatCombat` commands/input/stepping/camera hooks. It is not a replacement simulation. Its separate `gallery` hook only adapts JSON captured from the native renderer into isolated presentation bytes; gallery rows are labeled rendering-only and never counted as gameplay.

```sh
# After all client and ABI3 source changes, using the final rebuilt module:
bun run --cwd packages/client check
bun run --cwd packages/client build
bun run --cwd packages/client verify
bun test packages/client/src/render/*.test.ts packages/client/src/world.test.ts
sh tools/refclient/build-combat.sh
sh tools/refclient/capture-combat.sh
bun packages/client/scripts/combat-capture.mjs --wasm-sha256 FINAL_ACTUAL_SHA256
```

The capture harness requires a running dev server and installed Chrome. It launches only a private headless Chrome profile and closes its owned browser on completion or error; Firefox combat automation is not supported. It binds served/local WASM identities, compares native bullet/Thing and both raster-isolation/full default HUD galleries at 1280×720, and separately drives real stock-weapon/grenade/pickup/flag/death/respawn scenarios. Captures read the actual retained WebGL and HUD framebuffers; external DOM chat/menus are excluded. It writes `tests/fixtures/render/combat-*.png` and `build-out/client-g3/` receipts. See [G3 client evidence](../../docs/gates/G3-client.md) for the exact exercised/pending boundary; commands alone are not a pass.

## Online authoritative matches

Open `http://127.0.0.1:5195/?server=wss%3A%2F%2Flocalhost%3A7443&map=Arena` to enter the existing game surface immediately. The server must actually host the selected map; a mismatched welcome fails explicitly. Optional `nickname`, `weapon` (original primary number, default `4`), and `secondaryWeapon` (default `0`) query parameters are sent in protocol-v2 admission. Only WSS is admitted. Trust the server certificate in the browser before joining; the client does not disable TLS validation. **Enable audio** remains the explicit browser unlock gesture. Online respawning belongs to the server, not the offline sandbox's spawn command. Without `server`, the sandbox/capture/G2 paths are unchanged.

Admission verifies the frozen ABI4 WASM SHA-256 `e8c4fbe214eca1559e2a407e4ac8a973a09c592ff443bd6b3862f6a9b9679dd1`, ABI/state `0x00010004`, every raw simulation file, and the combined manifest identity. Two separate real WASM hosts mount the complete verified manifest (matching the server's serialized VFS identity), then initialize from welcome rules with explicit `ai:false`, 64-bit seed and map. Only server snapshots create online players; the client never substitutes a local join for admission. Earlier ABI3 qualification is historical and does not qualify this artifact.

`src/net/session.ts` is DOM-free and accepts initialized prediction/extraction hosts, a typed protocol-message sender, monotonic millisecond clock, and optional event/snapshot callbacks. It restores full authoritative states, compares both loaded host hashes with the server hash **at the loaded snapshot tick**, and replays unacknowledged local inputs with `REPLAY=1`. Remote controls hold movement/fire/jet/aim/order but clear one-shot bits 6–11. Inputs target the current predicted tick before stepping, start sequence numbers at one, include the rendered remote `viewTick`, and resend the newest frame plus two predecessors. Sequence numbers remain monotonic through resync. Prediction targets estimated server-now plus half-RTT and two ticks, within server lead/view-age limits; each display frame advances at most four fixed steps.

The 128-entry input ring resynchronizes rather than overwriting pending input; a snapshot outage beyond 128 ticks requests a full resync too. Decoded ACK-candidate baselines have a 128-state/64 MiB aggregate bound. An acknowledged state is never evicted merely because newer snapshots arrived: only a newer baseline ID observed in the ordered server stream proves older states obsolete. At the memory/count bound, incoming snapshots still load, hash-check, render and reconcile, but their ACK is withheld until safe retention space becomes available. A fullstate after an observed nonzero server baseline proves an unsolicited server reset and releases the old epoch; initial fullstate bursts do not release still-eligible ACK candidates.

Unknown baselines request one full resync and are never acknowledged. While that request is outstanding, queued old-epoch deltas are ignored, including deltas that would otherwise be decodable; only a fullstate reopens prediction. Snapshot acknowledgements follow successful delta decode, real loads/hashes and safe baseline retention. Reliable event IDs are deduplicated independently of retransmission, with no assumption that the first ID is one. Server pings receive identical timestamp pongs. Only ordinary prediction emits immediate local presentation events; replay never replays sound/FX, and speculative gameplay events are not delivered as authoritative.

Confirmed gameplay notifications are deliberately deferred by the server for 12 simulation ticks (200 ms) before reliable delivery, plus transport latency. Killfeed/score confirmations must use `window.__soldatOnline.onGameplayEvent(event)` (or the core session's `onEvent`) on arrival, not speculative prediction events. The callback receives each confirmed event ID once; local audio and cosmetic effects remain immediate on ordinary predicted steps. This visible confirmation delay is a bounded lag-compensation policy, not a client timer or an assertion of instant confirmed hits.

Remote soldiers use only authoritative render poses: the extraction host loads each accepted snapshot and copies the ABI's 32-soldier pose arrays into a 16-snapshot ring. It never steps or parses opaque save-state offsets. This adds one real host and one load/render extraction per snapshot, not a host per remote player; `extractionMs` and `reconcileMs` expose the actual cost for qualification. The pose-ring skeleton storage is about 192 KiB (16 × 32 × 2 poses × 24 points × 2 coordinates × 4 bytes), independent of fullstate size. Interpolation starts at 50 ms and adapts within 33–100 ms from arrival jitter; it clamps to received history, never inventing remote extrapolated positions. The local soldier instead uses predicted poses with an 80 ms exponential correction offset applied only to presentation arrays. Rendering cannot feed corrected positions back into simulation.

The overlay reports RTT, **snapshot-ID gaps** (not an assertion of raw packet loss on reliable TCP), correction magnitude, interpolation delay, both same-tick authoritative hashes, and **estimated generation-to-now snapshot age** (receipt age plus RTT/2, with receipt age shown separately). The one-way estimate assumes symmetric latency; asymmetric paths are not presented as synchronized clocks. Core `metrics.snapshotAgeMs` remains receipt age so the clock and rig can distinguish these quantities. `window.__soldatOnline` exposes JSON-safe scalar `metrics`, `session`, optional `onSnapshot(metrics)` callback, and an optional 12-byte `input` override for the qualification rig. The callback borrows the live metrics object: copy it when persisting samples; the client intentionally keeps no unbounded sample log. Clear `input` to restore DOM controls. Metrics include consumed sequence, replay length/cumulative ticks, baseline bytes, exactly-once event counts, duplicate events and event gaps.

Real-WASM invariants (including rollback/replay and authoritative remote rendering) are in `src/net/session.test.ts`. With the already-built frozen WASM and imported content available, the qualification owner can run:

```sh
node --experimental-transform-types --test packages/client/src/net/session.test.ts
bun run --cwd packages/client check
bun run --cwd packages/client build
```

These commands are qualification instructions, not a claim that this change has already passed them.

## Rendering and G2 evidence

`/?map=Airpirates&capture` is deterministic **map-only capture mode**, not gameplay. It uses camera `(0,0,0)`, first scenery frames and mipmaps off. `capture` uses 1280×720/DPR1, compares Airpirates against the retained Phaser fixture (≤0.1% changed pixels), and six stock-map images against native OpenSoldat (SPEC ≤1% pixels differing by >8/255). It exercises audio playback from actual jet input, respawn and three React remounts. `capture --maps` additionally initializes/joins/steps/renders all 99 maps through the actual map selector, requiring visible terrain warnings for Aftermath/Amnesia.

`/?g2&map=Airpirates` runs every movement fixture at deterministic 60/120/144 Hz **display timestamps** through `Phaser.Game.step`: the ordinary scene update, `ClientClock`, persistent 12-byte submission path, actual WASM steps, render skeletons, camera, event/audio boundary and FX are all active. This is accelerated deterministic timing, not a claim of physical 120/144 Hz displays. Fixture controls enter at the record boundary (not synthesized DOM keystrokes). The map backdrop is Airpirates for all hash fixtures, including synthetic collision maps; soldier poses and all gameplay come from each fixture's actual raw map/inputs. Existing DOM sampling is exercised separately by the live capture checks.

Development-only `/g2/` endpoints serve the allowlisted corpus/declared map overlays and compare every returned tick hash against the qualified Node receipt. Receipts bind exact WASM, fixture and effective content-set SHA-256, include render counts/zero dropped ticks, and fail on a final render-induced gameplay mutation. `qualify.mjs` launches the installed real Chrome/Firefox/Safari and writes `build-out/client-g2/results.json` only after all 882 distinct browser/rate/fixture cases are accepted. Full per-tick receipts remain beside it. Node receipts must be regenerated after a WASM/ABI change.

See [G2 evidence](../../docs/gates/G2.md) for exercised results, browser versions, native-gallery limitations and the explicitly pending human Arena/Airpirates side-by-side session. The earlier [shell-only record](../../docs/gates/G2-client.md) is historical and is not itself a G2 pass.
