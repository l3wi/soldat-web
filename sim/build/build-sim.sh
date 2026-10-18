#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${SIM_OUT:-$ROOT/build-out/sim}"
TARGET="${1:-all}"
if [[ "$TARGET" == linux ]]; then
  if [[ "$OUT" != "$ROOT/"* ]]; then
    printf 'Linux SIM_OUT must be inside repository bind mount: %s\n' "$OUT" >&2
    exit 2
  fi
  mkdir -p "$OUT/linux/tmp" "$OUT/linux/home"
  LINUX_FPC="${FPC:-fpc}"
  if [[ "$LINUX_FPC" == "$ROOT/"* ]]; then
    LINUX_FPC="/work/${LINUX_FPC#"$ROOT/"}"
  fi
  # The Docker VM can be full. All compiler outputs, temporary files and HOME
  # remain on the host bind mount; never remove user Docker data.
  exec docker run --rm --network none -v "$ROOT:/work" \
    -e FPC="$LINUX_FPC" -e SIM_OUT="/work/${OUT#"$ROOT/"}/linux" \
    -e TMPDIR="/work/${OUT#"$ROOT/"}/linux/tmp" \
    -e HOME="/work/${OUT#"$ROOT/"}/linux/home" \
    -w /work soldat-web/fpc:bcd7288 bash sim/build/build-sim.sh native
fi
if [[ "$TARGET" != all && "$TARGET" != native && "$TARGET" != wasm ]]; then
  printf 'Usage: %s [all|native|wasm|linux]\n' "$0" >&2
  exit 2
fi
FPC="${FPC:-$ROOT/sim/build/.toolchain/bin/compile}"
if [[ ! -x "$FPC" ]] && ! command -v "$FPC" >/dev/null 2>&1; then
  printf 'Pinned FPC unavailable: %s\nRun sim/build/setup-toolchain-macos.sh first.\n' "$FPC" >&2
  exit 1
fi
SRC="$ROOT/sim/opensoldat"
COMMON=(-B -MDelphi -Scgi -O3 -OoREGVAR -dSERVER -dSIM -dTESTING
  -Fi"$SRC/shared" -Fu"$SRC/sim" -Fu"$SRC/shared"
  -Fu"$SRC/shared/mechanics")
mkdir -p "$OUT"
if [[ "$TARGET" == all || "$TARGET" == wasm ]]; then
  mkdir -p "$OUT/wasm-units"
  "$FPC" -Twasip1 -Pwasm32 "${COMMON[@]}" -FU"$OUT/wasm-units" \
    -FE"$OUT" -o"$OUT/sim.wasm" "$SRC/sim/SimMain.lpr"
  node "$ROOT/sim/build/normalize-wasm-name.mjs" "$OUT/sim.wasm" sim.wasm
fi
if [[ "$TARGET" == all || "$TARGET" == native ]]; then
  NATIVE_TARGET="$("$FPC" -iTP)-$("$FPC" -iTO)"
  mkdir -p "$OUT/$NATIVE_TARGET-units"
  # Fail before compiling mechanics if this backend mishandles signed packed
  # loads. See patches/fpc-aarch64-unaligned-smallint.patch for the pinned fix.
  "$FPC" "${COMMON[@]}" -FU"$OUT/$NATIVE_TARGET-units" \
    -FE"$OUT" -o"$OUT/check-signed-loads" "$ROOT/sim/build/check-signed-loads.pas"
  "$OUT/check-signed-loads"
  "$FPC" "${COMMON[@]}" -FU"$OUT/$NATIVE_TARGET-units" \
    -FE"$OUT" -o"$OUT/sim-native" "$SRC/sim/SimNative.lpr"
fi
