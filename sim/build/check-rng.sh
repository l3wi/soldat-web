#!/usr/bin/env bash
# Build/run the same System-versus-SimRandom corpus on native and wasm.
# Usage: bash sim/build/check-rng.sh [all|native|wasm|linux]
# all also compares the two JSON transcripts, including every result's hash.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${RNG_OUT:-$ROOT/build-out/sim/rng-conformance}"
TARGET="${1:-all}"
PIN=bcd728860dcd953cb6f3bbda788eab07b0d16c85
if [[ "$TARGET" == linux ]]; then
  if [[ "$OUT" != "$ROOT/"* ]]; then
    printf 'Linux RNG_OUT must be inside repository bind mount: %s\n' "$OUT" >&2
    exit 2
  fi
  mkdir -p "$OUT/linux/tmp" "$OUT/linux/home"
  # No network, image changes, or Docker cleanup. All writes use the host mount.
  exec docker run --rm --network none -v "$ROOT:/work" \
    -e FPC=fpc -e FPC_PIN_FILE=/opt/fpc/COMMIT \
    -e RNG_OUT="/work/${OUT#"$ROOT/"}/linux" \
    -e TMPDIR="/work/${OUT#"$ROOT/"}/linux/tmp" \
    -e HOME="/work/${OUT#"$ROOT/"}/linux/home" \
    -w /work soldat-web/fpc:bcd7288 bash sim/build/check-rng.sh native
fi
if [[ "$TARGET" != all && "$TARGET" != native && "$TARGET" != wasm ]]; then
  printf 'Usage: %s [all|native|wasm|linux]\n' "$0" >&2
  exit 2
fi
FPC="${FPC:-$ROOT/sim/build/.toolchain/bin/compile}"
FPC_PIN_FILE="${FPC_PIN_FILE:-$ROOT/sim/build/.toolchain/COMMIT}"
if [[ ! -r "$FPC_PIN_FILE" || "$(cat "$FPC_PIN_FILE")" != "$PIN" ]]; then
  printf 'Pinned compiler marker missing/mismatched: %s\n' "$FPC_PIN_FILE" >&2
  exit 1
fi
if [[ ! -x "$FPC" ]] && ! command -v "$FPC" >/dev/null 2>&1; then
  printf 'Pinned FPC unavailable: %s\nRun sim/build/setup-toolchain-macos.sh first.\n' "$FPC" >&2
  exit 1
fi
SRC="$ROOT/sim/opensoldat/sim"
COMMON=(-B -MDelphi -Scgi -O3 -Fu"$SRC")
mkdir -p "$OUT"
if [[ "$TARGET" == all || "$TARGET" == native ]]; then
  NATIVE_TARGET="$("$FPC" -iTP)-$("$FPC" -iTO)"
  mkdir -p "$OUT/$NATIVE_TARGET-units"
  "$FPC" "${COMMON[@]}" -FU"$OUT/$NATIVE_TARGET-units" \
    -FE"$OUT" -o"$OUT/random-conformance-native" "$SRC/RandomConformance.lpr"
fi
if [[ "$TARGET" == all || "$TARGET" == wasm ]]; then
  mkdir -p "$OUT/wasm-units"
  "$FPC" -Twasip1 -Pwasm32 "${COMMON[@]}" -FU"$OUT/wasm-units" \
    -FE"$OUT" -o"$OUT/random-conformance.wasm" "$SRC/RandomConformance.lpr"
  node "$ROOT/sim/build/normalize-wasm-name.mjs" "$OUT/random-conformance.wasm" random-conformance.wasm
fi
case "$TARGET" in
  native) "$OUT/random-conformance-native" ;;
  wasm) node "$ROOT/sim/build/check-rng.mjs" "$OUT/random-conformance.wasm" ;;
  all) node "$ROOT/sim/build/check-rng.mjs" "$OUT/random-conformance.wasm" "$OUT/random-conformance-native" ;;
esac
