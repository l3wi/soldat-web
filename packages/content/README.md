# Content importer

Build-time TypeScript/Bun importer for the pinned OpenSoldat base checkout. The importer does not change upstream content or simulation code. Its pure readers are also usable for local-only content inspection; accepting an archive does not grant redistribution rights.

## Build a content set

From the repository root:

```sh
bun install
bun packages/content/src/cli.ts --base reference/base --out dist/content
bun test packages/content/src
bun packages/content/src/cli.ts --hash dist/content
```

`--source` defaults to `reference/opensoldat`; `--pins` defaults to `pins.json`. These provide the source graphics tables and provenance pins. Run comparisons in **fresh output directories**; the importer overwrites its own current outputs but deliberately does not delete old objects or unrelated files from an existing directory. No network access is used during import. `dist/` is ignored by Git.

The CLI exits nonzero on malformed content and prints a typed error code. Missing map dependencies are reported in the manifest rather than treated as parse failures. Its success JSON contains `summary` and `simContentSha256`. `--hash DIRECTORY` hashes sorted `relative-path<TAB>file-sha256<LF>` records and reports the tree's file count and byte size; no file timestamps enter this hash.

## Output reference: schema version 1

Paths in JSON are relative to the output root. Object filenames are SHA-256 of the **output bytes**, not the source bytes. JSON object keys are sorted recursively; arrays preserve source order. No generated timestamps or absolute input paths are emitted.

| Path | Contents |
| --- | --- |
| `manifest.json` | Pins, global `core`, all `images`, per-map `maps`, `objects` provenance index, `summary`, and `simContentSha256`. |
| `objects/<sha256>.<ext>` | Immutable PNG frame derivatives, PCM WAV, raw simulation files, font, and gostek data. Identical derivatives share one object, with multiple provenance records. |
| `maps/<OriginalName>.json` | Render-ready map file; keep the original name/case for display. |
| `sim/manifest.json` | Canonical virtual file IDs to raw file path, object, SHA-256 and byte count; combined simulation hash. |
| `sim/maps/*.pms` | Original bytes, including trailers. |
| `sim/anims/*.poa`, `sim/objects/*.po` | Original physical animation/skeleton inputs. |
| `sim/configs/weapons.ini`, `sim/mod.ini` | Original configuration bytes. |
| `gostek.json` | Full parsed source part table, resolved graphics table, and retained MIT notice. Also available as `core.gostek`, a hash-addressed JSON object. |
| `animations.json` | Canonical POA IDs to `{frames: [[{index,x,y,z},…],…]}`. Coordinates are unprojected source data. |
| `skeletons.json` | Canonical PO IDs to `{points:[{name,x,y,z}],constraints:[[p1,p2],…]}`; endpoints are one-based file-order indices. |
| `weapons.json` | Lowercase INI sections/keys, string metadata and finite numeric weapon values. |
| `notices/` | Base CC BY license, upstream incomplete credits, source MIT notice and Play OFL notice. |

### Manifest core and image assets

`core.graphics` groups the native `gfx.inc` entries into `gostek`, `weapons`, `sparks`, `interface`, and `objects`. Each definition retains `symbol`, numeric `index`, `group`, requested `path`, RGBA `colorKey`, plus a resolution record. `core.sfx` maps canonical virtual paths to `{object,sampleCount,sampleRate,channels,durationSeconds,converted}`. Sample counts are **per channel**. `core.font` names the unmodified Play TTF object. Core animation/skeleton/weapon references name the corresponding JSON files above.

A resolution record is `{requested,id,path,pngOverride,caseOnly,asset,fallback}`. `id` is the lowercase slash-separated requested ID; `path` is the case-preserving resolved virtual path or `null`. PNG overrides win over the requested extension. `fallback` is a selected fallback path only when the original dependency is missing. `asset` is the selected `ImageAsset` or `null`.

An `ImageAsset` contains:

- `sourcePath`, `sourceSha256`: original base-relative file and source-byte SHA-256.
- `format`: signature-detected `png`, `bmp` or `gif`, independent of filename extension.
- `width`, `height`: original dimensions, including NPOT sizes; never atlas dimensions.
- `scale`: native mod.ini image scale (full path → directory → DefaultScale → numeric fallback 1). Base DefaultScale is 4.5. Native sprite world dimensions are source dimensions divided by this scale, not multiplied. Custom-interface assets use their own scale tables.
- `keyed`: exact color-key operation was enabled; it does not imply any pixel matched.
- `alphaMode: "straight"`.
- `frames`: `[{object,delayMs,delayTicks}]`. Every object is a full composited RGBA8 PNG. GIF `delayTicks` is native integer `delayMs div 10`, **not** 60-Hz simulation ticks.

`images` indexes all loose image assets by canonical virtual path, including custom interfaces and scenery. Consumers should load only core and selected-map references, not the entire index. Terrain is not keyed; scenery and edge strips use opaque green. Core sprites use their exact declared color key (usually opaque green, sometimes opaque black). A multi-frame GIF is never color-keyed. Only exact matching RGBA pixels have alpha cleared: partially transparent green is retained.

**PNG derivatives contain straight-alpha RGBA, not premultiplied bytes.** The renderer must premultiply exactly once at GPU upload (for example, `UNPACK_PREMULTIPLY_ALPHA_WEBGL`) and use the native premultiplied blend/shader convention. This deliberately places premultiplication at GPU upload rather than baking it into PNG; SPEC §4.2's ordering needs that clarification. Do not resize NPOT terrain, and use repeating UVs.

### Render-ready map

Each map file contains:

- `name`, `description`, `mapSha256`, `schemaVersion`.
- `terrain` and `edge` resolution records. Missing terrain explicitly selects `textures/default.bmp` through normal PNG resolution; missing edge strips select `textures/edges/default.bmp`.
- `polygons`: source order, each `{vertices:[v0,v1,v2],normals:[n0,n1,n2],polytype}`. Each vertex is `{x,y,z,rhw,color:[r,g,b,a],u,v}`. Normals retain raw XYZ magnitudes. Do not normalize them for simulation or reorder triangles/vertices. UVs outside `[0,1]` are valid.
- `props`: `{active,style,width,height,x,y,rotation,scaleX,scaleY,alpha,color:[r,g,b,a],level}`. All disk values are preserved, including negative scales. `style` is one-based. Render only active, valid-style props at levels 0–2; native pivot is `(0,1)`, render angle is **negative stored rotation**, and opacity comes from separate `alpha`, not `color[3]`.
- `scenery`: source declaration order, `{style,name,date,active,...resolution}`. `active` means at least one renderable prop references that style. Missing unused declarations are recorded but are not visible defects. Animated scenery uses the selected image's complete frame list.
- `colliders`: `{active,x,y,radius}`; `spawnpoints`: `{active,x,y,team}`.
- `backgroundTop`, `backgroundBottom`: source RGBA colors; native renderer overrides both alphas to 255 and anchors the gradient in world space.
- `weather`, `steps`, raw `startJet`, `botCapable`, and `missing` dependency records. Compute native initial jets using integer `119 * startJet div 100`; do not reinterpret as seconds.

Sector cells, full waypoint records and trailer bytes are exposed by `parsePms`, but not duplicated into render JSON. Simulation consumes original PMS bytes; the importer is not a replacement simulation parser. Raw PMS objects preserve every disk byte and therefore source checksums.

The manifest's map entry repeats dependencies and adds `path` and `simContentSha256`. `missing` records distinguish required terrain/active scenery from unused scenery declarations; edge fallback is recorded separately and does not count as a missing active map dependency, matching the audit.

### Gostek parts

`parts` retain `{index,symbol,id,image,imageSymbol,imagePath,variants,p1,p2,cx,cy,visible,flip,team,flex,color,alpha}`. `variants` enumerate original/flip/team graphic IDs and requested paths; resolve them through `gostek.graphics` or core graphics by numeric ID. Center overrides are applied from `[GOSTEK]`; other structural fields remain source-defined. Color categories are none=0, main=1, pants=2, skin=3, hair=4, cigar=5, headblood=6; alpha categories are base=0, blood=1, nades=2. A zero image is intentionally absent, not a missing file.

**Pinned source correction:** the source include has **131 actual Def entries (indices 0–130)**, not 138. It has 138 text lines; the earlier research count conflated lines and definitions. The importer exports every actual definition and invents no extra parts. Runtime `ApplyGostekConstraints` and pose evaluation remain renderer/simulation responsibilities; the exported centers are the mod-overridden defaults before runtime texture constraints.

POA projection is `x=-3*sourceX/1.1`, `y=-3*sourceZ`; PO uses `x=-sourceX*loadScale/1.2`, `y=-sourceZ*loadScale`. Playback speed/looping are not encoded in POA. For the render spike, use original Anims.pas animation assignments; do not infer playback from file frame counts.

### Simulation identity and provenance

`simContentSha256` hashes sorted `canonical-virtual-id<TAB>source-sha256<LF>` records for every raw PMS, POA, PO, mod.ini and weapons.ini. Client and server must compare that combined hash; it is not the original engine's nonstandard PMS CRC.

`objects[path]` contains `{sha256,bytes,provenance:[…]}`. Each provenance record retains repository URL, pinned commit, source path, source SHA-256, SPDX-style `licenseId`, credit and ordered transformation descriptions. Base content is CC-BY-4.0; the font is OFL-1.1; exported source-table contributions are MIT. Gostek data records its source include, graphics include and mod.ini contributions separately. Preserve the bundled notices and do not imply contributor endorsement.

## Reader boundaries and limits

- PMS: v11 only, finite float32 values, bounded section counts, valid active references, all trailing bytes accepted/preserved. Shortstrings use byte-preserving Latin-1; this does not claim support for every legacy codepage.
- POA/PO: strict finite dot-decimal points and valid one-based references. INI names are case-insensitive; mod numeric fallback semantics match the original. Weapons INI does not auto-convert old-version units or replace compiled simulation defaults for omitted keys.
- PNG: pngjs, including indexed+tRNS and grayscale+alpha. BMP: uncompressed 24/32-bit. GIF: composited frames with disposal/delay metadata. Image sizes and decoded-memory allocations are bounded.
- WAV: PCM bytes copied untouched. Microsoft ADPCM is decoded to 16-bit PCM using format coefficients/adaptation, `fact` sample-count trimming, original channels/rate. No lossy codec is used.
- ZIP/SMOD: `readZip` returns original entry paths and bounded bytes, with traversal/case-collision and size/entry checks **before inflation**. Archive roots are never guessed or stripped. Base's nested classic.smod is inspected, not mounted into the vanilla content set.

See `docs/gates/G0.5.md` for exact corpus evidence, dependency exceptions, deterministic output hashes and exercised tests.
