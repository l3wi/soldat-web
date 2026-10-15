#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
image=${ORACLE_IMAGE:-soldat-web/fpc:bcd7288}
platform=${ORACLE_PLATFORM:-linux/arm64}
mkdir -p "$root/build-out/oracle/tmp"
docker run --rm --platform "$platform" \
  -v "$root:/repo:ro" -v "$root/build-out/oracle:/work" \
  -e TMPDIR=/work/tmp -e HOME=/work -w /work "$image" bash /repo/tools/oracle/build-in-container.sh
