# RenderingPhaser — rendering assumptions audit

Research date: 2026-10-15. Investigation of OpenSoldat; isolated package/API probe under `/tmp/soldat-research/RenderingPhaser/`. No project/reference files changed.

> Historical renderer evidence and API probe. [SPEC](../../SPEC.md), [porting status](../porting-status.md) and [PLAN](../../PLAN.md) govern current requirements, implementation/qualification and delivery. OpenSoldat draw rules and exact-version API observations below are not browser fidelity/performance qualification. Phaser is the current client renderer; Pixi/raw-GL alternatives and pre-lock spikes below are dated recommendations, not a pending renderer selection.

## 1. Verified facts (with citations)

### Executive verdict

**Phaser 4 is released and viable, but a faithful PMS map is not a stock `Mesh2D` use case.** Latest official stable release observed: **4.2.1, 2026-07-09**; 4.0.0 shipped 2026-04-10. Do not confuse Phaser 4 with the older experimental standalone development branch, or assume current APIs from Phaser 3 tutorials. Release evidence: https://github.com/phaserjs/phaser/releases/tag/v4.2.1 and https://github.com/phaserjs/phaser/releases/tag/v4.0.0 .

The especially important current-version nuance: **4.0 removed `Mesh` and `Plane`, but 4.2.0 added `Mesh2D` and `BatchHandlerTri`**. Nevertheless, `Mesh2D` only accepts `(x,y,u,v)` per vertex and one tint/alpha for the whole object. Original PMS polygons have **independent RGBA at all three vertices**. Therefore the answer to “can stock Phaser render PMS per-vertex colors without fighting the engine?” is **no, not directly; a bounded custom renderer adapter/shader is required**. This is an intended extension point rather than grounds for an engine fork. Whether the resulting integration is sufficiently small and performant remains a spike decision, not a demonstrated fact.

Primary exact-version sources:
- Migration/removal: https://github.com/phaserjs/phaser/blob/v4.2.1/changelog/v4/4.0/MIGRATION-GUIDE.md#17-removed-game-objects
- New mesh: https://github.com/phaserjs/phaser/blob/v4.2.1/changelog/v4/4.2/CHANGELOG-v4.2.0.md
- `Mesh2D`, especially lines 86–92, 121–154, 224–269: https://github.com/phaserjs/phaser/blob/v4.2.1/src/gameobjects/mesh2d/Mesh2D.js
- Constant tint written at each vertex, lines 152–155 and 183–220: https://github.com/phaserjs/phaser/blob/v4.2.1/src/renderer/webgl/renderNodes/BatchHandlerTri.js

### What OpenSoldat actually draws

These findings describe the checked-out **OpenSoldat renderer**, not a proven pixel-identical reconstruction of proprietary/classic Soldat 1.7.1.1. That distinction must survive into the spec.

#### Map geometry, color math, wrapping, and shading

- Vertex format is exactly **two float32 positions, two float32 UVs, four normalized uint8 RGBA components**: **20 bytes/vertex, 60 bytes/triangle** before indexing. No perspective/depth requirement: an orthographic 3×3 transform, z=0, depth test disabled. `reference/opensoldat/client/Gfx.pas:39-51,501-518,532-545,793-796`.
- Every PMS polygon's three `x,y,u,v,RGBA` values are copied directly into a static buffer. UVs are not normalized/clamped by the importer. Background polygon types are drawn separately; **within each layer, original polygon order is retained**, with consecutive same-texture runs combined. `reference/opensoldat/client/MapGraphics.pas:707-749`.
- Terrain textures explicitly use **REPEAT on both axes**, with configurable nearest/linear and optional mipmap filtering. Terrain loading disables green color-key; decoded images are premultiplied. `reference/opensoldat/client/MapGraphics.pas:79-117,119-142,280-310`.
- Crucial alpha detail: the **vertex shader premultiplies vertex RGB by its alpha before interpolation** (`color = vec4(in_color.rgb * in_color.a, in_color.a)`); the fragment shader multiplies a premultiplied texture sample by that varying. This differs from interpolating straight RGB and alpha separately then multiplying in the fragment shader. With varying color AND alpha, the pictures differ. `reference/opensoldat/client/Gfx.pas:532-560`; CPU texture premultiplication: `:2445-2467`.
- The renderer uses premultiplied source-over blending: `ONE, ONE_MINUS_SRC_ALPHA`. **No additive particle blend switch was found in the reviewed renderer**; sparks/explosions are normal textured sprite draws with tint/alpha/scale. Do not add additive glow just because it is conventional in modern engines. `reference/opensoldat/client/Gfx.pas:793-796`; `reference/opensoldat/shared/mechanics/Sparks.pas:196-271,333-380,394-449`.
- One basic texture×color shader serves the renderer, with optional **8×8 ordered dithering** added to fragment RGB. There is also a fixed-function compatibility path. No requirement for normal-mapped lighting, bloom, deferred rendering, or a 3D renderer is evidenced. `reference/opensoldat/client/Gfx.pas:530-572,670-683,750-783`.

#### Background and smooth polygon edges

- The background is **six untextured vertices**, interpolating opaque top/bottom colors at world Y=`-d,+d`, where `d=MAX_SECTOR*max(SectorsDivision,ceil(0.5*GameHeight/MAX_SECTOR))`. Its X is normalized 0..1 across the viewport; its Y tracks the world camera. **This is not a screen-fixed CSS gradient**. Beyond its span the framebuffer is cleared to the appropriate top/bottom color based on camera Y. `reference/opensoldat/client/MapGraphics.pas:677-705`; `reference/opensoldat/client/GameRendering.pas:990-1008`.
- Smooth edges use `textures/edges/<terrain-name>` with green color-key, default edge fallback, premultiplication and optional mipmaps. NPOT edge images are padded to power-of-two, retaining a UV subrectangle; default texture wrap is **CLAMP_TO_EDGE**, unlike repeating terrain. `reference/opensoldat/client/MapGraphics.pas:87-96,315-347`; `reference/opensoldat/client/Gfx.pas:2535-2543`.
- Edge generation considers each polygon side. It selects a side when the midpoint does not collide with another polygon and both endpoint alphas exceed 128. It builds a rotated quad anchored at `(0,0.5)`, scales X by **edge length / 90**, and gives each endpoint its polygon vertex color with **alpha×0.75**. It does not merely draw a stroked triangle outline, nor tile a generic line texture. `reference/opensoldat/client/MapGraphics.pas:460-492,617-671`.

#### Exact world draw order

`reference/opensoldat/client/GameRendering.pas:1004-1086` establishes:

1. World-anchored gradient.
2. Background polygon edge quads.
3. Background/transition polygon triangles.
4. Scenery `Level=0` (when background rendering enabled).
5. Bullets, in bullet-slot order.
6. Soldiers/gosteks, in sprite-slot order.
7. Things/items.
8. Sparks, including weather.
9. Scenery `Level=1`.
10. Thing polygon rendering (e.g. cloth/flag geometry).
11. Foreground polygon edge quads.
12. Foreground map polygons.
13. Scenery `Level=2`.
14. Interface/HUD in separate screen-space projection.

Thus ordinary terrain can occlude soldiers, and scenery has **three** layers, not just background/foreground. Sorting all map polygons by texture or all players by Y would change semantics. Props retain original order within their levels; animated scenery is separately stored but indexed to preserve draw order, with its vertices updated together. Prop tint uses map RGB plus prop alpha; transform uses scaleX/Y and negative map rotation, with anchor `(0,1)`. `reference/opensoldat/client/MapGraphics.pas:440-454,495-542,544-588,597-614`.

#### Gostek rendering

- A gostek is **not one sprite-sheet frame**. Its table contains **131 part entries** (138 lines), including mutually exclusive weapons/cosmetics/damage overlays. Each part names image, two skeleton points, normalized pivot `cx,cy`, flexible stretch length, direction-flip behavior, team-texture behavior, color channel and alpha channel. Table order is painter's order. `reference/opensoldat/client/GostekGraphics.inc:1-138`; structure: `reference/opensoldat/client/GostekGraphics.pas:65-104`.
- Position comes from first skeleton point; rotation is `atan2(p2.y-p1.y,p2.x-p1.x)`. Pivot is scaled by image dimensions and sprite scale. Facing left either picks the next image plus `cy=1-cy`, or uses **negative Y scale**, depending on part metadata. Flexible parts scale X by `min(1.5,length(p2-p1)/Flex)`; dreadlocks have special offsets/stretch; final Y receives **+1**. A generic `flipX` on a soldier container is not equivalent. `reference/opensoldat/client/GostekGraphics.pas:435-483`.
- The quad's four positions are explicitly transformed around that pivot; all four vertices get the same per-part tint. Ordinary Phaser Image/Sprite origin, rotation, signed scale, atlas frame and multiply tint can represent this per-part operation [INFERENCE: browser comparison not run]. `reference/opensoldat/client/GostekGraphics.pas:176-209`.
- Shirt, pants, skin, hair and cigar use separate RGB channels; base/blood/grenade alpha are separate. Blood opacity depends on health; realistic-mode visibility can reduce base alpha; grenade alpha is **75% of base**. Team Bravo/Delta choose a second family of part textures in addition to player colors. Jetpack feet, vest, grenades, chains, hair, dead head, weapon clips/fire and helmet interactions change the visibility set. `reference/opensoldat/client/GostekGraphics.pas:238-263,265-338,420-444`; part ordering/pivots: `.inc:18-64`.
- Pose sampling belongs to shared simulation, not Phaser AnimationManager. OpenSoldat evaluates leg/body animation frames into skeleton positions before rendering. `reference/opensoldat/shared/mechanics/Sprites.pas:600-633`.

#### Sparks, weather, interpolation and HUD

- Sparks use a style switch selecting atlas images, animation-frame indices, lifetime-derived scale/rotation/tint/alpha. Some effects draw two overlapping explosion/smoke sprites, not one generic particle frame. `reference/opensoldat/shared/mechanics/Sparks.pas:218-271,394-449`.
- Weather creates ordinary spark styles: rain38, sand39, snow53. Eight are spawned every **17 ticks**, or **34 ticks** at reduced spark settings; velocities are respectively `(0,12)`, `(10,7)`, `(1,2)`, lifetimes **60/80/80 ticks**, camera-relative spawn positions, and a wind sound. Rendering rain/sand/snow uses fixed alpha **105**. `reference/opensoldat/client/WeatherEffects.pas:41-131`; `reference/opensoldat/shared/mechanics/Sparks.pas:355-380`.
- `RenderFrame` receives fractional tick progress. Rendering linearly interpolates old/current camera and mouse, all **24 soldier skeleton point slots**, bullets (position/velocity and timing), sparks (position/lifetime), and thing skeleton points. Kits re-satisfy constraints after interpolation. The original mutates then restores simulation positions; a new TS port should instead derive a render pose without mutating authoritative/predicted state [recommendation]. `reference/opensoldat/client/GameRendering.pas:103-111,775-919,987-988,1086`.
- HUD bars are cropped and rotated texture sprites, with pixel-aligned relative positioning, not world camera sprites. UI may be drawn at logical dimensions or actual render dimensions depending on settings. Main sprites allow mipmaps; interface atlases do not. `reference/opensoldat/client/InterfaceGraphics.pas:427-434,529-572`; `reference/opensoldat/client/GameRendering.pas:1060-1083,1287-1326`.

#### Resolution, camera and filtering

- Defaults are **640×480**, fixed simulation goal **60Hz**, but current OpenSoldat is **not permanently 640×480 logical**. `GameHeight` defaults 480; width becomes `round(clamp(renderAspect,1.25,1.78)*480)`: approximately **600..854 world units**, 640 at 4:3. `reference/opensoldat/shared/Constants.pas:26-37`; `reference/opensoldat/shared/Game.pas:82-86`; `reference/opensoldat/client/Client.pas:779-820`.
- Camera world viewport is `exp(ActualZoom)*(GameWidth,GameHeight)`, centered at CameraX/Y. Increasing ActualZoom means a larger visible world span, i.e. visually zooming out. Zoom is eased each update by one quarter of the difference, snapping within **0.01**. `reference/opensoldat/client/GameRendering.pas:357-364,990-994`.
- Follow camera combines **0.14** position following plus aim-relative offset, with resolution/scope compensation; spectator camera has a distinct rule. A default Phaser `startFollow` is not a faithful replacement. `reference/opensoldat/shared/Constants.pas:51`; `reference/opensoldat/client/UpdateFrame.pas:351-400`.
- Physical render resolution, window resolution and logical world viewport are separate. Offscreen rendering can be MSAA-resolved, aspect-preserving letterboxed and finally sampled nearest or linear. This is not simply CSS stretching a 640×480 canvas. `reference/opensoldat/client/GameRendering.pas:682-705,1089-1143`.
- Nearest vs linear and mipmaps are user-configurable; terrain, scenery and main sprites allow mipmaps, interface sprites do not. A global “pixelArt=true everywhere” assumption is false. `reference/opensoldat/client/MapGraphics.pas:119-142,309-310,331,425-428`; `reference/opensoldat/client/GameRendering.pas:1294,1326`.

### Phaser 4: supported routes and remaining gaps

**Release maturity:** current stable 4.2.1 is six months after the 4.0 release, not an unreleased alpha. Its core has an established ecosystem; its replacement renderer and Mesh2D specifically are much younger. 4.2.1 fixed ESM crashes, ScaleManager resize behavior, stencil issues and tween behavior. “Stable release” does not prove correctness on our workload. https://github.com/phaserjs/phaser/releases/tag/v4.2.1 .

**Docs:** official guides and extensive source JSDoc exist, including renderer and shader guides. Context7 returned a sparse Phaser4 overview and a much richer **4.0.0-rc.6** corpus, which omitted later Mesh2D. The attempted `https://docs.phaser.io/api-documentation/4.2.0/class/gameobjects-mesh2d` returned 404 during this audit. Pin package/source; don't use RC docs as proof of absence. Guides: https://github.com/phaserjs/phaser/blob/v4.2.1/docs/Phaser%204%20Rendering%20Concepts/Phaser%204%20Rendering%20Concepts.md and https://github.com/phaserjs/phaser/blob/v4.2.1/docs/Phaser%204%20Shader%20Guide/Phaser%204%20Shader%20Guide.md .

**Triangle routes:**
- `Mesh2D`: real arbitrary textured 2D triangles, multi-page texture references, GL-oriented UV and flipV, triangle or quad batching. But its per-vertex data has **no color/alpha**, and its default tint is object-wide. Triangle mode does not batch with sprite quads. Quad optimization may reorder triangles; do not use the global pairing strategy blindly on overlapping translucent PMS geometry.
- `BatchHandlerStrip`: built-in lower-level node takes Float32 positions, Float32 UV, **Uint32 per-vertex RGB and Float32 per-vertex alpha**, automatically connects strips with degenerate triangles, uses texture batching and flushes at capacity. It provides evidence the renderer can carry all required vertex data; using this through a small custom GameObject is possible [INFERENCE]. One triangle could be padded to an even four-vertex strip, but this is not as direct/efficient as a triangle-list static buffer. https://github.com/phaserjs/phaser/blob/v4.2.1/src/renderer/webgl/renderNodes/BatchHandlerStrip.js#L133-L178 .
- `RenderNode` custom attributes/shaders or `Extern`: documented escape hatches. Register nodes via render config/manager. **Never make arbitrary raw GL calls inside normal Phaser rendering**, because the renderer tracks state. `Extern` explicitly yields/restores that state. A Shader GameObject is primarily a shader quad, not a replacement arbitrary-mesh API. https://github.com/phaserjs/phaser/blob/v4.2.1/changelog/v4/4.0/MIGRATION-GUIDE.md#1-renderer-pipelines-to-render-nodes .

**Exact alpha fidelity requires more than per-vertex tint availability.** Phaser's default Multi vertex shader passes tint straight through; its fragment tint code multiplies RGB by interpolated alpha later. The OpenSoldat shader premultiplies at vertices. Use a Soldat-specific map shader, or explicitly accept the visual difference (not recommended). Exact source: https://github.com/phaserjs/phaser/blob/v4.2.1/src/renderer/webgl/shaders/Multi-vert.js and https://github.com/phaserjs/phaser/blob/v4.2.1/src/renderer/webgl/shaders/ApplyTint-glsl.js .

**Texture repeat:** `TextureSource.setWrap(REPEAT,REPEAT)` exists, but `WebGLRenderer.setTextureWrap` **silently refuses NPOT repeat**. The check is unconditional, even if a WebGL2 context is supplied. TileSprite has manual wrapping for NPOT/atlas frames, but it is a rectangle-specific shader, not automatic repeating arbitrary PMS geometry. Sources: https://github.com/phaserjs/phaser/blob/v4.2.1/src/textures/TextureSource.js#L329-L358 ; https://github.com/phaserjs/phaser/blob/v4.2.1/src/renderer/webgl/WebGLRenderer.js#L2550-L2581 ; migration guide TileSprite section. This is a real asset-compatibility issue, not a hypothetical: the FileFormats audit measured `mtex_desert.png` as **1536×512**, referenced as `.bmp` by Aero/DesertWind.

**Blending/tint:** native NORMAL, ADD, MULTIPLY, SCREEN; further blends through filters/offscreen composition. Per-corner sprite tint and multiply mode support normal gostek part coloration. Multiplicative tint is distinct from an ADD framebuffer blend. All required baseline sprite behavior is available; special lighting is not needed. Migration guide sections 2/4/8.

**Performance:** built-in mesh batching transforms and copies vertices into a dynamic batch every frame. This is different from OpenSoldat's static terrain buffers transformed on the GPU. Batch capacity is clamped to **65,536 vertices**: at most **21,845 triangles** for a triangle node or **16,384 quads** for a quad node before capacity/configuration flushes. No browser performance benchmark was run. Thousands of triangles are supported by the data path, but “thousands at 144Hz on mobile” is unproven. Sources: https://github.com/phaserjs/phaser/blob/v4.2.1/src/renderer/webgl/renderNodes/BatchHandler.js#L52-L84 ; BatchHandlerTri source above.

### PixiJS v8 and other renderers

| Option | Fit for this workload | Important caveat |
|---|---|---|
| Phaser 4.2.1 | Integrated input/audio/scenes/cameras/loader; native sprites and newer Mesh2D; renderer nodes can implement exact PMS shader. | Still needs custom vertex-color map path and NPOT handling. New Mesh2D types/docs show rough edges. |
| PixiJS v8 | Public `Geometry`/`MeshGeometry` supports positions, UVs, indices and additional named attributes (`aColor`, normalized bytes or float4); custom `Shader` samples repeated terrain and interpolates PMA colors. Static buffers fit Soldat well. | Default MeshGeometry shader does not automatically consume arbitrary aColor: custom shader required. Custom-shader meshes break default sprite batching, so group **consecutive** terrain runs, not one Mesh per triangle. Not a full game engine/audio system. |
| Raw WebGL2 | Most direct translation of 20-byte vertex + static VBO + texture×PMA-color shader; native NPOT repeat, no engine conventions. | Own context restoration, textures, batching, render targets, sprite atlas, input/audio integration. Simple shader is not the whole engine. [INFERENCE: implementation effort] |
| three.js + orthographic camera | BufferGeometry has UV/color/custom attributes; orthographic rendering supports map and sprite quads. | More 3D-oriented conventions: disable depth test/write where painter ordering is required, control transparent sorting/renderOrder, match colorspace and PMA shader. No demonstrated advantage here over Pixi or a small direct renderer. [INFERENCE: fit assessment] |

Pixi exact-version API sources: https://github.com/pixijs/pixijs/blob/v8.21.0/src/scene/mesh/shared/MeshGeometry.ts ; https://github.com/pixijs/pixijs/blob/v8.21.0/src/rendering/renderers/shared/geometry/Geometry.ts ; https://github.com/pixijs/pixijs/blob/v8.21.0/src/rendering/renderers/shared/shader/Shader.ts ; https://github.com/pixijs/pixijs/blob/v8.21.0/src/rendering/renderers/shared/texture/TextureStyle.ts .

Pixi supports both GLSL/WebGL and WGSL/WebGPU shader programs, but **a custom GLSL shader is not automatically WebGPU compatible**: supply both programs to support both backends. Current official renderer guide calls WebGL production-recommended and WebGPU feature-complete but still experimental due to browser inconsistencies: https://pixijs.com/8.x/guides/components/renderers.md . Thus WebGPU is optional future work, not a requirement for a 2D Soldat renderer. Three docs: https://threejs.org/docs/pages/BufferGeometry.html and https://threejs.org/docs/pages/OrthographicCamera.html .

### React and audio

- An official **Phaser4 + React19 + Vite** template with event-bus/ref bridge exists. React menus are compatible; keep frame poses, input sampling and all render objects out of React state. Own one game instance, remove listeners/destroy instance on lifecycle teardown [recommendation]. https://github.com/phaserjs/template-react/blob/main/README.md ; TypeScript version: https://github.com/phaserjs/template-react-ts .
- Phaser Sound is largely a convenience layer over **Web Audio**, with HTML Audio fallback, global sound lifetime, positional sources, listener position, rate/detune and overlapping effects. It is suitable for a first faithful sound implementation; using Phaser audio does not lock gameplay to Phaser physics. Exact Soldat attenuation/channel semantics must still be mapped rather than replaced with an arbitrary 3D panner preset. For Pixi/raw GL use Web Audio directly; do not add Phaser solely for sound. Browser autoplay unlock and suspended audio after backgrounding need explicit UX. https://docs.phaser.io/phaser/concepts/audio .

### Exercised API probe

Installed **phaser@4.2.1**, **pixi.js@8.21.0**, **typescript@7.0.2** only under `/tmp/soldat-research/RenderingPhaser/`.

`api-probe.ts` type-checked Mesh2D construction/triangle mode, BatchHandlerStrip per-vertex colors/alpha/UV, texture wrap API, and Pixi MeshGeometry additional color attribute/Geometry normalized byte attributes/Shader/TextureStyle repeat.

First compile failed because **`Mesh2D.setTint` exists at runtime in Mesh2D.js but is absent from the published TypeScript declarations**. The final probe records this with `@ts-expect-error`, alongside expected missing legacy Mesh/Plane and missing Mesh2D vertex colors; all other exercised signatures compiled. Command:

`bun ./node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --esModuleInterop --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom api-probe.ts`

Final exit success with no diagnostics. **This is a type/API probe only, not a browser render, pixel comparison or benchmark.** No application build/tests were run.

## 2. Research assumptions

| Claim | Verdict | Evidence |
|---|---|---|
| Phaser4 is a current supported production release. | Confirmed, with maturity caveat. | 4.0 stable April10; latest4.2.1 July9; younger rewritten renderer/new Mesh2D. Release links above. |
| Phaser can faithfully draw original maps without significant investigation. | Refuted as an unconditional claim. | Vertex RGBA, PMA interpolation and NPOT repeat gaps; custom map path required. |
| Mesh/Plane exist as in Phaser3. | Refuted. | Removed in4.0. |
| Phaser4 has no textured triangle object. | Refuted for current4.2+. | Mesh2D added June19; older RC docs are stale. |
| Mesh2D solves PMS per-vertex color. | Refuted. | Only x,y,u,v; object-wide tint/alpha. |
| Phaser's normal tint exactly reproduces map alpha gradients. | Refuted. | Original premultiplies vertex colors before interpolation; Phaser default tint multiplies after interpolation. |
| A custom shared simulation can coexist with Phaser rendering/input/audio. | Confirmed architecturally. | Render nodes/React bridge do not require Phaser physics; pose sampling remains in shared sim. No end-to-end implementation tested. |
| Original gostek animations are ordinary sprite-sheet animations. | Refuted. | Skeleton point pairs, pivot/stretch/flip, team image sets and visibility table. |
| Rendering is fixed640×480. | Nuanced. | Defaults640×480; logical height480, clamped aspect-dependent width600..854, explicit camera zoom. |
| A global nearest-neighbor pixel-art setting matches original. | Refuted. | Configurable nearest/linear/mipmaps; distinct interface filtering. |
| Pixi WebGPU can be a drop-in later. | Nuanced. | Backend exists, production guide still recommends WebGL; custom WGSL version required. |
| React menus + Phaser are compatible. | Confirmed. | Official updated template; don't rerender gameplay via React. |
| Phaser audio vs Web Audio is a major competing stack choice. | Nuanced. | Phaser already wraps Web Audio. Faithful gain/pan/channel policy remains custom either way. |

## 3. Hidden assumptions and whether they hold

1. **All map triangles have a uniform vertex tint. Does not hold.** The FileFormats independent corpus audit found 27,825 of32,806 polygons across99 maps have distinct vertex RGBA; `Airpirates.pms` polygon index1 alpha `[255,0,255]`, index591 `[26,26,128]`. This is core compatibility, not exotic mod support. Measurements supplied by FileFormats; see its report for parser artifacts.
2. **Terrain UVs stay inside0..1 / all terrain textures are POT. Does not hold.** The FileFormats audit measured U±26.30078125, V±17.93359375 and1536×512 desert terrain. Clamping silently produces obvious stretched edges.
3. **Ordering can be optimized freely. Does not hold.** PMA transparency and scenery layers are painter-order semantics. Global triangle pairing or sorting by texture may change the image.
4. **Untouched assets means browser image loading alone. Does not hold.** Original resolves case-insensitive paths and PNG overrides for BMP references (`GameRendering.pas:337-354`), applies exact green color-key only to single-frame images (`Gfx.pas:2329-2374`), and decodes animated images with frame delays. Preserve original bytes/source truth, derive renderer resources at import/load time.
5. **Atlas packing can treat terrain like sprites. Does not hold directly.** Terrain repeats its entire image; atlas edges/mipmaps need repeat-aware sampling/gutters. Keep terrain separate initially.
6. **The frame rate controls animation/physics. Does not hold.** Fixed simulation goal60Hz plus fractional render pose. Do not drive skeleton gameplay pose from browser refresh.
7. **Simple camera follow is visually/competitively equivalent. Does not hold.** Aim offsets, aspect cap, scope/zoom and mouse world conversion matter.
8. **Static maps need expensive geometry optimization to hit performance. Not established.** FileFormats measured median299 triangles, max903, median135 props, max500; this is small geometry. Texture memory/overdraw, per-part sprites and loading may matter more. Stress tests should include many players/sparks, not only10,000 terrain triangles.
9. **All assets should be uploaded at boot. Does not hold.** The FileFormats audit measured1066 images, aggregate decoded RGBA393,248,724 bytes (~375MiB), before atlases/mipmaps/browser copies. Lazy-load active-map scenery and shared gameplay assets, not entire repository.
10. **Original OpenSoldat source proves classic1.7 pixel fidelity. Does not hold.** Need a selected reference build and screenshots; source line parity is not screenshot parity.

## 4. Risks and mitigations

| Severity | Risk | Mitigation |
|---|---|---|
| High | Stock Mesh2D drops map vertex color/alpha. | Small dedicated Soldat triangle object/node + shader; fail spike if it needs a Phaser fork. |
| High | Wrong alpha interpolation causes colored/translucent gradients to disagree. | Premultiply color in vertex shader exactly; sample PMA textures; source-over blend; screenshot differing-alpha fixture. |
| High | NPOT repeat silently clamps. | Test1536×512 desert texture with negative/multiple UV wraps. Compare custom repeat shader with proper seam filtering vs derived POT resampling. Do not assume supplying WebGL2 fixes Phaser's explicit guard. |
| High | Shared pose mistakenly replaced by independent client animation. | Sim supplies current/previous skeleton poses and gameplay animation IDs; renderer only interpolates and places parts. |
| Medium | Triangle/texture sorting changes occlusion. | Preserve exact map/layer order and only batch consecutive compatible runs; use triangle-list mode initially. |
| Medium | New renderer APIs/docs/types evolve. | Pin4.2.1, isolate adapter, document the small API surface; type probe exposed real missing declaration. |
| Medium | Browser image decoding/color-key/premultiplication differs. | Asset decoder pipeline with exact green key before PMA, source signature detection, PNG override resolver, golden edge tests. |
| Medium | Texture RAM/mobile fill rate, not triangle count, dominates. | Active-map loading, atlas padding/mips budget, cap DPR after measurement, exercise smoke/scenery overdraw. |
| Medium | Browser lost-context/restored-state failure. | Test loss/restore/rejoin with the custom node; use managed RenderNode or Extern lifecycle. |
| Low | Modern additive/bloom treatment changes original art. | Baseline NORMAL PMA blending and no new lighting; enhancements opt-in only. |
| Low | Audio unlock/loop lifetime/focus mismatch. | Explicit start gesture; central audio lifecycle and voice/channel policy. |

## 5. Concrete recommendations / decisions for the spec

This section preserves recommendations from 2026-10-15. Its conditional renderer choice and proposed experiments describe the research decision space, not today's roadmap or evidence that those experiments passed.

### Renderer decision

The research recommended keeping the Phaser preference **conditional**, with an explicit custom-map-rendering task in the plan. The defensible research commitment was **“Phaser4.2.1 shell + custom SoldatMap renderer + normal part sprites”**, not “Phaser can already render PMS with Mesh2D”. A Phaser engine fork, patches to texture internals, or a full raw-GL renderer hidden inside a Phaser scene were reasons to reconsider **PixiJS v8/WebGL**.

The minimal extension should expose only map vertices `(x,y,u,v,RGBA8)`, ordered texture runs/layers, a camera matrix and texture sampler settings. Preserve the original **20-byte interleaved format** if implementing a static VBO path. A903-triangle map uses **54,180 bytes** of original-layout terrain vertices, so geometry storage itself is negligible. [INFERENCE estimate] custom Phaser adapter/shader **200–500LOC**, render-only map/scenery/gostek integration **1,000–2,000LOC** plus importing/assets/tests; not a fixed-price estimate. The reviewed seven rendering files total **9,509 source lines**, but include font rendering, image packing and extensive old HUD code that should not be mechanically ported if React replaces menus.

For Pixi, the alternative is **custom Geometry + one simple GLSL texture×PMA-vertex-color shader**, grouped by ordered terrain runs, plus standard sprite parts. That is a more natural static geometry API, but does not eliminate asset loading, camera, simulation or sound work.

### Required de-risking spike before spec lock

Build **one original-map viewer and one animated gostek**, not a generic sprite demo. Suggested fixtures:

1. `Airpirates` for differing per-vertex alpha; Aero/DesertWind for NPOT desert repeat; one map with layered scenery/animated props. Add a synthetic single triangle with red/green/blue RGBA `(255,0,0,255),(0,255,0,0),(0,0,255,128)` and UVs spanning negative and>1 values. Keep that test fixture clearly separate from shipped original assets.
2. Exact source shader baseline: vertex `vec4(rgb*a,a)`, fragment `texturePMA*vertexColorPMA`; optional original8×8 dither disabled initially for deterministic comparisons, then enabled as separate setting.
3. Map view must show all three scenery layers and both polygon layers, correct smooth edge math, PMA/no green halo and repeating UVs. Do not use triangle reorder strategy2. Screenshot against selected OpenSoldat reference at the same camera, filtering, resolution and zoom.
4. Gostek must run right/left, aim/rotate, prone/crouch, jetpack, reload, show team variants/tints and dead pose. Render from the **shared pose evaluator** with 60Hz updates and fractional interpolation at60/120/144Hz browser refresh. Never test only an idle standing sprite.
5. Test logical heights480, 4:3 and16:9/clamped aspect, screen DPR1/2, zoom extent `exp(z)`; verify mouse-to-world aim round trips. Support camera0.14 follow and original ease-to-zoom, or explicitly declare a deliberate behavior change.
6. Exercise **903 real map triangles**, **500 props**, proposed32 soldiers×~30 visible parts, proposed512 sparks; also10,000 triangle synthetic stress. These player/particle stress counts are **proposed tests**, not measured typical gameplay. Record CPU frame time, GPU time where available, draw calls, textures and memory. Proposed desktop gate: sustained144Hz at1080p on an agreed machine (6.94ms frame budget); proposed modest/mobile gate:60Hz (16.67ms), agreed device. No success claim before measurements.
7. Force context loss/restore, resize and React unmount/remount; confirm custom buffers/textures recover and only one loop/game instance exists.

**Pass criterion:** no engine source modifications, faithful color/UV/order fixtures, no NPOT seam/clamp defect, sprite/bullet transforms aligned with simulation, acceptable measured device performance. If not, run the **same fixture/data/shader** in Pixi; choose on adapter size and measured behavior rather than marketing support claims.

NPOT alternatives must be explicit: resampling entire image to POT preserves normalized UV period but changes source sampling quality; padding alone changes the repeated domain and is wrong without UV-aware sampling; `fract(uv)` alone creates linear-filter/mipmap seam issues. For highest fidelity, a WebGL2/static geometry route or repeat-aware shader with padded repeated borders and correct derivative behavior is preferable [INFERENCE pending spike].

### Architecture constraints

- Fixed shared simulation **60Hz**, display-independent rendering; authoritative/predicted pose immutable during rendering.
- Logical world height **480**, aspect cap **1.25..1.78** unless user deliberately chooses a new competitive FOV policy. CSS pixels/DPR never determine extra world visibility implicitly.
- Keep React for menus/lobby/settings, engine loop for world and potentially HUD; if importing original custom HUDs is required, preserve their data-driven renderer instead of assuming React replaces it.
- Use Phaser Web Audio first if Phaser survives the rendering spike. Keep game sound events and voice policy independent so renderer choice does not affect simulation.
- Terrain textures separate from sprite atlases initially; explicit nearest/linear, mipmaps and dither settings, no universal pixel-art or additive effects.

## 6. Product questions recorded at research time

1. Which visual/behavior baseline is authoritative: **classic Soldat1.7.1.1** or this **OpenSoldat** checkout, and which filtering/interface settings should golden screenshots use?
2. Does “modern” deliberately change field of view, camera aim offset, HUD and default filtering, or should all remain original by default?
3. What minimum device/browser and target refresh rate must the game satisfy (desktop-only competitive144Hz vs mobile/touch60Hz)?
4. Must original custom interfaces/cosmetics/weather be fully compatible, or are maps/base gostek assets the content boundary? This affects the amount of HUD/data-driven rendering retained.
5. Is a small supported custom Phaser render node acceptable, or is avoiding renderer internals a hard requirement? If the latter, Pixi's public Geometry/Shader route is a better fit than pretending stock Mesh2D preserves vertex RGBA.
