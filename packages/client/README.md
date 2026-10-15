# Browser client

Production Vite + React 19 shell and Phaser **4.2.1** sandbox. React owns menus/settings only; one Phaser game owns the canvas, input, fixed-step simulation and audio event boundary. The render spike remains an unchanged reference.

## Run locally

From the repository root:

```sh
bun install
bun packages/content/src/cli.ts --base reference/base --out dist/content
bun run --cwd packages/client dev --port 5195
```

Open `http://127.0.0.1:5195/`, choose any imported map, and start the sandbox. Settings persist on this browser. Click the canvas to focus keyboard/mouse controls; use **Enable audio** for the explicit Web Audio unlock gesture. **Respawn** issues the simulation's reliable `spawn` command at its current tick. Credits & Licenses is available both from the main menu and in-game About.

The dev middleware serves `/content/` from `dist/content/` and `/sim.wasm` from `build-out/sim/sim.wasm`. Build the real module with `sim/build/build-sim.sh` before starting. Module/ABI/content failures leave the map visible with an explicit **simulation unavailable** notice; no placeholder soldier or TypeScript pose evaluator exists.

```sh
bun run --cwd packages/client check
bun run --cwd packages/client build
bun run --cwd packages/client verify
# With the dev server running, actual installed Chrome headless:
bun run --cwd packages/client capture
# Real installed Chrome + Firefox + Safari; dev server must be running.
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
- `WorldView` is the presentation boundary. `SimWorldView` imports sim-host `RENDER_LAYOUT` and `RenderView`, reads borrowed WASM data, and copies previous/current skeletons into reused client arrays. Gostek transforms interpolate these actual world points, use normalized pivots, native flex/flip transforms, all 131 part definitions, authoritative team, health-driven blood and dead-head flags. No pose evaluation occurs in the client. Cosmetic/loadout fields not represented by the ABI are not invented.
- Selected-map render JSON/PMS and required textures are lazy. Gostek metadata and decoded core images are cached across map mounts; scenery/terrain sources belong to the selected map. Raw core simulation files and only the selected raw map are SHA-256 verified before VFS mount/init/load/join. The sandbox joins `control:"authoritative"` so original server-owned movement/firing actually executes for the local player; AI remains disabled. Qualification fixtures retain their declared role (the legacy 98 movement fixtures default to HUMAN). The live sandbox intentionally has a selected-map VFS identity rather than preloading every map.
- `SoldatMap` preserves straight-alpha image inputs, a single GPU PMA upload, native vertex PMA and source-over blending, NPOT terrain repeat, absolute prop/edge rotation centers, world-anchored gradient and native layer order. Animation quads, batches, input/event buffers and render skeleton arrays are reused. Terrain/edge mipmaps follow the setting; atlas sprites stay base-level to prevent cross-sprite mip bleeding.
- Sound event `0x80000004` is mapped by the original 163-slot `Sound.pas` sample-ID table (slot 4 is intentionally unused), using the imported/converted WAV objects. Decoded buffers are cached across scene mounts; Phaser owns the voices. Native linear attenuation, volume conversion, reserved/free channels, loops/stops/volume/pause/resume and `(dx/2000,dy/2000,-0.5)` spatial coordinates are retained; Web Audio distance rolloff is disabled to avoid applying attenuation twice. Playback starts only after the explicit unlock gesture. Unknown presentation kinds remain counted as unmapped.
- `fx_set_view` supplies cosmetic camera bounds/local slot, `fx_step` advances once per gameplay tick, and `fx_render_view` supplies independent cosmetic particles. The renderer consumes shared `FX_LAYOUT` offsets without mutating WASM, interpolates position/lifetime, and ports `TSpark.Render` texture/frame, tint, alpha, rotation, scale and multilayer formulas. Weather styles 38/39/53 use native alpha 105. Source-over sparks draw after soldiers/Things and before scenery L1; unsupported FX remains explicit.
- React teardown is serialized with Phaser's asynchronous destroy. DOM listeners, resize observers and owned GL textures/buffers/programs are cleaned up; retained CPU sources restore the custom renderer on context restoration.

## Rendering and G2 evidence

`/?map=Airpirates&capture` is deterministic **map-only capture mode**, not gameplay. It uses camera `(0,0,0)`, first scenery frames and mipmaps off. `capture` uses 1280×720/DPR1, compares Airpirates against the retained Phaser fixture (≤0.1% changed pixels), and six stock-map images against native OpenSoldat (SPEC ≤1% pixels differing by >8/255). It exercises audio playback from actual jet input, respawn and three React remounts. `capture --maps` additionally initializes/joins/steps/renders all 99 maps through the actual map selector, requiring visible terrain warnings for Aftermath/Amnesia.

`/?g2&map=Airpirates` runs every movement fixture at deterministic 60/120/144 Hz **display timestamps** through `Phaser.Game.step`: the ordinary scene update, `ClientClock`, persistent 12-byte submission path, actual WASM steps, render skeletons, camera, event/audio boundary and FX are all active. This is accelerated deterministic timing, not a claim of physical 120/144 Hz displays. Fixture controls enter at the record boundary (not synthesized DOM keystrokes). The map backdrop is Airpirates for all hash fixtures, including synthetic collision maps; soldier poses and all gameplay come from each fixture's actual raw map/inputs. Existing DOM sampling is exercised separately by the live capture checks.

Development-only `/g2/` endpoints serve the allowlisted corpus/declared map overlays and compare every returned tick hash against the qualified Node receipt. Receipts bind exact WASM, fixture and effective content-set SHA-256, include render counts/zero dropped ticks, and fail on a final render-induced gameplay mutation. `qualify.mjs` launches the installed real Chrome/Firefox/Safari and writes `build-out/client-g2/results.json` only after all 882 distinct browser/rate/fixture cases are accepted. Full per-tick receipts remain beside it. Node receipts must be regenerated after a WASM/ABI change.

See [G2 evidence](../../docs/gates/G2.md) for exercised results, browser versions, native-gallery limitations and the explicitly pending human Arena/Airpirates side-by-side session. The earlier [shell-only record](../../docs/gates/G2-client.md) is historical and is not itself a G2 pass.
