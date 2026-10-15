#!/usr/bin/env bash
# Native + wasm32-wasip1 flow adapted from humanova/soldat-web (MIT).
# See NOTICE alongside this file. Intentionally no C-object linker patch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec docker build "$@" -t soldat-web/fpc:bcd7288 -f "$ROOT/sim/build/Dockerfile" "$ROOT/sim/build"
