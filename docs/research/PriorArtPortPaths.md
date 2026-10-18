# Prior art and port paths: Soldat in a browser

Research date: 2026-10-15. No compiler installation, build, or gameplay smoke test was performed. Repository/API/README claims below are distinguished from runtime verification. FPC was reported absent from the research environment; that observation was not independently checked.

> Historical port-path evaluation. Current requirements, implementation/qualification and delivery sequencing live in [SPEC](../../SPEC.md), [porting status](../porting-status.md) and [PLAN](../../PLAN.md). The maintained Pascal core is now `sim/opensoldat/{sim,shared}`; `reference/opensoldat` and `reference/base` are optional pinned pristine references, not working source trees. The competing full-client/TS/WASM rankings and build suggestions below are dated research recommendations, not current setup instructions.

## 1. Verified facts (with citations)

### 1.1 Most important finding: an original-Pascal browser port already exists

**[humanova/soldat-web](https://github.com/humanova/soldat-web)** is a Pascal-to-WebAssembly Soldat client, not a similarly named website or a speculative engine experiment. It advertises playable Soldat 1.7.1 at **https://play.soldat.live** and a spectator/demo product at **https://soldat.live**. Its README says it starts from the published Soldat client, replaces platform dependencies with browser implementations, reverse engineers 1.7.1 networking, and relays WebSocket traffic to native UDP servers. Those public-server/playability statements are author claims, not independently exercised here.

There is substantial implementation evidence beyond the README:

- [`src/soldatweb.lpr`](https://github.com/humanova/soldat-web/blob/main/src/soldatweb.lpr) is a Pascal `library`, includes the real `Client`, `WebMain`, and explicit exports, and initializes UTF-8 handling.
- [`src/web/WebMain.pas`](https://github.com/humanova/soldat-web/blob/main/src/web/WebMain.pas) calls `StartGame`, `JoinServer`, `GameInput`, and `GameLoop`. The browser calls the original game loop once per animation frame; this is not just a map viewer. It currently catches/logs frame exceptions, a behavior worth reviewing rather than treating as a fidelity guarantee.
- [`src/web/WebExports.inc`](https://github.com/humanova/soldat-web/blob/main/src/web/WebExports.inc) exposes **seven** functions: `soldat_start`, `soldat_join`, `soldat_frame`, `soldat_leave`, `soldat_command`, `soldat_malloc`, `soldat_free`. **It does not export a pure fixed-tick sim API, rollback state API, or an authoritative server module.**
- [`src/web/`](https://github.com/humanova/soldat-web/tree/main/src/web) provides replacement Pascal units named `SDL2`, `dglOpenGL`, `openal`, `PhysFS`, `Steam`, plus heap/Unicode glue. [`web/js/`](https://github.com/humanova/soldat-web/tree/main/web/js) contains `gl.js`, `al.js`, `sdl.js`, `physfs.js`, `vfs.js`, `wasi.js`, `net.js`, and `zip.js`.
- [`build.sh`](https://github.com/humanova/soldat-web/blob/main/build.sh) invokes FPC **3.3.1** `ppcrosswasm32`, uses `-MDelphi -Scgi -O2 -dWEB -dTESTING`, builds separate play/spectator unit directories, and outputs `soldat.wasm` and `soldat-spectate.wasm`.
- [`tools/setup-fpc.sh`](https://github.com/humanova/soldat-web/blob/main/tools/setup-fpc.sh) pins compiler source **`bcd728860dcd953cb6f3bbda788eab07b0d16c85`**, builds `CPU_TARGET=wasm32 OS_TARGET=wasip1`, and patches its internal linker to accept Clang's **`R_WASM_TABLE_NUMBER_LEB`** relocation. This is real interop work, not “turn on a web build flag.”
- [`c/build-c.sh`](https://github.com/humanova/soldat-web/blob/main/c/build-c.sh) compiles FreeType **2.6.1**, stb_image, compiler builtins, and needed wasi-libc objects with Clang to link into the Pascal WASM library. FreeType is patched for unsupported `setjmp/longjmp` overflow handling and an indirect-call signature mismatch; the script explains retaining 2.6.1 to match original glyph shapes/sizing.

Activity: GitHub metadata says created **2026-09-30**, pushed **2026-10-12**; the main-branch commit feed shows latest commit **2026-10-12**, `31bb3d5cb0eaa2eefd20b205b646feb8ba9c92fd`. It is very young and appears author-led (2 stars/0 forks at retrieval), so activity is not a maturity guarantee. Sources: [metadata](https://api.github.com/repos/humanova/soldat-web), [main commit feed](https://github.com/humanova/soldat-web/commits/main.atom).

License: **MIT code**, explicitly **not** one blanket MIT license over bundled data. README says `web/soldat.smod`, `web/assets/`, and older demos/maps mix CC BY 4.0 base content with proprietary freeware Soldat content. Its `build-assets.py --base ...` path without `--v171` is documented as generating a freely shareable content pack. This requires a content audit before redistribution; do not copy its prebuilt pack wholesale.

**Implication:** “No one has done this” is refuted. “A hand-written TS port is obviously the cheapest route” is no longer justified. This repository is the first reuse candidate to evaluate. Its existing 1.7.1 compatibility should not silently become a requirement of our project: the user's new authoritative protocol remains legitimate and independent.

### 1.2 Prior-art inventory

“Map support” below means source/README evidence of parsing or rendering, not proof of every malformed-file edge case. A parser is not a physics implementation.

| Project and URL | Language / license | Activity evidence | Physics / maps / animations completeness | Reuse potential |
|---|---|---|---|---|
| [humanova/soldat-web](https://github.com/humanova/soldat-web) | Pascal + JavaScript + C + Python tooling; MIT code, mixed-license content | Created Sep 30 2026; main commit Oct 12 2026; young | Full original-derived client mechanics/map/gostek pipeline exists; author claims 1.7.1 public-server play. Not an extracted authoritative sim; bit-exact classic fidelity unproven | Highest-value platform bridges, pinned compiler recipe, C linkage, asset tooling, demo/protocol documents, original-derived executable baseline. Could fork client or extract simulation |
| [smokku/soldank](https://github.com/smokku/soldank) | Rust; MIT | Main latest commit Apr 1 2025 `9783f608...` (“Remove Orb networking”); repository pushed Aug 29 2025. [commits](https://api.github.com/repos/smokku/soldank/commits?per_page=3), [metadata](https://api.github.com/repos/smokku/soldank) | README goals are authentic look/feel and feature completeness, **not achievements**. Map/scenery/gostek rendering marked implemented; game UI and server-authoritative networking unchecked. Current `game/physics.rs` uses **Rapier** collider/contact machinery, not just a faithful transcription of Soldat collision. POA animation loader implemented | MIT map/animation/gostek implementation, useful independent interpretation and test expectations. Do not inherit its physics as a proven oracle or assume ready browser multiplayer |
| [kirbysayshi/soldat.js](https://github.com/kirbysayshi/soldat.js) | JavaScript; no license exposed in inspected root | GitHub search metadata reports last push Jun 28 2010; tiny historical prototype | Description says Soldat/JS/WebSockets, but files use custom PNG levels and Mega Man/Zero sprite sheets; `Player.js` has custom mass/thrust/friction physics. No PMS/gostek compatibility established | Historical design curiosity, not a compatibility starting point. No copying without permission/license clarification |
| [urraka/soldat-map](https://github.com/urraka/soldat-map), [viewer](https://urraka.github.io/soldat-map/) | JavaScript/WebGL; no license exposed in inspected root / GitHub license null | GitHub search metadata pushed Jan 18 2024; 36 commits shown on branch page | Actual PMS binary reader, polygons, normals, sectors, props, scenery, colliders, spawns, waypoints. Static viewer, not physics or soldier animation | Existing map-viewer milestone already has prior art. Good independent structural/visual reference; request license before reusing code/assets |
| [urraka/polywonks](https://github.com/urraka/polywonks), [editor](https://urraka.github.io/polywonks/editor/) | JavaScript editor + Go host; no license exposed in inspected root / GitHub license null | Search metadata last push Jul 6 2020; README says WIP | Separate PMS read/write/sectors modules; editor transforms/resources/UI. No gameplay physics or gostek animation claim | Browser parser/writer and editor behavior reference; especially useful sector/serialization cross-check. Not licensed for automatic reuse just because public |
| [jrgp/soldat-pymapper](https://github.com/jrgp/soldat-pymapper) | Python 2 + Qt4 + OpenGL; no license exposed in inspected root | [commit feed](https://github.com/jrgp/soldat-pymapper/commits/master.atom) latest Jan 31 2018; main work 2016 | Author explicitly says unfinished, loading/viewing works, sceneries buggy. `pms/` implements binary structures; reader **skips sector contents**; `write()` is a no-op. No gameplay physics or soldier animation | Independent format interpretation, test_parse.py, packaging dependency discovery. Python 2/Qt4 not suitable runtime stack; license clarification needed |
| [opensoldat/opensoldat](https://github.com/opensoldat/opensoldat) | Object Pascal + C/C++; MIT engine | Sep 26 2026 metadata-only latest commit; substantive FreeBSD work Dec 25 2025; latest published alpha release Apr 21 2024 | Most authoritative accessible source for **1.8-derived**, not untouched 1.7.1 physics. Native build targets; no checked upstream browser target found | Original algorithms, formats, native trace source, collaboration target. The separate humanova fork proves WASM feasibility but is not an official upstream web build |
| [Soldat 2](https://store.steampowered.com/app/474220/Soldat_2/) | Proprietary commercial game, all rights reserved; implementation language not verified | Steam still Early Access, released Sep 22 2020; Steam warns last developer update over 2 years ago; developer says **not actively developed**, looking for developers | Soldat-inspired physics, bots, editor, modes, 2.5D presentation. No original PMS/gostek compatibility or reusable source established | Product/community/UX research only absent separate permission. Not open-source code/assets for this revival |

Primary source details:

- Soldank [`anims.rs`](https://github.com/smokku/soldank/blob/master/client/src/anims.rs) reads original `anims/*.poa`, `NEXTFRAME` / `ENDFILE`, original frame timing and 1-based indices, with coordinate conversion `(-3*x/1.1, -3*z)`. [`game/physics.rs`](https://github.com/smokku/soldank/blob/master/client/src/game/physics.rs) reexports Rapier and constructs triangle/ball colliders from map geometry; different polygon types are mostly collision filters. This alone invalidates treating “authentic” in its goals as measured equivalence.
- urraka viewer [`src/map.js`](https://github.com/urraka/soldat-map/blob/gh-pages/src/map.js) uses little-endian `DataView`, length-prefixed fixed-capacity strings, BGRA, f32 coordinates and explicit alignment skips. Polywonks [`read.js`](https://github.com/urraka/polywonks/blob/master/editor/src/pms/read.js) reads the same full section sequence, and [`buffer.reader.js`](https://github.com/urraka/polywonks/blob/master/editor/src/common/buffer.reader.js) adds a per-value bounds check. Neither should be presumed a hardened untrusted-file decoder: counts and strings need review.
- PyMapper [`pms/__init__.py`](https://github.com/jrgp/soldat-pymapper/blob/master/pms/__init__.py) confirms sector skipping and unimplemented writer. A [2016 bugfix](https://github.com/jrgp/soldat-pymapper/commit/b7d749f11fe254bb2a492c3860120fb661d1edab) records that spawn type is 4 bytes, not 1—useful evidence of why independent parsers help catch layout mistakes.
- [GitHub JS repository search](https://api.github.com/search/repositories?q=soldat+language%3AJavaScript&per_page=30) identified these actual projects when general web search was noisy. [npm registry search](https://registry.npmjs.org/-/v1/search?text=soldat&size=15) returned unrelated editor-package-manager names, not a credible packaged Soldat PMS runtime. **No maintained TS/npm Soldat PMS library was identified**, which is a search result, not proof none exists.

### 1.3 Free Pascal WASM and pas2js are different strategies

- FPC's [official download page](https://www.freepascal.org/download.html) still identifies **3.2.2** as latest stable and distinguishes development snapshots. **Stable Homebrew FPC is not itself the browser cross-compiler**.
- The [official `wasm32-wasip1` snapshot directory](https://downloads.freepascal.org/fpc/snapshot/trunk/wasm32-wasip1/) contains FPC **3.3.1**, latest archive dated **2026-10-14**, approximately **76 MB**, built on x86_64 Linux. There is an older `wasm32-wasi` archive dated 2025; target naming matters.
- FPC's [WebAssembly article](https://www.freepascal.org/~michael/articles/fpcwasm1/fpcwasm1.pdf) describes WASI imports, JS hosts, exports, and native WASM runtimes. It is dated 2021 and is **not** reliable for today's limitations or exact target flags; current snapshots and the actual working-port scripts above are stronger current evidence.
- [`pas2js`](https://gitlab.com/freepascal.org/fpc/pas2js/-/raw/main/README.md) explicitly parses Object Pascal and emits **JavaScript**, not WASM. It uses its own JS-target RTL. It is not a drop-in way to preserve a native Pascal application's pointer layouts and C library bindings. [INFERENCE] Translating pointer-heavy game units with native dependencies would require substantial adaptation; there is no evidence it would be lower effort or more faithful than FPC WASM here.

### 1.4 Dependency viability: compiling CPU code is not porting the platform

Original dependencies are explicit in `reference/opensoldat/README.md:11-18`: FPC 3.2.2, SDL 2.0.12, OpenAL, FreeType 2.6.1, PhysFS 3.0.2, GameNetworkingSockets 1.4.1. Client CMake explicitly finds SDL2, OpenAL and FreeType and includes stb; **SDL_mixer is not the client's listed audio dependency** (`reference/opensoldat/client/CMakeLists.txt:1-4,27-35`).

| Dependency | Browser/WASM viability and consequence |
|---|---|
| SDL2 | Emscripten supports an SDL2 port (`--use-port=sdl2`; older `-sUSE_SDL=2`). This is an **Emscripten** build/runtime facility, not automatically available to any FPC-produced WASM. Need ABI/import/runtime integration, callbacks and browser-owned main loop. Existing Soldat-web instead shadows SDL2 with a Pascal browser shim |
| OpenGL / dglOpenGL | Desktop GL API/framework linkage cannot simply become browser GL. Need compatible WebGL rendering/API mapping. Existing port replaces dglOpenGL with a WebGL2 bridge. Original macOS client explicitly links OpenGL framework (`client/CMakeLists.txt:12-17`) |
| OpenAL | Emscripten provides an OpenAL 1.1 implementation on Web Audio (`-lopenal`). Again, this is not automatic FPC linkage. Existing port uses its own OpenAL/WebAudio bridge; browser audio unlock/user-gesture behavior remains a platform issue |
| FreeType + stb | CPU C code is viable, and Emscripten has FreeType port support, but mixed-toolchain details matter. Existing actual port supplies Clang wasm objects plus libc subset, linker patch, and FreeType fixes. Pinning font rasterizer version can be visually important |
| PhysFS | Archive/filesystem semantics are viable through a browser virtual FS; no native host filesystem access should be assumed. Existing port supplies `PhysFS.pas` + JS VFS/ZIP/IndexedDB implementation rather than requiring native PhysFS unchanged |
| GameNetworkingSockets + OpenSSL/protobuf | Native reliable/unreliable UDP transport. Compiling it does **not** grant browser UDP access. Its use of WebRTC ICE for native NAT traversal is not proof it provides browser DataChannels. Replace transport/protocol or relay. Our project has no original-server compatibility requirement, so avoid importing this dependency into a new sim ABI. Source: [Valve README](https://github.com/ValveSoftware/GameNetworkingSockets), original pinned fetch/build at `reference/opensoldat/shared/libs/GameNetworkingSockets/CMakeLists.txt:40-62` |
| Native threads, scripting, platform services | Do not carry arbitrary native server integrations into the sim. Original server defaults ScriptCore and RCON on (`reference/opensoldat/server/CMakeLists.txt:18-33`); these are separable from golden-trace mechanics work. Browser threading is not a free prerequisite for a single-thread fixed-step simulation |

Current Emscripten documentation was queried through Context7. Primary docs: [building projects/ports](https://emscripten.org/docs/compiling/Building-Projects.html), [audio/OpenAL](https://emscripten.org/docs/porting/Audio.html), [settings/FreeType](https://emscripten.org/docs/tools_reference/settings_reference.html). C/SDL libraries compiled for Emscripten and C objects compiled for WASI may have different expected imports, startup, allocation, exception, and libc behavior; mixing them requires design, not a linker flag. Existing port demonstrates one proven-source recipe using FPC+Clang/WASI rather than full Emscripten.

### 1.5 “Sim-only units” are not already isolated

The math/particle core is smaller than the dependency closure:

- `reference/opensoldat/shared/mechanics/Control.pas:13-54` directly depends on networking, `Server`/`Client`, `ClientGame`, menus/input/sound, game globals, bullets and sprites.
- `reference/opensoldat/shared/mechanics/Sprites.pas:242-279` branches into five network-server units, Server/ServerHelper and optional ScriptDispatcher, or Client/ClientGame/Demo/GameMenus/GameStrings/network/sound/sparks.
- `reference/opensoldat/shared/Parts.pas:77-85` depends on PhysFS and `Game` even though its integration logic looks mathematically self-contained.

**B is a real extraction/refactoring project, not compiling three unmodified `.pas` files.** It can still be cheaper/safer than translating every algorithm because it changes boundaries rather than arithmetic and branches. Existing port's seven-function client facade does not remove this work.

Source-size fact from `wc -l` on named local files: **17,036 lines** across Sprites 4,980; Control 2,199; Bullets 2,875; Things 2,347; Sparks 607; PolyMap 781; MapFile 497; Parts 363; Anims 424; Weapons 1,529; Vector 164; Calc 270. This includes comments/blanks and excludes substantial surrounding networking/game/client code. It is **not** an estimate of required new TS LOC, nor a full game size. Even the four central Sprites/Control/Bullets/Things units total **12,401 lines**.

### 1.6 macOS arm64/headless: supported in principle, not proven “builds today”

- Native macOS build is documented (`reference/opensoldat/README.md:22,51-57`); server-only configuration is explicitly documented (`:59-65`). **Headless server does not require rendering/audio**: root includes client only when `BUILD_CLIENT` is enabled (`reference/opensoldat/CMakeLists.txt:182-188`), and client-specific CMake finds SDL/OpenAL/FreeType.
- FPC stable supports aarch64 macOS on its [official downloads page](https://www.freepascal.org/download.html); [Homebrew formula](https://formulae.brew.sh/formula/fpc) gives **`brew install fpc`**, version **3.2.2**. No installation was performed.
- Suggested reference trace build configuration at research time, **unexecuted**: `cmake -S <source-copy> -B <temporary-build> -DBUILD_CLIENT=OFF -DBUILD_SERVER=ON -DBUILD_SCRIPTCORE=OFF -DBUILD_RCON=OFF -DADD_ASSETS=OFF -DOPENSSL_ROOT_DIR=<brew-prefix>` and build there. Supply intentional pinned assets separately. Important: **copy the source to /tmp too** to preserve the reference checkout: the GNS CMake sets download/build `SOURCE_DIR` beneath `${CMAKE_CURRENT_LIST_DIR}/build`, so an out-of-tree build alone can still write into the original source (`reference/opensoldat/shared/libs/GameNetworkingSockets/CMakeLists.txt:18-21,41,49-62`).
- Caveats: server hardcodes `/usr/local/lib` (`reference/opensoldat/server/CMakeLists.txt:1-7`); README/workflow hardcode `/usr/local/opt/openssl@3` rather than arm Homebrew's typical prefix. Use `brew --prefix`-derived locations rather than copying that path. Root Darwin cross options explicitly name x86_64/i386, not arm64 (`reference/opensoldat/CMakeLists.txt:14-15,147-153`), although a native FPC arm64 build need not use those cross flags.
- `Server.pas:580-583` guards `Set8087CW` with `IFNDEF CPUARM`; whether that is sufficient for the installed compiler's aarch64 definitions/RTL is unverified. Treat as an architecture audit target, not a claimed compile failure.
- macOS workflow uses `macos-latest` but labels its output **macos-x64**, and there is no explicit arm64 build matrix (`reference/opensoldat/.github/workflows/opensoldat.yml:167-192`). A workflow definition is not proof of a current successful arm64 run. Latest published macOS artifact is dated **2024-04-21**, x64-labeled. [release API](https://api.github.com/repos/opensoldat/opensoldat/releases?per_page=4).

**Answer:** a native ARM64 headless reference harness is technically plausible and the compiler is obtainable, but **not verified buildable today without source/build fixes**. Do not make the plan depend on an untested local full-server build. A Linux x64 pinned trace harness/CI runner is a fallback; its numerical equivalence to historical Windows 1.7.1 remains a separate question.

### 1.7 Community activity and likely collaboration

- [Recent upstream commits](https://api.github.com/repos/opensoldat/opensoldat/commits?per_page=5): latest **2026-09-26** adds a contributor; preceding substantive merged change **2025-12-25**, initial FreeBSD support. This is **sporadic maintenance**, not a fast-release project; “recent commit” should not be presented as sustained gameplay development.
- [Latest published release](https://github.com/opensoldat/opensoldat/releases/tag/continuous): OpenSoldat **1.8 alpha dev build**, **2024-04-21**. The tag's name `continuous` does not mean freshly published.
- Discord **https://discord.gg/6TqqtVpRdV**, directly linked in `reference/opensoldat/README.md:4` and server help `Server.pas:566-568`. Live membership/activity was not verified.
- Stronger than generic “open source welcomes contributions”: on [PR #175](https://github.com/opensoldat/opensoldat/pull/175), Shoozza explicitly says **“Thanks for the pull request! I don't have a FreeBSD system but I'm happy to add support”**, reviews it, and merges Dec 25 2025. README explicitly hopes open source empowers community improvements (`README.md:9`).
- [INFERENCE] A focused browser-platform patch, parser fixture, build fix, or trace harness is likely more upstreamable than demanding a wholesale TS engine migration. **No maintainer has agreed to this particular project**, and we should approach humanova as well as OpenSoldat before duplicating their work.

## 2. Research assumptions

| Claim | Verdict | Evidence |
|---|---|---|
| We must hand-port Pascal to a custom shared TS simulation | **Nuanced / not established as best** | Existing full Pascal WASM client and current FPC wasm32-wasip1; shared sim can be a WASM module hosted by TS, not necessarily authored in TS |
| Nobody has already made browser Soldat | **Refuted** | humanova/soldat-web actual source/build/bridges and advertised live deployments; older JS attempts and map viewers |
| A generic physics engine risks the original feel | **Confirmed as an architectural caution, not measured here** | Original bespoke mechanics vs Soldank's Rapier-backed path; “authentic” project goals alone do not prove parity |
| Compiling Pascal is too immature to consider | **Refuted as a blanket statement; nuanced operationally** | FPC current 3.3.1 snapshots and concrete Soldat build; custom compiler patch and bridge maintenance still needed |
| `pas2js` compiles the existing client to WASM | **Refuted** | pas2js emits JS; FPC wasm backend is different |
| Emscripten SDL2 support means OpenSoldat should compile unchanged | **Refuted** | FPC != Emscripten runtime; desktop GL, audio/FS, loop, network bindings need adaptation; existing port replaces these |
| WASM guarantees exact classic physics | **Unknown / false guarantee** | It preserves more source arithmetic/types, but compiler/FPU precision, RNG, changed 1.8 source, side effects and platform glue can still diverge |
| One simulation can be shared by browser and Node | **Confirmed feasibility; implementation unproven for this extracted core** | WASM can be hosted in JS runtimes; existing client not already authoritative server or rollback API |
| Original maps/animations need entirely new format discovery | **Refuted** | Original Pascal plus Rust, JS, Python implementations exist; licensing and edge-case handling differ |
| macOS builds imply this ARM64 workstation can instantly emit golden traces | **Nuanced / unverified** | Compiler available and server flag exists, but paths, architecture guards, native GNS, globals and trace instrumentation need validation |
| OpenSoldat latest `continuous` release is current | **Refuted** | Published alpha asset is Apr 21 2024 despite newer source commits |
| Soldat 2 is an active open-source modernization alternative | **Refuted** | Proprietary; store says not actively developed and seeks developers, remains Early Access |
| Original-server compatibility is required to reuse browser port | **Refuted** | Platform/mechanics code is separable in principle; legacy UDP relay and 1.7.1 protocol are not our stated requirement |

## 3. Hidden assumptions and whether they hold

1. **The chosen language must also be the simulation implementation language. Does not hold.** TS can own menus, protocol, orchestration, tools and renderer while a pinned Pascal WASM module owns authoritative math/state.
2. **A full browser port is inherently more work than a sim port. Does not hold after reuse discovery.** A greenfield full port has the greatest dependency surface; an existing full browser client has already paid much of it. A clean sim extraction still needs significant refactoring.
3. **An accessible reimplementation is a ground-truth oracle. Does not hold.** Soldank has explicitly different physics machinery; viewer parsers intentionally omit gameplay and some omit sectors. Use independent implementations for disagreement detection, original source/reference execution for resolution.
4. **A demo replay supplies golden deterministic input traces. Does not automatically hold.** Soldat-web's demo/protocol documentation is valuable, but packet/demo playback is not necessarily an input-only deterministic re-simulation. Its `TraceLog.pas` is just logging; it does not provide our desired state-trace harness. Specify input+state instrumentation explicitly.
5. **Same WASM binary means safe concurrent rooms without work. Does not hold by default.** Original units use global world state and client/server conditional compilation. [INFERENCE] Start with one WebAssembly instance per match/worker or explicit instance-owned state; never share one set of globals across rooms.
6. **Preserving source means preserving every native feature. Does not hold.** New protocol, authority rules and browser security boundaries are intentional changes. Preserve gameplay math, not unrelated Steam/native scripting/UDP assumptions.
7. **Public GitHub means freely reusable. Does not hold.** Three useful parser/viewer projects expose no clear license in inspected material; contact author or independently implement from MIT original/format facts. Existing browser game's content licensing is mixed.
8. **Recent source implies healthy releases. Does not hold upstream.** Separate source changes, successful CI runs, maintained binaries and community activity; only the first and published-release dates were verified here.
9. **Original means one stable target. Does not hold.** The research considered classic 1.7.1.1, local source is unfinished 1.8, browser port says 1.7.1, Soldat 2 is another product. User-visible fidelity baseline must be chosen before treating divergence as a bug.

## 4. Risks and mitigations

| Severity | Risk | Mitigation |
|---|---|---|
| **High** | Spending months recreating already implemented browser/client/platform work | Evaluate humanova source/build and contact author before spec locks engine/language. First compare shared-code reuse vs custom architecture with explicit acceptance evidence |
| **High** | Extracted WASM client mistaken for authoritative server core | Specify fixed-step authoritative API; identify client-only vs server-only effects and state ownership. Existing client exports are not sufficient |
| **High** | Faithful-looking but wrong physics from TS float semantics, Rapier, 1.8 vs classic, changed RNG | Pin baseline, fixed 60 Hz, inputs/RNG/content hash; compare per-tick state and event traces. Keep original arithmetic/order until discrepancies are explained |
| **High** | Illegal content copied from an otherwise MIT browser repo | Build only audited base pack; keep file-level provenance/attribution and remove proprietary old maps/demo/assets from redistribution |
| **Med** | FPC trunk/custom linker patch becomes unmaintainable | Pin exact compiler/Clang/sysroot and reproduce in container/CI; upstream tiny compiler patch where possible; keep native ABI narrow and documented |
| **Med** | Sim extraction pulls entire platform/network graph back in | Explicitly enumerate input, events, asset reads, RNG and clock imports; remove platform dependencies from simulation boundary rather than mocking an entire client |
| **Med** | Browser/Node state divergence and rollback snapshots missing pointer-owned state | Export versioned serialization/state-hash API; explicit RNG state; avoid raw linear-memory snapshots as a durable format unless allocator/pointer state is intentionally included |
| **Med** | Assuming upstream or a single new fork will maintain our product | Collaborate without dependency on acceptance; own pinned branch/build. New port is ~2 weeks old and not runtime-qualified here |
| **Med** | Golden traces blocked by workstation ARM64/native libs | Source-copy build in /tmp; disable client/scripting/RCON as appropriate; fall back to pinned Linux x64 runner; never label traces classic 1.7.1 unless baseline genuinely matches |
| **Low** | Reimplementing static parser basics | Cross-check MIT original against independent JS/Rust/Python readers and real base corpus; keep security bounds review independent of compatibility |

## 5. Concrete recommendations / decisions for the spec

The rankings and gates in this section were proposed on 2026-10-15. They explain the original decision space; they do not reopen the maintained Pascal WASM core and React/Phaser architecture or establish new roadmap work.

### 5.1 Ranked strategy recommendation

The correct ranking depends on whether Phaser/TS is a means or a non-negotiable product requirement. It was selected before this prior art was known.

**Product-first ranking for “original-feeling browser Soldat”:**

1. **Reuse/adapt the existing full Pascal WASM client (C-reuse), not a fresh full-client port.** Highest immediate preservation/reuse potential. Prove its runtime/fidelity/build and asset provenance; retain or replace its legacy-network boundary according to our explicitly new server design. A fork's existence is not approval to ship unchecked or proof of our authoritative backend.
2. **B: Extract a Pascal WASM simulation, TS host + chosen renderer/menus + Node authority.** Best strategic compromise if modern custom UX/Phaser and a new authoritative protocol remain core requirements. It preserves algorithms/types while removing native platform coupling. Reuse humanova compiler/runtime knowledge, not necessarily its entire client renderer/networking.
3. **A: Hand-written TS port with original Pascal/WASM oracle.** Best tooling/hiring/debugging uniformity, but highest avoidable behavioral transcription risk. Choose deliberately when long-term TS ownership beats extraction/build burden—not just because the renderer uses TS.
4. **C-greenfield: compile untouched full native OpenSoldat client and retrofit all platform/dependencies.** Lowest-ranked: broadest port surface and duplicates a working-source browser solution. No justification unless actual reuse evaluation disqualifies it.

**If Phaser + Node authoritative architecture is fixed:** rank **B > A > C-greenfield**, while **C-reuse remains the independent playable reference and source of platform/asset lessons**. Do not bolt Phaser on top of the full WASM client's existing renderer merely to satisfy a library checkbox; that creates two owners of rendering/input/audio.

| Dimension | A: hand TS simulation | B: Pascal sim WASM | C: full client WASM |
|---|---|---|---|
| Fidelity potential | Good only with exhaustive differential evidence; numeric/ordering translation risk | Highest source-level preservation of mechanics, still requires compiler/baseline parity checks | High for inherited behavior; existing browser fork not proven bit-exact classic |
| Upfront effort [INFERENCE] | Translate/review substantial subset of 17k-line mechanics/format core plus API | Extract coupled dependency graph, expose ABI/state/events; use existing compiler recipe | Fresh: largest surface. Existing fork: smallest path to a playable browser client, but new authority still substantial |
| Maintainability | One main language/toolchain; original fixes manually translated | Two languages + pinned cross-toolchain, narrow boundary can contain complexity | Legacy client/platform code + web bridges; easiest reuse, more inherited globals/UI/protocol coupling |
| Debugging | Browser/Node source-level TS best | Native Pascal reference + WASM host traces; source-level browser debug quality/toolchain must be demonstrated | Cross-language/client-platform debugging; existing author tooling helps but not assumed equivalent to TS |
| Renderer choice | Any JS renderer | Any JS renderer if render pose/state exported | Existing renderer wins reuse; replacing with Phaser forfeits much full-client advantage |
| New authoritative server | Natural architecture, implementation still needed | Same core in browser/Node feasible; server-authority path must be extracted | Existing browser port is a **client + relay**, not our authoritative server |

### 5.2 Spec-level numbers and acceptance gates

- **60 fixed ticks/sec**, preserve `DEFAULT_GOALTICKS = 60` (`reference/opensoldat/shared/Constants.pas:29`). Rendering/rAF cadence is not the simulation clock. Do not tune to 120 Hz and scale constants before establishing baseline behavior.
- Preserve Single/f32 behavior where relevant; original movement constants include `RUNSPEED=0.118`, `FLYSPEED=0.03`, `JUMPSPEED=0.66`, `JETSPEED=0.10` (`Constants.pas:41-50`). These are **not SI-unit velocities** to transplant into Rapier/Phaser physics without original update order.
- Treat the source-size measurement **17,036 lines / 12,401 central mechanics lines** as review surface, not a “small weekend translation” and not a staffing estimate. No defensible fixed implementation-time or generated-TS-LOC estimate was established; any such number would be [INFERENCE].
- Proposed sim ABI [DESIGN RECOMMENDATION, not existing API]: `init(content, rules, seed)`, `step(inputs)`, `read_render_state`, `drain_events`, `save_state/load_state`, `hash_state`, `destroy`. Batch entity state in linear-memory typed-array views rather than per-point JS/WASM calls. Existing web port has seven client lifecycle exports but lacks this contract.
- Proposed differential acceptance [DESIGN RECOMMENDATION]: capture **10,000+ ticks per scenario** (about 167 seconds at 60 Hz), exact input/RNG/config/map hashes, compare position/velocity, animation/frame, jet fuel, weapon/reload timers, collision side effects, bullet/thing events. Cover slope transitions, corners, jump/roll/prone, jet cutoff, explosive recoil, respawn and map polygon special types. Fix tolerance policy from observed baseline numeric behavior; don't silently accept a generic 1-pixel drift.
- For B, qualify **one isolated WASM instance per room/worker initially** [DESIGN RECOMMENDATION]; browser and server may need different feature policies but should not carry accidentally different movement algorithms. Test two instances with different seeds/maps to expose global/host-state leakage.
- For C-reuse evaluation, require clean pinned build, untouched original-map render, original animation alignment, reproducible numeric scenario, and confirmation no proprietary content is redistributed. Then measure browser latency/input/audio/runtime behavior; README screenshots do not satisfy acceptance.
- Native trace tooling should instrument explicit tick/state/input/RNG—not repurpose author log levels or packet demos as if those were deterministic golden traces.
- Preserve no-existing-server-compatibility scope. Reuse code/docs where useful, but legacy reverse-engineered protocol and UDP relay are optional historical capabilities, not reasons to widen the spec.
- Collaboration: first technical outreach to humanova about goals, reproducible build/fidelity and headless extraction; OpenSoldat Discord/PR about narrow extraction/hooks/reference tests. Existing accepted platform PR demonstrates openness, not a commitment to maintain our fork.

## 6. Product questions recorded at research time

1. Is **Phaser/hand-owned TS gameplay** a hard constraint, or may we reuse an original Pascal WASM client if it gets much closer to faithful browser play with less duplicate work?
2. Which experience is the fidelity authority: **classic 1.7.1.1**, **OpenSoldat 1.8**, or specific remembered movement/weapon tuning from another version? “Original” is not sufficiently precise.
3. Is the goal a distinct modern product/new authoritative ecosystem, or would collaborating with/extending an existing browser Soldat project satisfy the revival goal?
4. Are bug-for-bug behaviors important even when they complicate modern architecture, or may selected movement/network/gameplay bugs change if explicitly identified?

Technical unknowns (actual browser-port fidelity, current ARM64 build, exact reusable-code license grants from unlicensed parsers) require direct evaluation or author/maintainer follow-up rather than product preference decisions. This report does not claim those checks were exercised.
