# Maintained OpenSoldat simulation core

This is the dependency-pruned, locally adapted simulation source derived from
OpenSoldat `bf43a43bdd7a069e02c906768807f66e621b2888`. It is not a complete native
OpenSoldat client/server checkout. The unchanged native launcher, renderer,
network stack and unused third-party dependencies are available in the optional
pristine upstream submodule instead.

## Maintained source

- `shared/` and `shared/mechanics/`: required original units and includes, with
  the extraction/gameplay changes recorded in the
  [role-divergence ledger](../../docs/role-divergence-ledger.md).
- `sim/`: WASM/native entry points, host adapters, state/render/event boundaries,
  deterministic RNG, VFS, presentation bridges and conformance helpers.
- `LICENSE.md`, `CONTRIBUTORS.md` and per-file headers: retained upstream rights
  and attribution. `shared/Vector.pas` retains its separate licensing notice.

Keep product changes here. Do not replace this tree with an unmodified upstream
checkout: the maintained units contain the port's real simulation adaptations.

## Build

From the repository root with the pinned compiler installed:

```sh
bash sim/build/build-sim.sh all
```

This writes `build-out/sim/sim.wasm` and `build-out/sim/sim-native`. Use `SIM_OUT`
to build into a separate output directory without replacing a running game's
artifact. The core builds without initializing upstream reference submodules;
simulation execution still requires imported content. See the
[development guide](../../docs/development.md) for compiler, content and
qualification prerequisites.

The production browser/server consume the compiled WASM; this Pascal source
tree is not copied into their runtime packages.

## Optional pristine references

The complete baseline and original assets are pinned Git submodules:

```sh
git submodule update --init -- reference/opensoldat reference/base
bun scripts/check-pins.ts --require-references
```

Do not initialize recursively or modify these checkouts for product work.
Content import, native-reference capture and oracle workflows use them as
read-only inputs. Frontend/server work with prepared WASM and content can leave
them uninitialized.

Pruning the maintained tree does not discard unported native functionality:
the pinned upstream source remains available for comparison and future porting.
The [porting status](../../docs/porting-status.md) separates missing features,
deliberate adaptations and unqualified acceptance criteria.
