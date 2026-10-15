# G3 — client combat presentation

Date: 2026-10-15.
**Client presentation acceptance PASS on the corrected frozen artifact.** Run `combat-1792101421387` passed **33/33 rows** (4 native comparisons and 29 real local-simulation scenarios), with no reported runtime exceptions, on WASM `b66f…fb00`; the binary remained unchanged. Earlier run `combat-1792100004735` on withdrawn `7282…f857` is historical only. The replacement contains the simulation owner's demonstrated periodic CTF lifecycle correction; this client result does not substitute for its independent T1/T2/T3 gate.


## Scope and implementation

Phase 3 item 5 is implemented in the production Phaser client: original bullet styles and trails, skeleton-based Things, flag cloth/kit polygons in native painter order, weapon/clip/fire/loadout gostek parts, existing simulation-driven sparks/explosions, default-interface HUD, genuine-event kill feed, scoreboard, and a local-only chat input shell. React never receives per-frame bars or combat state.

Source contracts:

- `Bullets.pas:789–1107`: original projectile sprite/alpha/trail branches.
- `Things.pas:1080–1338` and `GameRendering.pas:786–873`: original Thing drawing, interpolated skeleton constraints and cloth/kit geometry.
- `GameRendering.pas:1004–1086`: bullets → soldiers → Things → sparks → scenery L1 → Thing polygons → foreground terrain.
- `GostekGraphics.pas:212–483`: source visibility, primary/secondary gun parts, clips, muzzle flashes, bows, minigun, grenades, armor, jets, hair/headgear and colors.
- `InterfaceGraphics.pas`: original default layout, imported graphics, physical pixel alignment, anchor-relative placement and cropped bars.

The coordinator explicitly authorized presentation-only ABI `0x00010003`, superseding the earlier frozen `181b959c27fab6e6bcba973ce3c5dd708554b73e79530a20bab3427dfc5a0393` module. The new render fields publish native data rather than inventing loadouts/damage/history. Dropped-weapon creation-facing is serialized so snapshot-loaded clients retain native texture selection. Parachute tint follows the original network-client owner-shirt assignment. Genuine gameplay events `0x1001…0x1007` are separate from presentation events; local kills use live native death events, while online kills use confirmed deduplicated reliable events. No old-binary qualification is relabeled as ABI3 evidence.

Current tested module: **`b66fccdc125fa1df58a86fc4b506a1dbadd5f7762d468bc842fe7bb92d06fb00`**, ABI/state version 3. The integrated session was rerun on this exact identity after the simulation owner withdrew `7282…f857`. Pre-requalification working captures, states and logs are archived in `build-out/client-g3-pre-b66f.tar.gz`; they are not current-artifact receipts.

## Verification exercised

- Client TypeScript check passed after the networking owner replaced protocol `String.isWellFormed` with equivalent ES2022-compatible surrogate validation. The initial check failed specifically on that external library-target mismatch; it was not hidden with a target bump.
- Vite production build passed; its normal large-chunk warning remains (approximately 2.03 MB JavaScript before gzip).
- Existing client invariant harness passed: fixed-step rates/catch-up, camera, native audio/event framing, bindings, map pivots and FX layering.
- New rendering suites passed **16 tests across 4 files**, covering all 14 bullet styles, all 27 Thing styles, interpolation/alpha/pivots/cloth UVs/constraints, pooled outputs, HUD crop/alignment/font/ping/team-score formulas, gun/clip/muzzle/bow/minigun visibility, genuine death-event parsing and refresh of borrowed render views after non-tick WASM memory growth.

Commands exercised:

```sh
bun run --cwd packages/client check
bun run --cwd packages/client build
bun run --cwd packages/client verify
bun test packages/client/src/render/combat.test.ts \
  packages/client/src/render/hud.test.ts \
  packages/client/src/render/gostek-visibility.test.ts packages/client/src/world.test.ts
sh tools/refclient/build-combat.sh
sh tools/refclient/capture-combat.sh
bun packages/client/scripts/combat-capture.mjs \
  --wasm-sha256 b66fccdc125fa1df58a86fc4b506a1dbadd5f7762d468bc842fe7bb92d06fb00
```

The original native reference client compiled successfully with the new isolated render-only helper. Compiler/linker platform/deprecation warnings remain; they were not suppressed.

## Native-reference and sandbox evidence boundary

Native and browser comparison tooling is `tools/refclient/{build-combat,capture-combat}.sh` and `packages/client/scripts/combat-capture.mjs`. Native gallery state, helper, executable and framebuffer hashes are bound in the capture receipts. Gallery mode only adapts that native state into isolated render bytes; it never counts as a gameplay fixture.

The actual sandbox qualification surface is `/?combat&map=Arena`: a real local ABI3 simulation with two authoritative-control players, persistent inputs, native commands and diagnostic traces. Screenshots use the production draw path at 1280×720/DPR1 and are written to `tests/fixtures/render/combat-*.png`. Native comparisons use SPEC §6.3: no more than 1% of pixels differing by more than 8/255 in any channel. Raster-only HUD galleries are diagnostic isolation, not a substitute for the separately requested full-HUD comparison.

The native capture command initially failed with `EAccessViolation`: render-only `MySprite=1` focus caused normal finalization to attempt a UDP disconnect although that gallery had no connection. The helper now releases render-only focus after drawing and before ordinary teardown. Full-HUD setup uses original `SortPlayers` and exports state after original `RenderFrame`; it does not suppress the original HUD path. Final native executable SHA-256: `b3de6a0c3195f9a2fab2aa5de0ec23dde981e99bb31a6c8d99a3af373e78713e`.

Ego-browser's page screenshot and direct CDP screenshot calls timed out despite a responsive, foreground page. Capture therefore reads the actual preserved WebGL canvas and actual screen-space HUD canvas, composites those existing framebuffers, and saves their PNG bytes. This is recorded as `browser-canvas-framebuffer-readback`; it does not reimplement rendering, substitute art or fabricate gameplay. PNG signatures, actual canvas dimensions, CSS dimensions and DPR are checked. External DOM chat/menus are not included in these framebuffer captures.

## Final measured results

| Native comparison | Pixels exceeding 8/255 | Percentage | SPEC ≤1% |
|---|---:|---:|---|
| All 14 bullet styles, dropped AK74, medikit, grenade kit, both flags | 853 / 921,600 | 0.092556% | PASS |
| Default HUD raster | 1,144 / 921,600 | 0.124132% | PASS |
| Default reload HUD raster | 1,144 / 921,600 | 0.124132% | PASS |
| Full original default HUD | 4,099 / 921,600 | 0.444770% | PASS |

The HUD differences exceed the 0.1% regression-explanation threshold, although they pass the required 1% limit. Initial Canvas2D image resampling was corrected to the existing WebGL LINEAR/PMA renderer, native anisotropic projection and physical-pixel alignment. Native font size conversion, horizontal stretch, shadows and status opacity were also corrected. Remaining visible differences include the native-only cursor/player indicator/version label and glyph/edge rasterization. The browser does not claim byte-identical HUD pixels or adopt a false OpenSoldat software-version label.

The real two-player Arena session exercised all 23 stock definitions through their actual roles: 19 selectable/bonus/M2/unarmed fire paths, frag grenade, cluster grenade, native cluster fragments (not a selectable gun), and thrown knife. Native original mechanics were used throughout; there were no diagnostic bullet injections. Every case captured its evolving simulation/HUD.

- Original medikit and grenade-kit pickup effects passed; AK74 drop at tick 109 and pickup at tick 176 passed.
- Cluster-kit pickup changed tertiary weapon to 51 at tick 91; original throw produced style 9 at tick 127 and original splitting produced style 10 at tick 157.
- Alpha flag held/released at ticks 182/183; Bravo at ticks 92/93, using original collision and `FlagThrow` logic.
- Input-driven AK74 damage killed the target at tick 162; its dead skeleton moved through tick 177; automatic original respawn occurred at tick 284.
- Partial-magazine manual reload entered genuine empty-ammo/reload state at tick 93. A full magazine correctly refuses manual reload.
- Every framebuffer capture checks that rendering preserves the gameplay hash. This exposed and fixed a real stale-borrowed-view bug when hashing grew WASM memory between ticks; the new memory-growth invariant covers it.

Early scenario failures were source-backed fixture-prerequisite errors, not suppressed failures: the longest candidate Arena edge was buried under other triangles; the harness now checks the actual map union for an open corridor. It establishes original `weapon-choice` state before spawn/pickup/respawn, throws upward into clear space instead of disabling collision gates, and tracks the actual target skeleton. Minigun firing is proven by the native projectile, not an invented ammo decrement: the original server's fast-fire snapshot branch does not decrement its ammo without a qualifying human spectator.

Receipts: `build-out/client-g3/combat-results.json` (final combined verdict/metrics), `combat-browser.json`, `combat-frames.jsonl` and individual `*.state.json`; native provenance is `build-out/refclient/combat-capture.json`. PNGs are `tests/fixtures/render/combat-{native,browser}-{objects,hud,hud-reload,hud-full}.png` and `combat-sim-*.png`.

## Explicitly unexercised

No Firefox/Safari combat matrix, physical-refresh/performance/soak, DOM chat transmission, native gostek pose-gallery comparison, or live parachute/stationary-mount interaction is claimed by this run. Chat is a local-only shell as assigned; all 27 Thing render branches are covered by invariants. The browser engine was ego-browser's Chromium runtime; its user-agent version was not retained in this receipt.


No human movement/feel verdict or physical-refresh performance measurement is claimed here. Those are distinct acceptance boundaries from this combat presentation assignment.
