# Native render reference

Local macOS arm64 OpenSoldat map-view reference for the G0.4 renderer spike. This is the checked-out **OpenSoldat** renderer, not a claim of classic Soldat pixel identity. Native build and capture succeeded on 2026-10-15; no fallback renderer was used. No browser comparison or other package verification was run here.

## Build and capture

Run from the repository root on an interactive macOS desktop:

```sh
# Coordinate compiler installation with the Toolchain agent when applicable.
brew install fpc cmake sdl2 openal-soft freetype physfs protobuf openssl@3
sh tools/refclient/build.sh

sh tools/refclient/capture.sh Airpirates
sh tools/refclient/capture.sh Aero
sh tools/refclient/capture.sh DesertWind
sh tools/refclient/capture.sh Jungle
sh tools/refclient/capture.sh inf_Biologic
sh tools/refclient/capture.sh ctf_Death
sh tools/refclient/capture.sh Synthetic
sh tools/refclient/capture-gostek.sh
```

`build.sh` was exercised successfully, including repeat use of the existing isolated GNS download. It copies upstream source with `ditto`, applies the viewer/gallery patches and copies `ReferenceGostek.inc`, configures CMake, patches the downloaded GNS compatibility issue, builds the native client, copies base data into the isolated runtime, and generates the synthetic PMS. It never compiles or patches anything under `reference/`. CMake fetches pinned GNS v1.4.1 on the first configuration; other assets are local.

The executable is `build-out/refclient/cmake/bin/opensoldat` (observed Mach-O 64-bit arm64). `source/` and `cmake/` beneath `build-out/refclient/` contain generated/compiled files. `data/` merges the unmodified bytes from `reference/base/shared`, `reference/base/client`, and `play-regular.ttf`. It is a copy, **not a symlink back into reference**, because the native client writes configs/logs/screens below its user directory. No server, network connection, sound initialization, or gameplay simulation is needed for capture.

Capture syntax:

```sh
sh tools/refclient/capture.sh MAP [OUTPUT.png] [CAMERA_X CAMERA_Y ZOOM]
# Example alternate scene, not part of the committed fixed-camera set:
sh tools/refclient/capture.sh Airpirates build-out/refclient/alternate.png 200 -100 0.5
```

The wrapper sets `DYLD_LIBRARY_PATH` to the isolated CMake `bin` directory and `/opt/homebrew/lib`; upstream dylib install names otherwise point at an app-bundle Frameworks directory. It passes explicit isolated `fs_userpath` and `fs_basepath`, disables portable mode, and enables the local mount. The trailing `-` is intentional: upstream `ParseCommandLine` flushes its last accumulated command only on the next option.

For debugging, the exercised first capture command was:

```sh
env REFCLIENT_MAP=Airpirates \
  REFCLIENT_SCREENSHOT="$PWD/build-out/refclient/native-Airpirates.png" \
  DYLD_LIBRARY_PATH="$PWD/build-out/refclient/cmake/bin:/opt/homebrew/lib" \
  build-out/refclient/cmake/bin/opensoldat \
  -fs_portable 0 -fs_localmount 1 \
  -fs_userpath "$PWD/build-out/refclient/data" \
  -fs_basepath "$PWD/build-out/refclient/data" -
```

That exploratory image was removed after the final smooth-edge captures superseded it.

## Reference settings and outputs

`patches/001-fixed-map-view.patch` adds an environment-selected branch to ordinary native initialization. It completes texture loading, uses native `GetMapInfo` and `Map.LoadMap`, sets old/current camera to the same coordinates, and invokes the existing `RenderFrame(0,1,True)`. `REFCLIENT_SCREENSHOT` saves through native `GfxSaveScreen` **before buffer presentation**, synchronously; this is a direct GL framebuffer PNG, not a cropped desktop screenshot. The process exits after that frame.

| Setting | Native value |
| --- | --- |
| Physical render and window | 1280 × 720 |
| Logical world height | 480 |
| Logical world width | 853 (`Round(Clamp(1280/720,1.25,1.78)*480)`) |
| Camera X, Y, ActualZoom | 0, 0, 0 for every final capture |
| World extent | `exp(ActualZoom) × (853,480)` |
| Texture filtering | Linear (`r_texturefilter=2`) |
| Mipmapping | Off |
| Smooth edges | **On for shipped maps; off for Synthetic** |
| Dithering, HUD, MSAA, action snap | Off |
| Animated prop time | Initial frame; prop updates disabled |
| Dynamic soldiers, bullets, sparks, things | None |

The native background remains its world-anchored gradient. Its span uses native `MAX_SECTOR=25` and the map's raw sector division, not a screen-fixed gradient.

Final PNGs are in `tests/fixtures/render/`:

- `native-Airpirates.png` — mixed per-vertex alpha.
- `native-Aero.png` — desert NPOT terrain/repeating UVs.
- `native-DesertWind.png` — desert NPOT terrain/repeating UVs.
- `native-Jungle.png` — layered scenery.
- `native-inf_Biologic.png` — 500 active props / 668 triangles (counts supplied by the RenderSpike corpus calculation).
- `native-ctf_Death.png` — 903 triangles (same corpus calculation).
- `native-Synthetic.png` — isolated vertex-alpha/repeat fixture.

No scene needed a camera adjustment. Fixed camera views are intentionally not full-map overview images and therefore do not necessarily show every prop at once. These static map captures do not demonstrate animated scenery timing. The dynamic-entity settings above describe map captures, not the separate gallery below.

### Synthetic fixture

`make-synthetic.py` writes only `build-out/refclient/data/maps/Synthetic.pms`; it does not edit a shipped map. It emits PMS v11 with one foreground triangle, no props or entities, solid `(32,32,32)` background, and `mtex_desert.bmp` resolved by the native PNG override to the original 1536 × 512 texture.

| Vertex | X, Y | RGBA | U, V |
| --- | --- | --- | --- |
| 1 | -240, -180 | 255,0,0,255 | -26.75,-27.25 |
| 2 | 240, -180 | 0,255,0,0 | 27.25,-27.25 |
| 3 | 0,180 | 0,0,255,128 | 0.25,28.75 |

The filename `Synthetic` selects edge suppression in the viewer patch. The fixture deliberately shares the browser spike's exact coordinates, colors, UVs, background and texture.

The final synthetic UV span explicitly exceeds both -26 and +26, independently of shipped map bounds. After the renderer integration supplied the corrected corpus ranges, only this generated fixture and its native capture were regenerated; the native executable did not need rebuilding.

### Native gostek gallery

`sh tools/refclient/capture-gostek.sh` writes `tests/fixtures/render/native-Gostek.png` and `build-out/refclient/gostek-poses.json`. `patches/003-gostek-gallery.patch` includes `ReferenceGostek.inc` in the isolated client. It clears the Airpirates polygon/edge/prop draw lists while retaining its original background gradient, populates sixteen native `TSprite` slots, and uses the unchanged native `RenderGostek`.

The top row is team 1, bottom team 2. Columns are run-right, run-left, aim, crouch, prone, jet, reload, dead; positions are `x=(column-3.5)*70`, `y=(row-0.5)*100`. The snapshot is tick 60 / t=1 second, using native loaded POA arrays, native animation speed/loop fields, native projected PO skeleton, and existing native vector/Verlet constraint routines. The aim column uses `sin(1)*1.2` radians. The loadout matches the browser gallery: AK74 with clip, two frag grenades, silver chain, dreadlocks, white cigar, no helmet, matching explicit shirt/pants/skin/hair colors.

**Evidence boundary:** pose composition is a render-only helper matching the documented native formulas, not the full `TSprite.Update` gameplay path. It samples 61 fixed ticks (0–60), running native `DoVerletTimeStepFor(22,29)` and `(24,30)` for accessories. The dead column is a frozen terminal-prone skeleton with dead-head/blood rendering, not a simulated death/ragdoll. The JSON contains sixteen arrays of 24 world-space `{x,y}` points; native point 1 is JSON index 0. It allows the integrator to quantify pose versus texture/transform differences rather than claim full simulation parity from a screenshot. No browser/native gallery difference metric was calculated by this slice.


## Build record and resolved errors

Environment observed: macOS Darwin 25.4.0, arm64; Homebrew `fpc 3.2.2_1`, `cmake 4.2.1`, `sdl2 2.32.10`, `openal-soft 1.25.2`, `freetype 2.14.3`, `physfs 3.2.0`, `protobuf 34.1`, `openssl@3 3.6.3`. FPC reported compiler version **3.2.2**, target Darwin for AArch64. The C/C++ compiler identified itself as AppleClang 21.0.0.21000101. CMake selected Apple's OpenAL framework; the installed OpenAL Soft keg was not selected.

Source pins, as recorded by `dist/content/manifest.json`: OpenSoldat `bf43a43bdd7a069e02c906768807f66e621b2888`, base `5b6e5bef23f5c0d58fb1d4d887b9b94ebcf799b4`.

1. Dependency discovery: `brew list --versions sdl2 openal-soft freetype physfs protobuf openssl@3` exited 1 because OpenAL Soft and PhysFS were absent. `brew install openal-soft physfs` succeeded. Toolchain independently completed `brew install fpc`; this slice did not run a competing FPC installation.
2. `ditto reference/opensoldat build-out/refclient/source` succeeded. Initial configuration succeeded with the exact command below:

   ```sh
   cmake -S build-out/refclient/source -B build-out/refclient/cmake \
     -DBUILD_SERVER=OFF -DADD_ASSETS=OFF -DCMAKE_BUILD_TYPE=Release \
     -DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3 \
     -DCMAKE_PREFIX_PATH=/opt/homebrew -DCMAKE_Pascal_FLAGS=-Fl/opt/homebrew/lib
   ```

3. First `cmake --build build-out/refclient/cmake --parallel 4` failed, exit 2. GNS v1.4.1 `steamnetworkingsockets_internal.h:677` invokes `msg.GetTypeName().c_str()`, but protobuf 34 returns `std::string_view`. AppleClang reported `error: no member named 'c_str' in 'std::string_view'` while compiling `csteamnetworkingsockets.cpp:653` and `steamnetworkingsockets_connections.cpp:1298`. `patches/002-protobuf-string-view.patch` wraps only this diagnostic expression in `std::string(...)`; networking/render behavior is unchanged.
4. The next identical build passed GNS and reached Pascal, then failed, exit 2: `Client.pas(719,25) Error: (3059) No member is provided to access property` and corresponding errors for all 13 initial direct CVar `.Value :=` assignments. Native CVar values are read-only properties. The viewer patch now calls existing `SetValue(...)` methods before `CvarsInitialized` is set. No CVar implementation was altered.
5. The next identical build succeeded: `[100%] Built target opensoldat`. Initial native Airpirates capture succeeded in about three seconds. All six shipped-map capture commands subsequently exited successfully.
6. Explicit smoothing was added after discovering the base graphics config defaults it **off**. The build succeeded again and all shipped maps were recaptured with smoothing **on**. Synthetic keeps smoothing off. Its first draft had a 39-character description in a 38-byte shortstring field, producing a malformed header/background. The generator now bounds shortstrings and uses a shorter description; the corrected synthetic capture shows the intended textured, red-to-blue translucent triangle against RGB32.
7. Final reusable command `sh tools/refclient/build.sh` succeeded (including patch application, configure, build, data preparation, synthetic generation); the compiler reported 98,411 lines compiled and 12 hints. The final seven-map capture chain exited successfully. No tests, formatters, server build, or other slice verification was run.


The later gallery extension was exercised with `sh tools/refclient/build.sh && sh tools/refclient/capture-gostek.sh`. Its first patch application failed with `2 out of 3 hunks failed` because the single-context-line addition hunks were rejected by the local patch utility; adding surrounding context resolved it. The next full command succeeded, compiling 98,583 lines with 12 hints and capturing the native gallery. Resolved `.rej`/`.orig` files were removed from the isolated source copy.

Nonfatal upstream warnings remain: CMake FetchContent CMP0135/CMP0169 and old minimum-version warnings; deprecated Clang builtins/`sprintf`; macOS linker obsolete options, duplicate `-lc`, and deployment-target warnings (FPC macOS 11.0 target versus Homebrew libraries built for 26.0). They did not prevent execution or capture on this machine.

**Blockers:** none for native map capture on this workstation. A machine without an interactive macOS GL desktop may not run this SDL client; no headless or cross-platform fallback was exercised. Pixel-difference analysis belongs to the renderer integration, not this native-build slice.
