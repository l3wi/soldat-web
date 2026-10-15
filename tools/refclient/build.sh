#!/bin/sh
# macOS arm64, invoked from repository root. Never compiles inside reference/.
set -eu
root=$(pwd)
source="$root/build-out/refclient/source"
cmake="$root/build-out/refclient/cmake"
mkdir -p "$root/build-out/refclient"
# Refresh only upstream tracked files; downloaded GNS remains in the isolated copy.
ditto "$root/reference/opensoldat" "$source"
patch -d "$source" -p1 -i "$root/tools/refclient/patches/001-fixed-map-view.patch"
patch -d "$source" -p1 -i "$root/tools/refclient/patches/003-gostek-gallery.patch"
cp tools/refclient/ReferenceGostek.inc "$source/client/ReferenceGostek.inc"
cmake -S "$source" -B "$cmake" \
  -DBUILD_SERVER=OFF -DADD_ASSETS=OFF -DCMAKE_BUILD_TYPE=Release \
  -DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3 \
  -DCMAKE_PREFIX_PATH=/opt/homebrew -DCMAKE_Pascal_FLAGS=-Fl/opt/homebrew/lib
gns="$source/shared/libs/GameNetworkingSockets/build/gns_download"
compat="$root/tools/refclient/patches/002-protobuf-string-view.patch"
# GNS is fetched by configure, so its compatibility patch runs afterward.
# Repeated builds retain the fetched tree; a reverse check distinguishes that
# state from a genuine patch failure without silently swallowing errors.
if patch -d "$gns" -p1 -R --dry-run -i "$compat" >/dev/null 2>&1; then
  :
else
  patch -d "$gns" -p1 -i "$compat"
fi
cmake --build "$cmake" --parallel 4
sh tools/refclient/prepare-data.sh
python3 tools/refclient/make-synthetic.py
