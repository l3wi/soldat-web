# Browser client

Production Vite + React 19 shell and Phaser **4.2.1** sandbox. React owns menus/settings only; one Phaser game owns the canvas, input, fixed-step simulation and audio event boundary. The render spike remains an unchanged reference.

## Run locally

From the repository root:

```sh
bun install
bun packages/content/src/cli.ts --base reference/base --out dist/content
bun run --cwd packages/client dev --port 5195
```

Open `http://127.0.0.1:5195/`, choose any imported map, and start the sandbox. Settings persist on this browser. Click the canvas to focus keyboard/mouse controls; use **Enable audio** for the explicit Web Audio unlock gesture. Credits & Licenses is available both from the main menu and in-game About.

The dev middleware serves `/content/` from `dist/content/` and `/sim.wasm` from `build-out/sim/sim.wasm`. Build the real Phase-1 module using the simulation toolchain before expecting a soldier. When the module is absent or initialization fails, the map remains visible with a **simulation unavailable** notice. There is no placeholder soldier or TypeScript pose evaluator.

```sh
bun run --cwd packages/client check
bun run --cwd packages/client build
bun run --cwd packages/client verify
# With the dev server running, actual installed Chrome headless:
bun run --cwd packages/client capture
```

`build` writes `dist/client/`. Deploy that directory with `/content/` mapped to the imported `dist/content/` tree and `/sim.wasm` mapped to the real module, using `application/wasm`. Vite does not copy content into the browser bundle. The current Phaser bundle triggers Vite's ordinary large-chunk warning.

## Runtime reference

- Fixed 60 Hz monotonic accumulator; maximum four catch-up ticks per render. Excess whole-tick debt is discarded and counted. Hiding/resuming a tab resets the accumulator and input: hidden time is never stepped or caught up.
- Logical height 480; width is rounded clamped-aspect × 480. Camera zoom is exponential with quarter-step easing and 0.01 snap; ordinary unscoped follow/aim is the original 0.14 source formula. Mouse world/canvas transforms are inverses before integer input rounding. The movement ABI does not expose weapon scope state.
- The reused 12-byte input record contains original control bits, integer world aim, original unscoped MouseDist=150, press-order bits and zero reserved bytes. Defaults: A/D, W/S, X prone, mouse right jet, mouse left fire, R reload, Q switch, F drop, E grenade, Space flag throw. Settings can rebind keyboard and mouse inputs.
- `WorldView` is the presentation boundary. `SimWorldView` imports sim-host `RENDER_LAYOUT` and `RenderView`, reads borrowed WASM data, and copies previous/current skeletons into reused client arrays. Gostek transforms interpolate these actual world points, use normalized pivots, native flex/flip transforms, all 131 part definitions, health-driven blood and dead-head flags. No pose evaluation occurs in the client. Phase-1 lacks cosmetic/loadout fields: renderer uses the native base-part table instead of inventing the spike's AK74/cigar/hair fixture.
- Selected-map render JSON/PMS and required textures are lazy. Gostek metadata and decoded core images are cached across map mounts; scenery/terrain sources belong to the selected map. Raw core simulation files and only the selected raw map are SHA-256 verified before VFS mount/init/load/join. This intentionally gives the local sandbox a selected-map VFS identity, rather than preloading every map.
- `SoldatMap` preserves straight-alpha image inputs, a single GPU PMA upload, native vertex PMA and source-over blending, NPOT terrain repeat, absolute prop/edge rotation centers, world-anchored gradient and native layer order. Animation quads, batches, input/event buffers and render skeleton arrays are reused. Terrain/edge mipmaps follow the setting; atlas sprites stay base-level to prevent cross-sprite mip bleeding.
- Phaser Sound is unlocked by user gesture. The 20-byte simulation event drain is wired and validates framing. Native Sound.pas distance attenuation, volume conversion and positional pan coordinates are ported. **No sound event kind/sample/emitter mapping exists yet**; presentation kinds are explicitly counted as unmapped, not interpreted as sounds. Phase-1 `fx_step` explicitly returns unsupported, so sparks/weather are unavailable rather than substituted.
- React teardown is serialized with Phaser's asynchronous destroy. DOM listeners, resize observers and owned GL textures/buffers/programs are cleaned up; retained CPU sources restore the custom renderer on context restoration.

## Rendering and G2 evidence

`/?map=Airpirates&capture` is a deterministic **map-only capture mode**, not a gameplay mode. It uses camera `(0,0,0)`, first scenery frames and mipmaps off, matching the spike fixture. The capture command uses 1280×720/DPR1, compares `tests/fixtures/render/client-Airpirates.png` against `phaser-Airpirates.png`, and fails above **0.1% pixels with any channel difference >8/255**. It also exercises catalog/notices, persisted settings/rebinding, explicit audio gesture and three complete React game remounts. Machine-readable results are written to `tests/fixtures/render/client-results.json`.

See `docs/gates/G2-client.md` for exercised results and qualifications. G2 is **not passed** until G1 supplies the qualified real module and Node receipts: movement-corpus hashes through the rendered client loop at 60/120/144 Hz, sim-driven soldier visual fixtures, and the recorded native side-by-side Arena/Airpirates session remain required. The clock's synthetic invariant checks do not certify simulation determinism.
