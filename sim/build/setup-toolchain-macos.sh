#!/usr/bin/env bash
# Native + WASI build flow adapted from humanova/soldat-web (MIT),
# tools/setup-fpc.sh @31bb3d5; full attribution in NOTICE. No linker patch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX="${FPC_PREFIX:-$ROOT/sim/build/.toolchain}"
SRC="${FPC_SRC:-/tmp/soldat-fpc-bcd7288-macos-src}"
COMMIT=bcd728860dcd953cb6f3bbda788eab07b0d16c85
JOBS="${JOBS:-4}"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This local setup targets macOS arm64; use build-image.sh for Linux.' >&2
  exit 1
fi
PP="${PP:-$(command -v fpc || true)}"
if [[ -z "$PP" ]]; then
  echo 'Install the bootstrap first: brew install fpc (3.2.2).' >&2
  exit 1
fi
if [[ -f "$PREFIX/COMMIT" && "$(cat "$PREFIX/COMMIT")" = "$COMMIT" \
      && -x "$PREFIX/bin/compile" && -x "$PREFIX/lib/fpc/3.3.1/ppcrosswasm32" ]]; then
  echo "Pinned toolchain already installed: $PREFIX/bin/compile"
  exit 0
fi
SDK="$(xcrun --show-sdk-path)"
if [[ ! -d "$SRC/.git" ]]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://gitlab.com/freepascal.org/fpc/source.git
fi
git -C "$SRC" fetch --depth 1 origin "$COMMIT"
git -C "$SRC" checkout --detach FETCH_HEAD
test "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT"
cd "$SRC"
make -j"$JOBS" all OPT="-O- -XR$SDK" PP="$PP"
make install INSTALL_PREFIX="$PREFIX"
make -j"$JOBS" all OS_TARGET=wasip1 CPU_TARGET=wasm32 BINUTILSPREFIX= \
  OPT="-O- -XR$SDK" PP="$PREFIX/lib/fpc/3.3.1/ppca64"
make crossinstall OS_TARGET=wasip1 CPU_TARGET=wasm32 BINUTILSPREFIX= \
  PP="$PREFIX/lib/fpc/3.3.1/ppca64" INSTALL_PREFIX="$PREFIX"
# Darwin's fpc driver intentionally omits "ross" in cross-backend names,
# while crossinstall writes ppcrosswasm32 on every host.
ln -sf ppcrosswasm32 "$PREFIX/lib/fpc/3.3.1/ppcwasm32"
printf '%s\n' "-Fu$PREFIX/lib/fpc/3.3.1/units/\$fpctarget/*" \
  '#IFDEF DARWIN' "-XR$SDK" "-Fl$SDK/usr/lib" '#ENDIF' > "$PREFIX/fpc.cfg"
printf '%s\n' '#!/bin/sh' \
  "export PATH=\"$PREFIX/lib/fpc/3.3.1:\$PATH\"" \
  "exec \"$PREFIX/bin/fpc\" -n @\"$PREFIX/fpc.cfg\" \"\$@\"" > "$PREFIX/bin/compile"
chmod +x "$PREFIX/bin/compile"
printf '%s\n' "$COMMIT" > "$PREFIX/COMMIT"
echo "Installed native aarch64-darwin + wasm32-wasip1: $PREFIX/bin/compile"
