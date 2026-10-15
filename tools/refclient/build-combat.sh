#!/bin/sh
# Run from repository root. Existing map/gostek build remains independently usable.
set -eu
sh tools/refclient/build.sh
root=$(pwd)
source="$root/build-out/refclient/source"
patch -d "$source" -p1 -i "$root/tools/refclient/patches/004-combat-gallery.patch"
cp tools/refclient/ReferenceCombat.inc "$source/client/ReferenceCombat.inc"
cmake --build "$root/build-out/refclient/cmake" --parallel 4
