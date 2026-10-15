#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then echo 'Usage: tools/oracle/run.sh FIXTURE OUT-TRACE' >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
fixture=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
mkdir -p "$(dirname "$2")"
out_dir=$(cd "$(dirname "$2")" && pwd)
out_name=$(basename "$2")
image=${ORACLE_IMAGE:-soldat-web/fpc:bcd7288}
platform=${ORACLE_PLATFORM:-linux/arm64}
if [[ ! -x "$root/build-out/oracle/cmake/bin/opensoldatserver" ]]; then
  "$root/tools/oracle/build.sh"
fi
docker run --rm --network none --platform "$platform" \
  -v "$root/build-out/oracle:/work:ro" -v "$fixture:/fixture.json:ro" \
  -v "$out_dir:/output" -w /work/runtime \
  -e LD_LIBRARY_PATH=/work/cmake/bin "$image" \
  /work/cmake/bin/opensoldatserver /fixture.json "/output/$out_name" \
  /work/base/soldat.smod /work/runtime
