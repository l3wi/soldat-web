#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FPC="${FPC:-$ROOT/sim/build/.toolchain/bin/compile}"
if [[ ! -x "$FPC" ]]; then FPC=fpc; fi
OUT="${SPIKE_OUT:-$ROOT/build-out/spike}"
NATIVE_TARGET="$("$FPC" -iTP)-$("$FPC" -iTO)"
# Every target gets separate PPU/object files. Units are the unchanged vendored
# copies of reference/opensoldat @bf43a43, so a clean checkout needs no reference/.
mkdir -p "$OUT/wasm-units" "$OUT/$NATIVE_TARGET-units"
cd "$ROOT/sim/build/spike"
COMMON=(-B -MDelphi -Scgi -O2 -Fu. -Fu"$ROOT/sim/opensoldat/shared")
"$FPC" -Twasip1 -Pwasm32 "${COMMON[@]}" -FU"$OUT/wasm-units" \
  -FE"$OUT" -o"$OUT/spike.wasm" spike.lpr
node "$ROOT/sim/build/normalize-wasm-name.mjs" "$OUT/spike.wasm" spike.wasm
"$FPC" "${COMMON[@]}" -FU"$OUT/$NATIVE_TARGET-units" \
  -FE"$OUT" -o"$OUT/spike-native" spike_native.lpr
