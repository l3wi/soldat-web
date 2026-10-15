#!/bin/sh
# Usage: sh tools/refclient/capture.sh MAP [OUTPUT.png] [CAMERA_X CAMERA_Y ZOOM]
# Captures the native GL framebuffer, not a desktop screenshot.
set -eu
map=${1:-Airpirates}
out=${2:-tests/fixtures/render/native-${map}.png}
x=${3:-0}
y=${4:-0}
z=${5:-0}
root=$(pwd)
case "$out" in /*) ;; *) out="$root/$out" ;; esac
mkdir -p "$(dirname "$out")"
export REFCLIENT_MAP="$map" REFCLIENT_SCREENSHOT="$out"
export REFCLIENT_X="$x" REFCLIENT_Y="$y" REFCLIENT_Z="$z"
export DYLD_LIBRARY_PATH="$root/build-out/refclient/cmake/bin:/opt/homebrew/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
# Trailing '-' flushes the upstream command-line parser's final cvar.
exec "$root/build-out/refclient/cmake/bin/opensoldat" \
  -fs_portable 0 -fs_localmount 1 \
  -fs_userpath "$root/build-out/refclient/data" \
  -fs_basepath "$root/build-out/refclient/data" -
