#!/usr/bin/env bash
set -euo pipefail
start=$SECONDS
pin=bf43a43bdd7a069e02c906768807f66e621b2888
base_pin=5b6e5bef23f5c0d58fb1d4d887b9b94ebcf799b4
fpc=${FPC:-fpc}
mkdir -p /work/compiler-check
"$fpc" -MDelphi -Scgi -O3 -OoREGVAR -FU/work/compiler-check \
  -FE/work/compiler-check -o/work/compiler-check/check-signed-loads /repo/sim/build/check-signed-loads.pas
/work/compiler-check/check-signed-loads
[[ $(git -c safe.directory=/repo/reference/opensoldat -C /repo/reference/opensoldat rev-parse HEAD) == "$pin" ]]
[[ $(git -c safe.directory=/repo/reference/base -C /repo/reference/base rev-parse HEAD) == "$base_pin" ]]
# GNS FetchContent writes below its source directory; never build in reference/.
mkdir -p /work/source /work/base /work/runtime/configs
git -c safe.directory=/repo/reference/opensoldat -C /repo/reference/opensoldat archive "$pin" | tar -x -C /work/source
git -c safe.directory=/repo/reference/base -C /repo/reference/base archive "$base_pin" | tar -x -C /work/base
cd /work/source
git apply --recount /repo/tools/oracle/patches/0001-oracle-entry-and-stage-hooks.patch
cp /repo/tools/oracle/OracleHarness.pas server/OracleHarness.pas
cp /repo/tools/oracle/OracleTrace.inc server/OracleTrace.inc
cp /repo/sim/opensoldat/sim/CombatDiagnostics.pas server/CombatDiagnostics.pas
cmake -S /work/source -B /work/cmake \
  -DBUILD_CLIENT=OFF -DBUILD_SERVER=ON -DBUILD_SCRIPTCORE=OFF -DBUILD_RCON=OFF \
  -DBUILD_STEAM=OFF -DADD_ASSETS=OFF -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_Pascal_COMPILER="$fpc" -DCMAKE_Pascal_FLAGS=-dORACLE
cmake --build /work/cmake --target opensoldatserver -j4
cd /work/base
python3 create_smod.py
cp server/configs/weapons.ini /work/runtime/configs/weapons.ini
printf 'oracle build seconds: %s\n' "$((SECONDS - start))"
"$fpc" -iV
sha256sum /work/cmake/bin/opensoldatserver /work/base/soldat.smod
