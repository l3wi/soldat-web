# FileFormats research: original Soldat content compatibility

> Historical source/corpus research from 2026-10-15. Current requirements, implementation/qualification and delivery sequencing are maintained in [SPEC](../../SPEC.md), [porting status](../porting-status.md) and [PLAN](../../PLAN.md). Original PNG/PCM inventory and proposed conversion paths below are not measurements of today's shipped WebP/Opus derivatives. Original OpenSoldat loader behavior is evidence, not an assertion that the browser reproduces it.

## 1. Verified facts (with citations)

### Scope and reproducibility

This source/corpus investigation did not implement the game or change project/reference files. Executed temporary Bun/TypeScript audits:

- `/tmp/soldat-research/FileFormats/audit.ts` — strict PMS/POA field parser, extension inventory, signature-based image metadata, WAV chunks, dependency resolver.
- `/tmp/soldat-research/FileFormats/details.ts` — active-versus-unused scenery references, PO constraints, ZIP central directory, BMP green pixels, PNG tRNS chunks.
- Results: `/tmp/soldat-research/FileFormats/results.json`, `details.json`, `render-stats.json`.
- Main command: `bun /tmp/soldat-research/FileFormats/audit.ts` (defaults to the checked-out base root). Follow with `bun /tmp/soldat-research/FileFormats/details.ts`.
- All counts below exclude `.git`, include other repository files, and do not recursively count assets inside the nested `client/mods/classic.smod` as loose files.

**Actual parser results: 99/99 PMS maps, 51/51 POA animations, 6/6 PO skeletons; zero parse failures.** Map field parsing is deliberately stricter than the Pascal reader: byte-bound checks, finite floats, count limits, valid shortstring lengths; original `BufferRead` zero-fills out-of-bounds reads and advances anyway (`reference/opensoldat/shared/MapFile.pas:220-225`). Parsing successfully does not certify equivalent rendering or physics.

### PMS binary format: exact v11 layout

All 99 corpus files have `Version=11`. Little-endian signed 32-bit integers and IEEE754 float32 are used; bytes/uint16 where noted. The original reader copies host-native little-endian bytes (`MapFile.pas:228-245`); the community format independently documents little endian: https://wiki.soldat.pl/index.php/Map . **Do not deserialize the in-memory Pascal records directly**: the reader explicitly consumes padding, while runtime records add fields not on disk.

#### Header/options (88 bytes, before polygon count)

| Absolute byte offset | Bytes | Field / interpretation |
|---:|---:|---|
| 0 | 4 | Version, int32; observed 11 |
| 4 | 39 | Map description: uint8 byte length followed by **38 reserved content bytes** |
| 43 | 25 | Terrain texture filename: uint8 byte length + **24 reserved content bytes** |
| 68 | 4 | Background top color, **B,G,R,A** bytes |
| 72 | 4 | Background bottom color, B,G,R,A |
| 76 | 4 | StartJet, int32 |
| 80 | 1 | Grenade pack setting |
| 81 | 1 | Medikit setting |
| 82 | 1 | Weather: 0 none, 1 rain, 2 sandstorm, 3 snow |
| 83 | 1 | Steps: 0 hard ground, 1 soft ground, 2 none |
| 84 | 4 | RandomID, int32 |
| 88 | 4 | Polygon count, int32 |

Sources: `reference/opensoldat/shared/MapFile.pas:248-291,317-337`; weather/steps enum definitions: https://wiki.soldat.pl/index.php/Map . Strings are Pascal-style fixed-width shortstrings, **not** null-terminated variable records or UTF-8 length prefixes. Current source uses AnsiChar strings; non-ASCII encoding compatibility beyond this corpus is unverified. Preserve original bytes and choose an explicit legacy encoding policy.

#### Polygon record: 121 bytes, tightly serialized

| Relative offset | Bytes | Field |
|---:|---:|---|
| 0 | 28 | Vertex 1 |
| 28 | 28 | Vertex 2 |
| 56 | 28 | Vertex 3 |
| 84 | 12 | Normal/perpendicular vector 1: float32 x,y,z |
| 96 | 12 | Normal/perpendicular vector 2 |
| 108 | 12 | Normal/perpendicular vector 3 |
| 120 | 1 | PolyType |

Each 28-byte vertex: offsets 0,4,8,12 = float32 `x,y,z,rhw`; offset16 = BGRA8; offsets20,24 = float32 `u,v`. **Normals are the polygon's three edge/perpendicular vectors, not ordinary interpolated lighting normals per vertex.** They carry physics semantics: bounciness is the magnitude of the third vector's XY before normalizing the three perpendiculars (`reference/opensoldat/shared/PolyMap.pas:225-240`). Recomputing unit normals from triangle coordinates can erase bounce strength. `TextureIndex` is assigned runtime value 0 for every polygon, not read from v11 disk bytes; despite the in-memory `Textures[]` abstraction, these files have one header terrain texture (`MapFile.pas:319-325,344-354`).

Polytypes from `reference/opensoldat/shared/PolyMap.pas:39-64`:

| Value | Meaning | Value | Meaning |
|---:|---|---:|---|
| 0 | normal | 13 | blue player |
| 1 | only bullets | 14 | yellow bullets |
| 2 | only player | 15 | yellow player |
| 3 | doesn't collide | 16 | green bullets |
| 4 | ice | 17 | green player |
| 5 | deadly | 18 | bouncy |
| 6 | bloody deadly | 19 | explodes |
| 7 | hurts | 20 | hurts flaggers |
| 8 | regenerates | 21 | only flaggers |
| 9 | lava | 22 | not flaggers |
| 10 | red bullets | 23 | non-flagger collides (preserve source distinction) |
| 11 | red player | 24 | background |
| 12 | blue bullets | 25 | background transition |

Names are not sufficient to implement behavior; team/flag/projectile exclusions are explicit branches (`PolyMap.pas:685-705`), and player damage/transition effects live in simulation code. Do not collapse 22/23 just because descriptions sound similar.

#### Remaining sequential sections

All section counts below are int32 unless specified; offsets after polygons are variable.

| Section | Encoding |
|---|---|
| Sectors | int32 `SectorsDivision`, int32 `SectorsNum`; then `(2*SectorsNum+1)^2` cells. Each cell: uint16 count, then that many uint16 **1-based polygon indices**. File order is X/first coordinate outer loop, Y/second inner loop, both `-SectorsNum..SectorsNum`. |
| Props | int32 count; each record **44 bytes**, detailed below. |
| Scenery types | int32 count; each record **55 bytes**: shortstring[50] = length byte +50 bytes filename, then int32 date. Community format interprets date as packed DOS time/date; runtime stores opaque int32. |
| Colliders | int32 count; each **16 bytes**: active u8 +3 pad, x f32, y f32, radius f32. |
| Spawnpoints | int32 count; each **16 bytes**: active u8 +3 pad, x i32, y i32, team/type i32. |
| Waypoints | int32 count; each **112 bytes**, detailed below. |
| Trailing bytes | Original parser stops after declared waypoints; no EOF equality check. **97/99 maps have trailing bytes**, 8..33,681 bytes (189,354 total). Preserve source bytes; accept/report trailing data instead of falsely declaring these stock maps corrupt. Meaning of trailers not established. |

Sources: `MapFile.pas:356-482`; cell indexing `PolyMap.pas:250-265`. Limits: polygons 5,000; sector radius 0..25 (maximum51×51 cells); props500; scenery types500; colliders128; spawnpoints255 (`PolyMap.pas:25-35`); waypoints5,000 and connections20 (`reference/opensoldat/shared/Waypoints.pas:15-30`). The sample maps have waypoint counts up to500, but that is not the current loader maximum.

Prop 44-byte record:

| Offset | Encoding |
|---:|---|
| 0 | active u8 |
| 1 | pad u8 |
| 2 | style u16 (**1-based scenery type index**) |
| 4,8 | width,height i32 |
| 12,16 | x,y f32 |
| 20 | rotation f32 |
| 24,28 | scaleX,scaleY f32 |
| 32 | alpha u8 |
| 33..35 | padding |
| 36..39 | color BGRA8 |
| 40 | level u8: 0 behind all,1 behind map,2 in front |
| 41..43 | padding |

Only active props with level≤2 and style in1..sceneryCount render (`MapFile.pas:488-494`). Rendering uses RGB from prop color but **alpha from the separate `Alpha` field**, not prop color alpha; uses pivot(0,1) and **negative stored rotation** (`reference/opensoldat/client/MapGraphics.pas:585-588`). Preserve negative scales. Background top/bottom stored alpha is overridden to255 at render time (`MapGraphics.pas:685-695`).

Waypoint 112-byte record:

| Offset | Encoding |
|---:|---|
| 0 | active u8 +3 pad |
| 4,8,12 | id,x,y i32 |
| 16..20 | left,right,up,down,jetpack u8 booleans |
| 21 | PathNum u8 |
| 22 | Action u8: 0 none;1 stop/camp;2 wait1s;3 wait5s;4 wait10s;5 wait15s;6 wait20s |
| 23..27 | 5 skipped/reserved bytes |
| 28 | connection count i32 |
| 32..111 | **20** i32 connection slots always serialized, not just connection-count entries |

Source: `MapFile.pas:464-482`, `Waypoints.pas:21-30`.

Spawnpoint type values: 0 general;1 Alpha;2 Bravo;3 Charlie;4 Delta;5 Alpha flag;6 Bravo flag;7 grenades;8 medikits;9 clusters;10 vest;11 flamer;12 berserker;13 predator;14 yellow flag;15 Rambo bow;16 stationary gun (community format above; source creates flag/object spawns in `reference/opensoldat/shared/Game.pas:675-717`). Spawn positions with |x| or |y|≥2,000,000 are disabled by runtime (`PolyMap.pas:267-271`).

#### Runtime conversions and map lifecycle

- File jet amount is **not used unchanged**: `StartJet := 119 * file.StartJet div100` (`PolyMap.pas:201`). Corpus raw jets span0..511, with36 distinct values. Preserve signed/int truncation semantics, not seconds guessed from the UI.
- Map hash is a specific nonstandard-initialized CRC calculation: initial5381, polynomial table in source, operating on **all raw map bytes including trailers** (`MapFile.pas:139-183,484`). Archive/network SHA1 is a separate concept; do not conflate them with the map runtime hash. New protocol may use a new strong manifest hash because old network compatibility is not required.
- Server map change clears waypoints then calls simulation map load. Client first resolves map info and verifies checksum before the graphics-aware map load (`Game.pas:563-586`). Match both client/server content identity, but do not import the old network protocol as a requirement.

### PMS validation results and legacy 1.7.x compatibility

| Measurement | Measured result |
|---|---:|
| Base PMS parsed | **99/99**, all version11 |
| Maps bytes | 8,430,192 total;36,692..174,173 per map |
| Polygons | 32,806 total;80..903;median299 |
| Props | 15,730 total;0..500;median135 |
| Scenery type declarations | 2,554 total;0..96/map |
| Colliders | 1,567 total;0..85/map |
| Spawnpoints | 2,965 total;8..78/map |
| Waypoints | 21,954 total;0..500/map |
| Bad sector polygon references | 0 |
| Active prop styles out of range | 0 |
| Waypoint connection counts outside0..20 | 0 |
| Distinct header terrain texture strings | 49 |
| Declared texture+scenery references | 2,653 |
| Resolved by PNG override | **2,070** references |
| Further case-only resolution | **12** references |
| Missing declared references | 38 across4 maps |
| Missing dependencies actually required by active props/terrain | **2**: both terrain textures |

Full per-map names, texture strings, counts, and missing-reference details are in `results.json`. Missing active dependencies: `ctf_Aftermath.pms` → `textures/grunge9.png`; `ctf_Amnesia.pms` → `textures/porzeczkasc6.png`. Their other missing scenery declarations, and missing declarations in ctf_Death/ctf_Division, are **unused** by active props. Do not misreport all38 as visible map defects. Stock loader silently falls back to `textures/default.bmp`/PNG, then to a generated32×32 image if loading fails (`MapGraphics.pas:79-116`); a compatibility importer should report the original missing asset and fallback explicitly, not claim original visuals matched.

Legacy evidence: official release listing https://www.soldat.pl/en/downloads links Soldat1.7.1.1 and dedicated server2.8.2. Actual mirror https://static.soldat.pl/downloads/soldatserver2.8.2_1.7.1.1.zip . The server ZIP central directory contains97 PMS (directly inspected here). The LicensingProvenance investigation compared every map in both the official classic client installer and server archive against this base checkout: **97/97 byte-identical**, only Aftermath and Amnesia are additional base maps. See [LicensingProvenance](LicensingProvenance.md) (original research artifact: `local://research-LicensingProvenance.md`); classic client ZIP SHA256 reported there: `affbd397a6498e678c6974db3326a9639f414708a53fabec34ffb6db96ae6bc5`. Therefore the99/99 parser pass includes the exact97 classic map bytes; no format-version migration is needed for that fixture set. The parser was not separately rerun on identical classic files.

**Version nuance:** current `LoadMapFile` reads `Version` but neither rejects it nor branches on it (`MapFile.pas:317-482`). That does **not** prove all historical/future PMS versions have the same layout. Verified support is v11/classic1.7.1.1 files. Pre-v11/PMP support is unknown; community wiki says1.05b and earlier used `.PMP`. Do not promise that compatibility without fixtures.

Rendering nontriviality is measurable: **27,825** polygons have different RGBA across vertices; Airpirates polygon index1 alpha=[255,0,255], index591=[26,26,128]. UV U spans−26.30078125..26.30078125, V−17.93359375..17.93359375. There are96,443 vertices whose UVs fall outside[0,1]. Terrain must repeat, not clamp to the atlas rectangle. `MapGraphics.pas:308-310` explicitly enables texture repeat, and passes pervertex colors (`:731-738`).

### POA animation format and physical PO skeletons

**POA is plaintext, not a sprite strip and not a binary animation codec.** Each point is four consecutive lines: integer index, X float, Y float, Z float. `NEXTFRAME` separates frames and `ENDFILE` ends the file. Runtime limits:20 point indices1..20 and40 frames. Loader sets runtime XY to **−3*file.X/1.1, −3*file.Z**, ignores the file's Y coordinate, and does not assign runtime Z (`reference/opensoldat/shared/Anims.pas:21-35,69,87-141`). Maintain orientation/sign and do not confuse the unused coordinate with screen Y.

Audit: **51/51 POAs**,1,201,020 bytes,1,295 total frames,2..40 frames/animation; every frame has exactly20 unique indices. The animation file does **not** encode playback speed, looping, animation IDs, transitions, or body/legs blend rules. Source assigns44 runtime animation IDs0..43 with speeds1..9 and loop flags (`Anims.pas:172-376`); seven corpus POAs are not loaded by those assignments. Per-tick `DoAnimation` increments a frame when Count=Speed; clamps at final frame or loops (`:72-84`). E.g. stand speed3, run speed1, crouch-run speed2, Barrett speed9. Reproduce as ticks on the60Hz simulation clock rather than treat frames as60FPS independent clips.

**PO is plaintext physical constraint data.** Repeated name/X/Y/Z lines until `CONSTRAINTS`; then pairs of `P<number>` lines until `ENDFILE`. Runtime creates points **in file order** (names are read but not used to assign indices), projects to `x=−X*scale/1.2, y=−Z*scale`, and computes each constraint rest length from transformed positions. Source: `reference/opensoldat/shared/Parts.pas:291-324`.

| File | Points | Constraints | Load scale |
|---|---:|---:|---|
| gostek.po | **24** | 30 | 3 |
| kit.po | 4 | 6 | 2.15 |
| flag.po | 4 | 4 | 4 |
| para.po | 4 | 6 | 5 |
| stat.po | 4 | 4 | 4 |
| karabin.po | 2 | 1 | repeated1.0,1.1,1.8,2.2,2.8,3.6,3.7,3.9,4.3,5.0,5.5 |

All6 parsed with valid endpoint references. Load scales and gostek gravity1.06, damping0.997: `Anims.pas:385-421`. **20 animated points ≠ complete24-point physical skeleton** (`reference/base/shared/objects/gostek.po:1-97`). POA and PO also use different horizontal divisors1.1 vs1.2. This is a genuine fidelity trap, not interchangeable geometry.

### Gostek graphics, mod.ini, images, and transparency

There is no separate general-purpose `gostek-graphics` file format in this checkout. Structural definitions live in `reference/opensoldat/client/GostekGraphics.inc` (131 definitions, indices 0..130; the file has 138 lines): sprite ID/image, point anchors p1/p2, center cx/cy, default visibility, flipped image/team variants, flex, color category, alpha category. Examples `:18-24`; structure/loading in `GostekGraphics.pas:68-111`.

`shared/mod.ini` has `[SCALE]` and `[GOSTEK]` sections. `[GOSTEK]` overrides only `<ID>_CenterX` and `_CenterY`; missing/unparseable numbers retain code defaults (`GostekGraphics.pas:114-127`), not point bindings/flex/color categories. Root GOSTEK values are merged with current mod's keys (`reference/opensoldat/client/GameRendering.pas:182-201`). `[SCALE]` lookup: normalized lowercase slash-separated full image path → containing-directory key → `DefaultScale` → numeric fallback1. Root, current-mod and custom-interface scale tables are separate (`GameRendering.pas:204-267`). Base defaultscale is **4.5**, cursor override10 and title images1 (`reference/base/shared/mod.ini:1-5`); using source pixels as world units without this information changes character scale.

Path resolution explicitly normalizes case and backslashes, and **prefers `.png` over the requested extension** (`GameRendering.pas:337-354`). Examples: a map requesting `banana.bmp` actually uses `banana.png`; uppercase `GRASS.BMP` resolves to `grass.bmp`. No case-fold filename collisions found in loose base, but custom packages must have deterministic collision policy. Build a canonical manifest so HTTP/CDN requests use the real case-preserving filename; do not rely on macOS/Windows filesystem tolerance. Preserve display names separately from normalized lookup IDs.

Transparency rules:

- Source sprite definitions use opaque pure-green key **RGBA(0,255,0,255)** (`reference/opensoldat/shared/gfx.inc:370-389`). The equality test includes alpha; only matching pixels have alpha set0 (`reference/opensoldat/client/Gfx.pas:2329-2345`).
- PNG alpha is already decoded by the image loader. The green key is additionally applied to single-frame images only, and disabled when key integer=0 (`Gfx.pas:2351-2374`). Do not erase every green pixel in every asset; terrain explicitly has key disabled (`MapGraphics.pas:282`), edge textures and scenery use green (`:317,394`). Preserve semitransparent pixels.
- Native decoder sniffs image bytes (`stbi_xload_mem`), not just filename (`Gfx.pas:2359`). Audit found **16 extension/signature mismatches**:15 `micro1/*.bmp` files are PNG; `custom-interfaces/storm/cursor.png` is24-bit BMP. CDN MIME/type and conversion must be generated from actual signature.
- GIF multi-frame delays are returned by decoder, then integer-divided by10 (`Gfx.pas:2361-2364`); animated map scenery is treated as perframe textured quads (`MapGraphics.pas:552-565`). Base's only loose GIF is `gostek-gfx/help.gif`, but custom maps may use animated scenery. GIF frame/disposal fidelity has not been visually tested here.
- 191 actual24-bit BMPs contain exact green pixels (measured), so color-key preservation is a real requirement. PNGs include RGBA701, grayscale+alpha4, RGB107, grayscale1, indexed1. Indexed scenery `TDT_0089.png` has a `tRNS` chunk; do not handle only RGBA PNG alpha.

Image dimensions are not restricted to powers of two: **921/1,066** loose images are NPOT. Terrain `textures/mtex_desert.png` is **1536×512**, used by Aero and DesertWind despite their `.bmp` references. Edge strips are frequently90×1..8. Width range1..2511, height1..2048; largest area is2048×2048. Source attempts original dimensions, falling back to next-power-of-two resize only if texture allocation failed (`MapGraphics.pas:294-306`). A browser renderer that forbids NPOT repeat needs a faithful derivative texture or custom repeat shader, not a blanket input constraint.

All loose images decoded to RGBA8 would occupy **393,248,724 bytes (~375MiB)** before mipmaps, atlas padding, upload staging, and duplicated GPU copies. This is a dimension-based calculation, not measured browser memory. Do not eagerly decode the entire base archive for one match.

### Interfaces/custom-interfaces

Base has10 `setup.sif` files, each **240 bytes**, plus image folders. This is **binary**, not INI or JSON. `LoadInterfaceData` reads bytes then casts to `TInterface`; it does not structurally validate byte count (`reference/opensoldat/client/InterfaceGraphics.pas:296-334`). Runtime struct declaration `:106-146` defines1-byte alpha +11 one-byte booleans then4-byte-aligned int32 fields. Explicit portable layout:

| Offset | Bytes | Group |
|---:|---:|---|
| 0 | 1 | Alpha |
| 1..11 | 11 | Health,Ammo,Vest,Jet,Nades,Bullets,Weapon,Fire,Team,Ping,Status booleans |
| 12 | 36 | Health group: iconX/Y/rotate i32;barX/Y/width/height i32;pos u8 +3 pad;rotate i32 |
| 48 | 36 | Same Ammo group |
| 84 | 36 | Same Jet group |
| 120 | 24 | Vest: barX/Y/width/height i32;pos u8 +3 pad;rotate i32 |
| 144 | 20 | Nades: X/Y/width/height i32;pos u8 +3 pad |
| 164 | 8 | Bullets X/Y i32 |
| 172 | 8 | Weapon X/Y i32 |
| 180 | 36 | Same Fire icon/bar group |
| 216 | 8 | TeamBox X/Y i32 |
| 224 | 8 | Ping X/Y i32 |
| 232 | 8 | Status X/Y i32 |

Custom HUD assets load from `custom-interfaces/<name>/`; `.sint` files are mounted through PhysFS there (`InterfaceGraphics.pas:167-190`). Optional per-interface `mod.ini` provides scales; micro1 DefaultScale4.5 (`reference/base/shared/custom-interfaces/micro1/mod.ini:1-2`). Legacy layout, PNG/BMP overrides, and alternate bar/image anchoring are compatibility work separate from recreating menus in React. Do not assume React menus automatically satisfy original custom HUD support.

### weapons.ini and other configs

`reference/base/server/configs/weapons.ini` is textual INI with `[Info]` Name/Version and per-weapon sections. Loader starts from default weapon data, requires `[Info]`, updates only sections/keys present, then calls `BuildWeapons` (`reference/opensoldat/server/Server.pas:979-999`; `reference/opensoldat/shared/SharedConfig.pas:245-301`, optional key behavior`:114-151`). Numeric parser is locale-sensitive Pascal `StrToFloat`; browser port should define dot-decimal parsing explicitly and fixture-test legacy values.

Loaded keys: Damage,FireInterval,Ammo,ReloadTime,Speed,BulletStyle,StartUpTime,Bink,MovementAcc,BulletSpread,Recoil,Push,InheritedVelocity,ModifierLegs,ModifierChest,ModifierHead,NoCollision (`SharedConfig.pas:281-297`). Timer fields are ticks, **60ticks=1s**; Damage is a multiplier in `Damage*CurrentSpeed*HitboxModifier`, not direct HP (`reference/base/server/configs/weapons.ini:4-11`). E.g. stock Deagles Damage1.81,FireInterval24,Ammo7,ReloadTime87,Speed19 (`:112-128`). Bulletstyle enumerations are documented at`:27-40`.

**Legacy config trap:**1.7.1 changed units from≤1.7.0: Damage÷100,Speed÷10,BulletSpread÷100,InheritedVelocity÷100,MovementAcc÷200,Push÷2500 and added hitbox modifiers (`weapons.ini:74-103`). The file's `Version` is metadata, not an automatic conversion branch in the reader. Do not blindly accept ancient weapon mods as equivalent to1.7.1. Cosmetic `.smod` config and authoritative weapon/match rules should be separate inputs.

Not every `.cfg` is INI: client.cfg executes console commands `unbindall`, `exec graphics.cfg`, etc. (`reference/base/client/configs/client.cfg:1-8`). A universal INI parser for all configuration files would be wrong. `.bot` and translation/font/radio `.ini` files are also present; wholesale server Pascal-script/plugin compatibility is not implied by accepting art/maps.

### SMOD/PhysFS packaging and transfer

`.smod` is **ZIP**, not a proprietary compressed binary archive. Base builder uses Python `zipfile.ZIP_DEFLATED`, compression level5 (`reference/base/create_smod.py:151-158`). It merges trees in priority order **shared → client → server**, keeps the first seen relative path, strips those top-level prefixes, excludes hidden files via glob, sorts archive names (`:170-194`). Timestamp/UID metadata is scrubbed for reproducibility (`:30-128,160-168`); an importer need not reproduce byte-identical ZIP metadata unless binary archive identity is a separate acceptance target.

Client/server mount base `soldat.smod` at `/`, mod archives at `mods/<name>/` (`reference/opensoldat/client/Client.pas:685-691,759-769`; `reference/opensoldat/server/Server.pas:645-653,702-711`). Map packages `.smap` are mounted at `/current_map`, and the loader expects `maps/<MapName>.pms` inside (`MapFile.pas:193-210`). These virtual paths/search precedence matter; a flat URL converter cannot discard them.

Observed nested `client/mods/classic.smod`:68,000 bytes,154 ZIP directory entries,87,746 uncompressed bytes, methods0(store)/8(deflate), entries nested under `classic/`. **Archive roots are not guaranteed identical across packages**; that particular nesting appears inconsistent with current `mods/<name>/` mount expectation [INFERENCE from the inspected entry names plus Client.pas]. Do not silently strip arbitrary first folders or claim all mods already work; expose/archive-test mount policy. `.sint` also mounts via PhysFS, but no `.sint` fixture was found in base, so its ZIP-specific layout is not separately validated here.

Old HTTP file transfer only serves `.smod` under `/mods` and `.smap` under `/maps`, and requires `opensoldatclient/<version>` User-Agent (`reference/opensoldat/server/FileServer.pas:179-184,210-219`). FileClient downloads a whole file with150,000,000-byte ceiling and verifies SHA1 (`reference/opensoldat/client/FileClient.pas:32,102-109,124-139`). It does not individually fetch PNG/WAV dependencies or unpack a browser-ready manifest. For the new network, import content once, emit a versioned manifest and immutable objects/map bundles, and use normal browser-compatible CDN delivery. Keep archive acceptance separate from old file-server interoperability.

### Inventory: counts and exact byte totals

Loose files under `reference/base`, `.git` excluded:

| Extension | Count | Bytes |
|---|---:|---:|
| png |800|103,403,536|
| bmp |265|2,990,752|
| gif |1|3,934|
| wav |164|6,049,484|
| ogg |0|0|
| mp3 |0|0|
| pms |99|8,430,192|
| poa |51|1,201,020|
| po |6|1,047|
| sif |10|2,400|
| smod |1|68,000|
| xm |1|991,244|
| it |2|2,014,062|
| ini |34|34,248|
| txt |37|1,034,313|
| cfg |8|3,264|
| bot |16|6,313|
| ttf |1|171,084|
| py |1|7,134|
| md |2|1,601|
| yml |1|673|
| no extension |2|210|
| **Total** |**1,502**|**126,414,511**|

Total~120.56MiB is repository loose content, **not** a measured soldat.smod download size. By actual image signatures there are814 PNG,251 BMP,1 GIF, not the extension totals. New derivative atlases/bundles sizes remain unmeasured.

### Sound formats/sample rates and browser support

All164 WAV files' RIFF/fmt/data chunks parsed. **163 PCM** (format1), **one Microsoft ADPCM** (format2): `sfx/jump.wav`,mono22,050Hz,4-bit,4,608 encoded data bytes. `Sound.pas:150-187` uses SDL WAV decoding then uploads1/2 channels and8/16/float32 decoded samples to OpenAL; browser `decodeAudioData` is a different decoder path, so SDL acceptance does not establish browser acceptance of compressed WAV.

| WAV encoding /channels/rate/bits | Count |
|---|---:|
| PCM mono22050Hz16 |77|
| PCM mono22050Hz8 |46|
| PCM mono11025Hz8 |13|
| PCM mono44100Hz8 |9|
| PCM mono44100Hz16 |7|
| PCM mono32000Hz16 |3|
| PCM mono11025Hz16 |2|
| PCM stereo44100Hz16 |1|
| PCM mono14400Hz8 |1|
| PCM mono22254Hz16 |1|
| PCM mono8000Hz8 |1|
| PCM mono8363Hz8 |1|
| PCM mono19886Hz8 |1|
| MS ADPCM mono22050Hz4 |1|

Do not normalize unusual sample rates merely because they look wrong; resample deliberately if a derivative format requires it. Preserve original masters. PCM WAV is the conservative initial SFX derivative [INFERENCE: requires actual browser decode checks for target browser/OS matrix]; **convert jump.wav to PCM explicitly** rather than assume all `.wav` are PCM/browser-decodable. Total WAV size is only6.05MB; premature lossy conversion is optional, not required for feasibility.

The three loose music files are **tracker modules**, `sfx/modules/bloody.xm`, `gore.it`, `necro.it`,3,005,306 bytes total, not Ogg/MP3. No references to these filenames or libxmp integration found in current Pascal source search; whether the current build actually plays them is unverified. Native `<audio>`/WebAudio has no specified XM/IT decoder; pre-render them to a standard codec or choose a module decoder if preserving module playback/loop behavior is in scope [INFERENCE]. Music parity is not automatic merely because SFX work.

Current browser codec references (retrieved2026-10-15):

- MDN codec/container guide distinguishes codec and container; Opus in Ogg current support includesChrome/Edge/Firefox/Safari: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers#ogg .
- **Do not repeat obsolete blanket 'Safari does not support Ogg'.** WebKit's official Safari18.4 release notes add Ogg Opus/Vorbis onmacOS15.4+,iOS/iPadOS18.4+,visionOS2.4+: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/#media . Older Apple OS targets still change the decision.
- MP3 is broadly suitable as a fallback; AAC support can depend on platform codecs, especiallyFirefox. General codec tradeoffs: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs .
- `decodeAudioData` consumes a complete encoded file and resamples to the AudioContext rate: https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData . Do not assume sample rate equals simulation rate or that an audio extension guarantees a decoder.

No browser audio decode/playback matrix was executed in this research; the cited docs established support policy, not actual decode success for every asset. Research recommendation: decode all164 transformed SFX on each supported browser and compare durations/start offsets against originals, especiallyjump.wav and looping sounds.

## 2. Research assumptions: claim / verdict / evidence

| Claim | Verdict | Evidence |
|---|---|---|
| Original PMS can be imported untouched | **Confirmed for v11 / these 99 files** | 99/99 strict parse; 97 classic map bytes match; pre-v11 remains unknown. |
| Maps are a conventional engine tilemap/physics asset | **Refuted** | Triangles with BGRA/UV, edge physics normals, 26 types, sectors, spawns, colliders, waypoints. |
| Geometry and UV preservation are enough | **Refuted** | 27,825 color-gradient triangles; vertex alpha; normal-magnitude bounce; layers/background transitions; jet conversion. |
| Existing images can mostly load directly | **Nuanced** | 814 actual PNGs; BMP green key; 16 extension mismatches; 2,070 PNG overrides; default scale 4.5. |
| Character animation means playing a spritesheet | **Refuted** | POA 20-point poses + PO 24-point physical gostek + 131 code sprite definitions + aim/blend/runtime flags. |
| Original animations include timing/loop data | **Refuted** | Source assigns IDs, Speed, Loop after plain position load. |
| Sounds may need conversion | **Confirmed, narrower than expected** | 163 PCM, 1 MS ADPCM; 3 tracker modules. No loose Ogg. |
| `.smod` requires custom compression technology | **Refuted** | Standard ZIP deflate level 5; PhysFS virtual path semantics still need implementation. |
| Base contains every declared map dependency | **Refuted** | 38 missing declarations, 2 active terrain misses; stock fallback is not original-visual fidelity. |
| Browser bundles can preserve source files as authority | **Confirmed as design** | Readable formats support derived manifests; derivative fidelity/performance remain to be measured. |
| Matching browser/server content versions is simple hash work | **Nuanced** | Raw map CRC includes ignored trailers; archives have separate SHA1; new manifests should bind active dependencies and simulation config. |
| Supporting maps/assets implies old-server compatibility | **Refuted** | Old HTTP requires a proprietary User-Agent + SMAP/SMOD + SHA1; protocol compatibility is intentionally not a goal. |
| React menus cover original custom interfaces | **Refuted** | 240-byte SIF HUD layouts, image naming, anchors and scales are separate. |

## 3. Hidden assumptions and whether they hold

1. **A file extension tells the real codec. Does not hold.** There are 16 image suffix/signature mismatches plus ADPCM inside WAV.
2. **Case-sensitive CDN requests can use map strings verbatim. Does not hold.** PNG overrides and 12 case-only resolutions are needed; normalize backslashes too.
3. **All declared sceneries are used. Does not hold.** The 36 missing scenery references are unused; failing on any missing declaration rejects maps the original renders.
4. **The parser should end exactly at EOF. Does not hold.** 97 stock maps have ignored trailers. Hashing/re-export requires their original bytes.
5. **Normal vectors may safely be regenerated. Does not hold.** Third-normal magnitude stores bounciness.
6. **POAs include the entire soldier. Does not hold.** There are 20 animated versus 24 physical points, plus separate sprite definitions and runtime aiming.
7. **Animation and skeleton coordinate transforms match. Does not hold.** Horizontal divisors are 1.1 versus 1.2; both discard file Y.
8. **Every texture is power-of-two. Does not hold.** 921 images are NPOT; repeated NPOT terrain is a real fixture.
9. **Loading all base assets is harmless. Does not hold.** Approximately 375 MiB RGBA minimum precedes GPU copies, mipmaps and padding.
10. **Current base is exactly classic content. Only partly holds.** 97 identical classic maps plus 2 extras with missing terrain; current HD scale 4.5 and the classic art variant must not be conflated.
11. **Weapon config version metadata triggers migration. Does not hold.** Ancient unit changes are documented; loaders apply numbers directly.
12. **Archive entries always begin at the assets root. Does not hold.** Base builder flattens shared/client/server; bundled classic mod starts `classic/`. A mount-root policy is needed.
13. **Content compatibility covers all legacy extensibility. Not established.** Pascal server scripts, custom HUDs, mod rules, bots and tracker music each need explicit acceptance scope.

## 4. Risks and mitigations

| Severity | Risk | Mitigation |
|---|---|---|
| **High** | Plausible map visuals lose collision, jet, bounce or alpha semantics | Shared strict loader preserving all fields; source-rule fixtures; render Airpirates alpha gradients and Aero NPOT repeat before renderer commitment. |
| **High** | Art parity breaks because HD scale, PNG override, color key or anchors are ignored | Signature-sniffing manifest; port scale/path/key semantics; reproduce code Gostek definitions, not just POA. |
| **High** | Public custom archives are unsafe or exhaust resources | [INFERENCE] Bound counts, bytes, dimensions, expanded ZIP size and entry count; reject traversal/case collisions; never execute config scripts during import. Original zero-filling on truncation is not a safe validation model. |
| **High** | Whole-base atlases consume excessive RAM/GPU memory | Load per-match/map dependencies; dispose unused decoded images; preserve dimensions/pivots when atlasing; measure derivatives rather than claiming a fixed budget. |
| **Medium** | “Original map” claim masks missing active art | Clear fallback status for Aftermath/Amnesia; start with Arena or another complete classic map. |
| **Medium** | Version/trailer handling falsely rejects stock files | Explicit v11 support; preserve trailers; add older fixtures before expanding the compatibility promise. |
| **Medium** | ADPCM/tracker audio is missing in browser | Convert jump.wav to PCM; decide music render/decoder policy; test actual decoding and loop offsets. |
| **Medium** | SIF/weapon-mod compatibility is implied but absent | Separate capability labels from baseline art/map compatibility; port the 240-byte SIF layout and 1.7.1 weapon units where required. |
| **Low** | ZIP metadata scrubbing is mistaken for required runtime behavior | Decode payloads normally; preserve original ZIP masters; reproducible archive rebuilding matters only if binary identity is required. |

## 5. Concrete recommendations / decisions for the spec

These are recommendations from 2026-10-15, not the current importer/asset roadmap. In particular, the initial PCM strategy and unmeasured derivative-size statements describe the original research boundary, not today's WebP/Opus delivery.

1. **Set the compatibility target precisely:** untouched v11 PMS from classic 1.7.1.1/base; PNG/BMP/GIF by actual signatures; POA 20-point, ≤40-frame poses; all 6 PO types; ZIP SMOD import; root mod.ini SCALE/GOSTEK. Give custom HUD SIF, tracker playback, ancient weapon mods, pre-v11/PMP and arbitrary server scripts their own acceptance categories, not an implied promise.
2. **Keep original files immutable; emit a deterministic derived manifest.** Canonical ID = lowercase plus `/`; preserve actual output URL separately. Include PNG override precedence, per-asset-class color key, source hash, converter version and simulation-config hash. Browser/server share parsed map/simulation content; server need not decode images.
3. **Keep the v11 reader simple:** DataView little-endian; strict count/bounds/finite checks; 121-byte polygons, 44-byte props, 55-byte scenery, 16-byte colliders/spawns, 112-byte waypoints. Retain all raw source bytes/trailers. An internal typed model suffices for the first viewer; a new on-disk serialization is not necessary.
4. **Acceptance says “99/99 parse,” not “99/99 fully render.”** Require zero invalid sector/active-style references, 2 explicit missing-terrain notifications, and nonfatal unused declarations. The 97 official classic maps have no active art misses with correct case/PNG resolution.
5. **Use revealing viewer fixtures:** Arena (356 polygons, 34 props, 7 colliders, 43 spawns, 224 waypoints; 83,613 bytes); Airpirates (vertex alpha); Aero/DesertWind (1536×512 repeat); Jungle (case-only BMP names); Aftermath (missing terrain); micro1/storm (signature mismatch if HUD compatibility is included).
6. **Use a 60 Hz simulation clock; advance POAs on ticks.** Speed 1 is default; Speed 3 means 20 pose frames/s, Speed 9 approximately 6.67. Preserve separate body/legs/state posing from the simulation port. Arena raw StartJet 190 becomes 226 via integer `119*190 div100`, not a rounded UI-derived value.
7. **Render full per-vertex RGBA, repeat UVs and prop transforms/layers.** Preserve edge/perpendicular XYZ and third-normal XY magnitude. Verify NPOT repeat in the engine spike; never silently clamp UVs. Atlas conversion must preserve world dimensions, anchors and color-key edges.
8. **Audio first pass:** preserve 163 PCM WAV masters, create a PCM derivative for jump.wav, load effects as needed, decide music separately. If compressing later, choose Opus/fallback by supported Apple OS versions rather than the obsolete blanket “Safari has no Ogg.”
9. **Avoid all-assets preload.** Known loose images are approximately 375 MiB decoded; separate the small global soldier/weapon/SFX core from per-map scenery/terrain. Measure on target devices; this investigation does not establish final atlas memory.
10. **[INFERENCE: planning estimates, not measured effort]** Production PMS/POA/PO readers plus typed models, path resolution and manifests: approximately 800–1,500 TS LOC including validation, excluding tests/rendering. Image/ZIP/scaling/audio preparation could add 500–1,000 LOC using established decoders. Faithful Gostek rendering/posing could add 500–1,000 LOC plus shared simulation rules. These are scope estimates, not a claim that a small importer reproduces gameplay.

## 6. Product questions recorded at research time

- Does “original look” mean classic 1.7.1.1 low-resolution art, current base HD art (default scale 4.5), or both selectable? Visual acceptance must name the reference.
- Does initial compatibility include custom HUDs/SIF/SINT, external weapon mods and tracker music, or only stock maps/gostek/weapons/SFX? These are distinct delivered capabilities.
- What minimum Safari/iOS/macOS versions and mobile devices must play? This determines codec fallback and texture/memory constraints.
- Should maps with missing active assets be rejected, display an explicit stock fallback warning, or ship only after locating original art? Two base extras require that choice.
- Must players drag/drop untrusted SMOD/SMAP files locally, or will content be curated/admin-imported? This determines whether browser-side archive validation and user-content storage belong in the first spec.
