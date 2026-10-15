# Draft upstream report: AArch64 signed SmallInt loads lose sign extension

Status: local reproduction and backend correction validated; not submitted upstream.

## Affected compiler

- Free Pascal 3.3.1, source commit `bcd728860dcd953cb6f3bbda788eab07b0d16c85`.
- Observed target: `aarch64-linux`, using `soldat-web/fpc:bcd7288`.
- Installed bootstrap backend SHA-256: `0d7a44ea6ce66e10aed00c60ede229e4b4eb5525ef1d53214605dc0f26f58aa9`.
- Reproduced with packed signed 16-bit fields at `-O3`, `-O2`, and `-O-`; enabling range/overflow checks did not correct it.
- The native backend's Darwin path bypasses this unaligned-load routine. This report does not claim a reproduced Darwin runtime failure. The WASM backend is not changed by the correction.

## Reproduction and expected behavior

The checked-in regression is `sim/build/check-signed-loads.pas`. It reads packed signed 8-, 16-, and 32-bit fields, checking their values and comparisons with zero and one. Each width includes its minimum, `-1`, zero, one, and maximum: 15 cases total. The packed record is passed by reference to a non-inline checking procedure so comparisons read fields rather than constant-folding assignments.

Compile it with the affected Linux compiler:

```sh
fpc -MDelphi -Scgi -O3 -OoREGVAR check-signed-loads.pas
./check-signed-loads
```

Observed failure, exit status 1:

```text
Signed packed load regression: S16 > 0 is incorrect for -32768
```

A separate packed-object reproducer using `-1` printed:

```text
value=-1 positive=TRUE negative=FALSE belowone=FALSE aboveone=TRUE
branch positive
```

An ordinary aligned-object control produced the correct comparisons. Printing the value is not sufficient to detect this defect: widening a signed field for the text writer can introduce the sign extension omitted by a direct narrow comparison.

## Code generation root cause

In `tcgaarch64.a_load_ref_reg_unaligned`, signed/unsigned 16- and 32-bit loads are reconstructed using unsigned byte or halfword loads and `BFI`. The final conversion is delegated to `a_load_reg_reg(fromsize, tosize, ...)`.

When both sizes are `OS_S16`, the register-to-register helper assumes the source register already contains a correctly sign-extended signed value. It can therefore emit only a move. That assumption is false for the preceding unsigned reconstruction. A subsequent signed 32-bit comparison sees `65535` instead of `-1`.

The affected game comparison generated:

```asm
ldrb w0,[x23, #50]
ldrb w1,[x23, #51]
bfi  w0,w1,#8,#8
cmp  w0,#0
b.gt <reject-pickup>
```

The value writer, by contrast, generated `sxth` before writing the same field. This accounts for the apparently contradictory `value=-1` and `positive=TRUE` observations.

## Minimal backend correction

`sim/build/patches/fpc-aarch64-unaligned-smallint.patch` adjusts only the affected unaligned-load conversion. If both requested sizes are `OS_S16`, it describes the reconstructed source as `OS_16`. The existing unsigned-to-signed register conversion then emits `SXTH`. Both byte- and halfword-reconstruction paths are covered; other widths and wider destination conversions retain their existing behavior.

Patch SHA-256:

```text
23b747af32be85bcce75c9fcfa76e3681ddccdd83ad1f6d811bf5ecf04f5b1d9
```

No simulation arithmetic, collision/control branch, fixture, predicate, comparison threshold, or presentation-event requirement was changed.

## Validation

The isolated patched Linux backend was built with the original pinned compiler, `OPT=-O-`, from a clean archive of the same pinned source commit plus this patch. Its SHA-256 is:

```text
34fe4c38127fe7552a6c027f715dff2553d657858815cdfd165280f50d55e8b4
```

With that backend and `-O3 -OoREGVAR`, the checked-in regression completed successfully:

```json
{"status":"pass","check":"signed-packed-loads","widths":[8,16,32],"cases":15}
```

The installed image compiler and Docker image were not changed. The bootstrap source, compiler outputs, temporary files, and HOME were confined to the repository's host-bound defect directory. The overlay uses the image's unchanged pinned RTL.

### Integration

- `sim/build/build-sim.sh` runs the regression before every native simulation build.
- Oracle builds run the same regression and accept the same compiler through `FPC` and `CMAKE_Pascal_COMPILER`.
- Linux simulation/oracle entrypoints translate a repository-hosted absolute `FPC` path into their respective container mounts.
- The Dockerfile applies the checked-in patch when building a future image, retaining the original compiler commit and recording the patch digest.
- The macOS bootstrap entrypoint applies and identifies the same patch; its rebuild and cross-WASM byte-identity check are separate qualification steps.

To build an isolated Linux overlay without modifying an installed toolchain or Docker image:

```sh
bash sim/build/build-linux-compiler.sh \
  build-out/sim/g3/defect-thing-target/toolchain \
  /tmp/soldat-fpc-bcd7288-macos-src
```

The output directory must be fresh. The source checkout must identify the pinned commit; the builder archives committed bytes rather than copying working-tree changes. The original driver requires its configured wrapper (`/opt/fpc/compile`) during bootstrap so its pinned unit search paths are retained.

Use the resulting compiler for subsequent builds:

```sh
export FPC="$PWD/build-out/sim/g3/defect-thing-target/toolchain/compile"
SIM_OUT="$PWD/build-out/sim/g3/defect-thing-target/rebuilt" \
  bash sim/build/build-sim.sh linux
bash tools/oracle/build.sh
```

These final simulation/oracle build commands are handoff instructions, not a claim that they were executed as part of this investigation.

## Game-level evidence

The existing T2 artifacts show both ordering fixtures and both RNG policies have identical serialized hashes and source-trace states through tick 60. At tick 61, native and WASM differ only in the source trace's first Thing timeout and holding sprite: native `1489 / 0`, WASM `1499 / 2`.

A read-only observer compiled into a scratch copy of `Things.pas` established the native rejection inputs at tick 61:

- Radius: `19`.
- Sprite-2 distance: `13.275726320` (inside the radius).
- `CeaseFireCounter`: `-1`.
- The direct expression `CeaseFireCounter > 0`: incorrectly `TRUE`.
- Closest player after the unchanged loop: `-1`.
- Survival-end flag: false; game mode: DM (`0`).

Thus the fixture command successfully injected the signed sentinel; the target difference was a compiler-generated pickup rejection, not a missing injection or an altered bullet collision. The accepted sprite hit remained circle 10, and required collision observations were unchanged.

The affected ordinary sprite-array loop reaches the same backend path after strength reduction. Disabling only `STRENGTH` generated `LDRSH` and corrected the observed pickup; a targeted diagnostic run then matched all 360 frozen Node tick states and exact hash/event receipts for `ordering-player-before-thing` under the original RNG policy. This is supporting diagnosis, not the chosen fix: packed-field reproducers still fail without that optimization, so disabling it would avoid one manifestation rather than repair signed unaligned loads.

The final patched-compiler native/oracle recapture, both-policy ordering reruns, full qualification matrices, and same-source old/new cross-WASM byte comparison remain the qualification owner's responsibility. Existing native/oracle captures generated by the affected backend cannot establish correct signed-sentinel behavior by agreeing with each other.
