#!/usr/bin/env bash
# Build the patched pinned native backend without changing the Docker image.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMIT=bcd728860dcd953cb6f3bbda788eab07b0d16c85
if [[ $# != 2 ]]; then
  printf 'Usage: %s OUTPUT_DIRECTORY PINNED_FPC_CHECKOUT\n' "$0" >&2
  exit 2
fi
OUT="$1"
SOURCE="$2"
[[ "$OUT" == /* ]] || OUT="$ROOT/$OUT"
if [[ "$OUT" != "$ROOT/"* || -e "$OUT/source" ]]; then
  printf 'Output must be a fresh directory inside the repository: %s\n' "$OUT" >&2
  exit 2
fi
[[ "$(git -C "$SOURCE" rev-parse HEAD)" == "$COMMIT" ]]
mkdir -p "$OUT/source" "$OUT/tmp" "$OUT/home"
# Archive the pinned tree, not any unrelated edits in the bootstrap checkout.
git -C "$SOURCE" archive "$COMMIT" | tar -x -C "$OUT/source"
patch -p1 -d "$OUT/source" -i "$ROOT/sim/build/patches/fpc-aarch64-unaligned-smallint.patch"
CONTAINER_OUT="/repo/${OUT#"$ROOT/"}"
docker run --rm --network none --read-only --platform linux/arm64 \
  -v "$ROOT:/repo" -w "$CONTAINER_OUT/source/compiler" \
  -e TMPDIR="$CONTAINER_OUT/tmp" -e HOME="$CONTAINER_OUT/home" \
  "${SIM_COMPILER_IMAGE:-soldat-web/fpc:bcd7288}" \
  make -j"${JOBS:-4}" compiler PP=/opt/fpc/compile OPT=-O-
# Resolve the backend relative to this wrapper so either /repo or /work mounts
# can use the identical binary. The unchanged pinned RTL stays in the image.
cat > "$OUT/compile" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/source/compiler/ppca64" -n '-Fu/opt/fpc/lib/fpc/3.3.1/units/$fpctarget/*' "$@"
WRAPPER
chmod +x "$OUT/compile"
printf '%s\n' "$COMMIT" > "$OUT/COMMIT"
shasum -a 256 "$ROOT/sim/build/patches/fpc-aarch64-unaligned-smallint.patch" | cut -d ' ' -f 1 > "$OUT/PATCH_SHA256"
shasum -a 256 "$OUT/source/compiler/ppca64" | cut -d ' ' -f 1 > "$OUT/COMPILER_SHA256"
shasum -a 256 "$ROOT/sim/build/patches/fpc-aarch64-unaligned-smallint.patch" "$OUT/source/compiler/ppca64"
