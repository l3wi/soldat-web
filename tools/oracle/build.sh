#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
bun "$root/scripts/check-pins.ts" --require-references
image=${ORACLE_IMAGE:-soldat-web/fpc:bcd7288}
platform=${ORACLE_PLATFORM:-linux/arm64}
fpc=${FPC:-fpc}
if [[ "$fpc" == "$root/"* ]]; then
  fpc="/repo/${fpc#"$root/"}"
fi
mkdir -p "$root/build-out/oracle/tmp"
docker run --rm --platform "$platform" \
  -v "$root:/repo:ro" -v "$root/build-out/oracle:/work" \
  -e FPC="$fpc" -e TMPDIR=/work/tmp -e HOME=/work -w /work "$image" bash /repo/tools/oracle/build-in-container.sh
