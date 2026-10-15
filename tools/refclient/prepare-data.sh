#!/bin/sh
# Run from repository root. Merge base assets only into the isolated runtime tree.
set -eu
mkdir -p build-out/refclient/data
# ditto preserves the source bytes and does not write to reference/.
ditto reference/base/shared build-out/refclient/data
ditto reference/base/client build-out/refclient/data
cp reference/base/play-regular.ttf build-out/refclient/data/play-regular.ttf
# Local mounts use the isolated data tree as UserDirectory; all generated
# configs/logs/screens therefore remain under build-out/refclient.
