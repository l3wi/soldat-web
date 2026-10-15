#!/bin/sh
# Rendering-only galleries using original native drawing; never gameplay proof.
# Prerequisite: sh tools/refclient/build-combat.sh on an interactive macOS desktop.
set -eu
root=$(pwd)
mkdir -p "$root/tests/fixtures/render" "$root/build-out/refclient"
unset REFCLIENT_GOSTEK REFCLIENT_POSES
for mode in objects hud hud-reload hud-full; do
  export REFCLIENT_COMBAT="$mode"
  export REFCLIENT_COMBAT_JSON="$root/build-out/refclient/combat-gallery-$mode.json"
  sh tools/refclient/capture.sh Airpirates "tests/fixtures/render/combat-native-$mode.png" 0 0 0
done
node --input-type=module -e '
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const modes = ["objects", "hud", "hud-reload", "hud-full"], captures = [];
for (const mode of modes) {
  const image = `tests/fixtures/render/combat-native-${mode}.png`;
  const state = `build-out/refclient/combat-gallery-${mode}.json`;
  captures.push({ mode, image, state, imageSha256: hash(await readFile(image)), stateSha256: hash(await readFile(state)) });
}
const executableSha256 = hash(await readFile("build-out/refclient/cmake/bin/opensoldat"));
const helperSha256 = hash(await readFile("tools/refclient/ReferenceCombat.inc"));
await writeFile("build-out/refclient/combat-capture.json", JSON.stringify({
  version: 1, source: "original-native-renderer", renderingOnly: true,
  executableSha256, helperSha256, capturedAt: new Date().toISOString(), captures
}, null, 2) + "\n");
'
