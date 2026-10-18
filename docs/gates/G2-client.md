# G2 client integration — partial evidence, not a gate pass

> **Historical client-shell evidence:** results and commands apply only to the implementation and artifacts recorded here, including the explicitly unavailable simulation. They are not current product qualification. Use [development](../development.md) for current workflows and [porting status](../porting-status.md) for current implementation and qualification.

Date: 2026-10-15.
**Historical shell-only evidence.** The later [G2 integration record](G2.md) supersedes the pending-G1 statements below and records the actual rendered-loop qualification and manual-session status.


**G2 remains PENDING G1.** This records the exercised production-client shell, static rendering and timing boundaries only. No original-simulation movement hash, native side-by-side gameplay, or sim-driven soldier visual qualification is claimed.

## Exercised

From the repository root:

```sh
bun install
bun run --cwd packages/client check
bun run --cwd packages/client build
bun run --cwd packages/client verify
bun run --cwd packages/client dev --port 5195 --strictPort
# With that server running:
bun run --cwd packages/client capture
```

- **Strict TypeScript: PASS.** An initial strict check exposed a shared sim-host generic assertion error; correcting the assertion allowed the integrated check to pass.
- **Production Vite build: PASS.** Vite 7.1.7, React 19.2.4, Phaser 4.2.1 exact; output `dist/client`. Vite reports an ordinary 1.94 MB minified large-chunk warning.
- **Client invariants: PASS.** Synthetic clock drivers at 60/120/144 Hz each produce exactly 600 fixed steps over ten seconds. Four-tick catch-up cap, discarded overload debt, reset/resume, camera logical dimensions and mouse/world round trips, quarter-step zoom, original sound attenuation/pan formulas, event framing/unmapped-kind counts, default flag binding and native absolute map pivot were exercised. These synthetic checks do not run or certify the game simulation.
- **Actual Chrome headless visual parity: PASS.** Installed Chrome 155.0.8059.79, 1280×720/DPR1, camera `(0,0,0)`, linear filtering, mipmaps/dither/MSAA off, map-only first-frame scenery. `client-Airpirates.png` versus the retained `phaser-Airpirates.png`: **0 / 921,600 pixels differ by >8 in any RGBA channel (0%); maximum channel delta 0**. Required threshold is ≤0.1%. The image was also visually inspected.
- **Browser shell/lifecycle: PASS for the exercised finite sequence.** All 99 imported maps listed; four served notice texts loaded; nearest filtering, mipmaps off and a left-key rebind persisted to localStorage; explicit audio unlock gesture resolved; three React start→menu→start cycles retained one mounted canvas and removed it on return to menu; no browser page errors. This is not a heap soak or a complete resource-leak proof.

Artifacts:

- [Client screenshot](../../tests/fixtures/render/client-Airpirates.png)
- [Machine-readable browser results](../../tests/fixtures/render/client-results.json)
- [Retained spike baseline](../../tests/fixtures/render/phaser-Airpirates.png)
- [Client commands and runtime boundaries](../../packages/client/README.md)

## Implemented but unqualified until G1

The sandbox loads `/sim.wasm`, verifies imported core/raw selected-map content, initializes the original sim, joins one player, submits persistent 12-byte inputs and steps through the fixed client clock. `SimWorldView` imports sim-host `RENDER_LAYOUT` and `RenderView`; it only reads simulation memory and reuses client arrays. The gostek renderer interpolates actual previous/current world-space skeletons and preserves the source 131-part table/normalized pivots, not the spike's temporary TypeScript pose evaluator or demonstration AK74 loadout.

At this check, **`build-out/sim/sim.wasm` and Node movement receipts were absent**. The ordinary sandbox therefore rendered the map with an explicit simulation-unavailable notice and no fake soldier. The deterministic screenshot route intentionally disables simulation even when a module is present.

The movement ABI currently returns `-4` for cosmetics and provides no sound-kind/sample/emitter mapping. The scene calls `fx_step` until unsupported is reported; the real 20-byte event drain counts unmapped presentation records. Phaser Web Audio is unlocked by gesture and native Sound.pas mathematical formulas are retained, but **actual positional SFX playback is not exercised or claimed**. Scope state and full combat/cosmetic appearance fields are likewise absent from the movement render ABI; the ordinary unscoped camera/native base-part rendering is documented rather than inventing unavailable state.

## Still required for G2

1. Qualified G1 module, complete movement corpus and authoritative Node receipts.
2. Replay **every movement fixture through the rendered client loop** at 60/120/144 Hz, including Arena, and compare every tick's hash to the Node/oracle qualification. The synthetic clock checks above are not substitutes.
3. Re-run the rendering fixtures with actual sim-driven soldier states; static Airpirates parity alone does not certify all SPEC §6.3 states/maps.
4. Record the manual native OpenSoldat side-by-side session on Arena and Airpirates.
5. Any client-specific context-loss/restore, broader browser/performance or long-duration memory qualification not exercised here remains unclaimed. The retained G0.4 spike evidence is a reference, not production-client evidence.

Do not mark PLAN Phase 2's G2 gate as passed based on this partial record.
