#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then echo 'Usage: tools/oracle/run.sh FIXTURE OUT-TRACE' >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
fixture=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
mkdir -p "$(dirname "$2")"
out_dir=$(cd "$(dirname "$2")" && pwd)
out_name=$(basename "$2")
mkdir -p "$out_dir/tmp" "$out_dir/home"
image=${ORACLE_IMAGE:-soldat-web/fpc:bcd7288}
platform=${ORACLE_PLATFORM:-linux/arm64}
if [[ ! -x "$root/build-out/oracle/cmake/bin/opensoldatserver" ]]; then
  "$root/tools/oracle/build.sh"
fi
docker run --rm --network none --read-only --platform "$platform" \
  -v "$root/build-out/oracle:/work:ro" -v "$fixture:/fixture.json:ro" \
  -v "$(dirname "$fixture"):/fixture-maps:ro" \
  -v "$root/dist/content/sim:/sim-content:ro" \
  -v "$out_dir:/output" -w /output/home \
  -e TMPDIR=/output/tmp -e HOME=/output/home \
  -e LD_LIBRARY_PATH=/work/cmake/bin "$image" \
  /work/cmake/bin/opensoldatserver /fixture.json "/output/$out_name" \
  /work/base/soldat.smod /work/runtime
