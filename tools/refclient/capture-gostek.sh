#!/bin/sh
# Native sixteen-soldier gallery at the browser spike's fixed t=1s snapshot.
set -eu
export REFCLIENT_GOSTEK=1
export REFCLIENT_POSES="$(pwd)/build-out/refclient/gostek-poses.json"
exec sh tools/refclient/capture.sh Airpirates tests/fixtures/render/native-Gostek.png
