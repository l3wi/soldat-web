# Development

How-to for contributors running and changing this checkout. Commands below run from the repository root unless stated otherwise. This is the current workflow; recipes are not qualification results. Use [PLAN](../PLAN.md) for delivery priorities, [porting status](porting-status.md) for implementation and qualification gaps, and dated gate/package reports for evidence bound to a particular artifact.

## Prepare a checkout

### Prerequisites

- **Node 24.x**, not a later major. The server package requires `>=24 <25` and executes TypeScript directly with Node; Bun is tooling, not the authoritative server runtime.
- **Bun 1.3.14** is the observed development version in the retained gate records. There is no Bun runtime `packageManager` pin; `@types/bun`/`bun-types` 1.3.0 in `bun.lock` are type dependencies, not the executable version. Use the observed version when reproducing receipts and record any different version.
- Git, Bash, Make, and OpenSSL supporting `req -addext` for local TLS.
- For the local compiler recipe: **macOS arm64**, Xcode command-line tools (`xcrun`/SDK), and bootstrap FPC 3.2.2 (`brew install fpc`). The recipe builds pinned FPC trunk; the bootstrap is not the final compiler.
- Alternatively, Docker for the supplied Linux compiler image. Native render-reference capture additionally needs an interactive macOS OpenGL desktop and the dependencies in [its guide](../tools/refclient/README.md).
- For content import: `cwebp` and `dwebp` (Homebrew's `webp` package), plus `ffmpeg` with `libopus`, all on `PATH`. The importer resolves these executables through `PATH`; no workstation-specific installation prefix is required.

Record tool versions when reporting a result:

```sh
node --version
bun --version
openssl version
```

### Pinned upstream checkouts and dependencies

The authoritative pins live in [`pins.json`](../pins.json):

| Source | Commit |
| --- | --- |
| OpenSoldat | `bf43a43bdd7a069e02c906768807f66e621b2888` |
| Base content | `5b6e5bef23f5c0d58fb1d4d887b9b94ebcf799b4` |
| FPC | `bcd728860dcd953cb6f3bbda788eab07b0d16c85` |

The pristine upstream repositories are **optional submodules**: `.gitmodules` registers their official upstream URLs, Git records their pinned gitlink commits, and `pins.json` records the expected baselines. They are development inputs, not the editable simulation core or browser payload.

For application work with an existing `build-out/sim/sim.wasm` and full `dist/content-next` import, leave the references uninitialized:

```sh
bun install --frozen-lockfile
bun run check:pins
```

For content import, oracle or native-reference work, initialize missing/uninitialized references at the recorded commits, **without recursive initialization**:

```sh
bun install --frozen-lockfile
git submodule update --init -- reference/opensoldat reference/base
bun scripts/check-pins.ts --require-references
```

Do not add `--recursive`, use `--remote` or force/reset an existing checkout. Upstream's nested dependencies are not part of this setup. If either path already contains a checkout, inspect its local changes and run the pin checker first; investigate mismatches rather than overwriting, deleting or resetting someone else's work. An existing standalone clone is not an invitation to reclone over it.

Default `bun run check:pins` validates the exact **staged gitlink commits** against `pins.json`, then checks each initialized reference's own HEAD and cleanliness using `git status --porcelain --untracked-files=normal`. Tracked modifications and non-ignored untracked files make the check fail without modifying the checkout. Absent optional references are allowed; empty/uninitialized paths are not mistaken for the superproject's checkout. `bun scripts/check-pins.ts --require-references` additionally requires both checkouts for workflows that use them; unknown flags are rejected.

A pin check does not qualify the patched compiler or built WASM. Keep references pristine/read-only after setup. Intentional upstream-pin changes must update and stage the corresponding tracked gitlink together with the matching `pins.json` change and affected provenance/evidence; do not stage upstream contents as main-repository files.

Product changes belong in the reduced, maintained `sim/opensoldat/{sim,shared}` core, not the pristine submodule. The core retains its upstream license/author notices and per-file exceptions; unused native client/server/dependency source lives in pinned upstream rather than the maintained build tree. Source pruning does not change the browser payload, make Pascal source optional for rebuilds, or remove historical research/receipts and future porting material. KrakenSDK remains excluded from the product; initializing a reference does not authorize redistribution of excluded or differently licensed upstream components.

## Build native and WASM explicitly

On macOS arm64:

```sh
bash sim/build/setup-toolchain-macos.sh
bash sim/build/build-sim.sh all
```

Setup fetches the pinned FPC source, applies `sim/build/patches/fpc-aarch64-unaligned-smallint.patch`, and installs native plus `wasm32-wasip1` backends in ignored `sim/build/.toolchain/`. Its `COMMIT` and `PATCH_SHA256` stamps control reuse. Defaults include four build jobs; `JOBS`, `FPC_PREFIX`, `FPC_SRC`, and bootstrap `PP` are supported by setup.

`all` writes `build-out/sim/sim.wasm` and `build-out/sim/sim-native`. The native build first compiles/runs the signed-packed-load compiler probe; a failure is a compiler problem to resolve, not a test to bypass. For a focused rebuild use `bash sim/build/build-sim.sh wasm` or `bash sim/build/build-sim.sh native`. `FPC` selects the compiler wrapper and `SIM_OUT` selects a separate output directory.

Linux/Docker alternative:

```sh
bash sim/build/build-image.sh
docker run --rm --network none -v "$PWD:/work" -w /work -e FPC=fpc \
  soldat-web/fpc:bcd7288 bash sim/build/build-sim.sh wasm
bash sim/build/build-sim.sh linux
```

The image builds the same pinned/patched compiler. The explicit Docker command writes the shared WASM to `build-out/sim/sim.wasm`; the `linux` wrapper builds native output under `build-out/sim/linux/`. It does **not** build WASM. Linux `SIM_OUT` must remain inside the repository bind mount. These are build recipes, not a claim of byte-identical output across hosts.

### Rebuild versus consume

`bun run --cwd packages/client build`, client preview, server startup and server qualification consume an existing WASM. **None invokes FPC.** A production client build hashes/copies that artifact and content into `dist/client/`; it is not a simulation rebuild or parity proof.

These application commands can run without initialized upstream submodules when their prepared artifacts are available. A simulation rebuild still needs `sim/opensoldat/{sim,shared}` and the pinned/patched compiler; it does not substitute the pristine upstream checkout for the maintained core.

Online admission currently checks a frozen SHA-256 in `packages/client/src/net/browser.ts`; server qualification checks the matching value in `packages/server/scripts/support.ts`. Changing Pascal source alone does not update either artifact or pin. When intentionally replacing the shared artifact, rebuild once, record its actual digest, update affected pins/contracts together and requalify the affected layers. Never change a pin merely to hide an unexplained mismatch. See [contribution rules](../CONTRIBUTING.md#simulation-abi-and-wire-changes).

```sh
shasum -a 256 build-out/sim/sim.wasm
```

FPC embeds the linked output filename in its WASM custom `name` section. The simulation, RNG and spike build entry points run `normalize-wasm-name.mjs` to replace only that module-name subsection with the public basename (`sim.wasm`, `random-conformance.wasm` or `spike.wasm`). Executable sections, function symbols and other metadata are preserved; missing or unexpected name metadata fails the build. Node is therefore required by WASM compilation as well as application tooling; rebuild the compiler image for its Node 24 runtime when upgrading an existing image.

The privacy-safe shared artifact is SHA-256 `13b1d078ce0556fc7e8c4d0a53bbbb7da56f37bad6d19eb9f6803e9559ff745c`. Its standard sections and non-module-name metadata match the previous artifact exactly; the native executable is unchanged. Older qualification receipts retain their original artifact hashes and do not claim a rerun. Full-file identity can still differ for other compiler/input changes; compare actual sections rather than accepting an unexplained mismatch.

Evidence producers use `scripts/receipt-paths.mjs` at the reporting boundary: repository paths become relative and external local-home paths become `<host-home>/…`. Filesystem/subprocess inputs stay absolute. Six retained capture receipts had 776 local repository prefixes removed; their measurements, hashes and outcomes were preserved, with explicit privacy-redaction disclosures rather than new capture claims.

## Import required content

With the media prerequisites and both pinned reference checkouts initialized as above, require their pins before importing:

```sh
bun scripts/check-pins.ts --require-references
bun packages/content/src/cli.ts --base reference/base --out dist/content-next
bun packages/content/src/cli.ts --hash dist/content-next
```

The source-table checkout defaults to `reference/opensoldat`; `--source` and `--pins` select alternate inputs explicitly. The importer uses no network access. It preserves raw simulation inputs, writes a verified manifest/full and per-map packs, and derives browser graphics/audio with provenance. Current content includes both native weapon configurations, all sixteen bot profiles and spawn-derived map-mode metadata; an old render-only import is insufficient.

Run one full import at a time. The importer overwrites its own outputs but does not clean stale objects/unrelated files. Use fresh output directories for comparisons and never overwrite a tree another process is qualifying. Keep the raw simulation files as well as `index.json` and `sim/manifest.json` for server/tests; the production browser bundle alone intentionally omits loose raw files.

Production and current unit-test fixtures use `dist/content-next`. Some historical oracle/render/gate harnesses still intentionally use the retained `dist/content` baseline and artifact-bound corpus. Do not duplicate imports merely to run current unit tests or silently point historical baselines at new content. Read that harness's package/gate instructions before reproducing an old receipt. Full importer details: [content reference](../packages/content/README.md).

## Run the local application

In one terminal:

```sh
bun run --cwd packages/server dev
```

This launcher runs Node, reuses or generates a 30-day self-signed certificate/key in `build-out/server-dev/`, writes `server.json` there, and listens at **`https://127.0.0.1:7443`**. It uses `build-out/sim/sim.wasm`, `dist/content-next`, original-world keyed-RNG DM/Arena defaults and the Local region. It does not rebuild or import anything.

Visit **`https://127.0.0.1:7443/api/ping`** and trust this development certificate in the browser before joining. A Vite proxy accepting a self-signed certificate does not make direct browser WSS trusted. Never disable TLS verification as a production workaround.

In a second terminal:

```sh
VITE_SERVER_URL=wss://127.0.0.1:7443 bun run --cwd packages/client dev --port 5195
```

Open **`http://127.0.0.1:5195/`**. Practice is local; Quick play and friend lobbies use the authoritative server. The launcher allows localhost/127.0.0.1 client origins on ports **5195, 5198 and 5199** only. Use a supported free port rather than Vite's automatic fallback to an origin the server rejects. Do not stop/reconfigure another contributor's existing server; set the endpoint when starting your own process.

### Development environment reference

| Variable | Consumer and effect |
| --- | --- |
| `SOLDAT_SERVER_PORT` | Server dev launcher port, default `7443`; it updates the Local region URL too. |
| `SOLDAT_CONTENT_ROOT` | Server dev launcher and Vite: repository-relative or absolute import directory, default `dist/content-next`. Set consistently in both terminals when overriding. |
| `SOLDAT_SERVER_CONFIG` | Direct Node server startup: path to your JSON config. The dev launcher generates/sets its own config instead. |
| `VITE_SERVER_URL` | Browser API/WSS endpoint, captured when starting Vite or building the client. Use `wss://127.0.0.1:7443` locally. It is public, not a place for credentials. |
| `SOLDAT_SERVER_URL` | Vite-only `/api` HTTPS proxy target, default `https://127.0.0.1:7443`. It does **not** set the browser WSS endpoint. |
| `SITE_URL`, `SITE_INDEXABLE` | Production search/social metadata only; not `VITE_` variables and not server routing. Local/unconfigured builds remain non-indexable. See [client hosting](../packages/client/README.md#publish-search-and-social-metadata). |

For a different local port, for example, start the API with `SOLDAT_SERVER_PORT=7444 bun run --cwd packages/server dev`, then start Vite with `SOLDAT_SERVER_URL=https://127.0.0.1:7444 VITE_SERVER_URL=wss://127.0.0.1:7444 bun run --cwd packages/client dev --port 5198`. Trust `/api/ping` on the new API port.

For an independently managed JSON config:

```sh
SOLDAT_SERVER_CONFIG="$PWD/build-out/server-dev/server.json" node packages/server/src/main.ts
```

That example reuses the launcher's generated local config. Do not run both listeners on the same port. See [server configuration](../packages/server/README.md#configuration-reference) for required fields, operator credentials and opt-in ICE/TURN configuration; no public TURN service is provisioned by default.

## Run checks in layers

Run layers **serially**, stopping on failure. Choose checks matching the changed surface; there is no root `test`, root `build`, lint/format aggregator, or current automated CI enforcing `PLAN.md` gates. These commands are instructions, not verification receipts.

### 1. Pins, types and focused unit contracts

```sh
bun run check:pins
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client check
bun run --cwd packages/protocol test
bun run --cwd packages/server test
bun run --cwd packages/client test
bun scripts/check-pins.ts --require-references
bun test packages/content/src
```

Client tests intentionally isolate globals/module caches via the package script. Some suites load real WASM/raw content; complete setup first. For a small change, run a relevant existing test file directly before the encompassing package suite rather than fabricating a root test command.

Content corpus/import tests require initialized pristine references; require their pins before running that layer. Protocol, server and client work using prepared WASM/content does not require initializing upstream just to run the application.

### 2. Current real-WASM and HTTPS/WSS integration

With the intended shared artifact and full raw import held unchanged:

```sh
node sim/build/check-gameplay.mjs
node --experimental-transform-types --test packages/client/src/net/session.test.ts
bun run --cwd packages/server test:platform
node --experimental-transform-types --test --test-concurrency=1 packages/server/scripts/*.test.ts
```

The last command includes the platform test; omit the separate `test:platform` invocation when running that full serial script suite. `check-gameplay.mjs` supports `SOLDAT_WASM`, `SOLDAT_CONTENT_ROOT` and `GAMEPLAY_OUT`. Server qualification supports `NET_G4_WASM` and `NET_G4_CONTENT` without bypassing its frozen module pin. It generates private certificates and opens real ephemeral HTTPS/WSS listeners; it is not just a codec/mock test.

### 3. Client packaging and browser smoke

```sh
bun run --cwd packages/client test:hosting
bun run --cwd packages/client build
bun run --cwd packages/client verify
# With the local Vite/API servers running and installed Chrome available:
bun run --cwd packages/client capture
```

The build consumes the existing module/import, emits hash-named WASM and precompressed static assets under `dist/client/`, and retains an ordinary large Phaser-chunk warning. `capture` uses a private installed-Chrome profile and existing render fixtures; it does not qualify every browser, refresh rate or multiplayer behavior. Native visual comparisons need their reference images and matching settings; see [reference capture](../tools/refclient/README.md) and [client evidence](../packages/client/README.md#rendering-and-g2-evidence).

For behavior changes, additionally smoke the **actual** flow: practice; two independent online clients; host versus guest permissions; leave/refill; and a real round/map transition. Observe authoritative results, continued connection/identity and hash matches with zero mismatches. Exercise changed gestures/chat/vote/radio/voice controls with eligible and ineligible peers; voice capture/playback needs explicit browser permission and real audio, while Internet traversal requires separately configured TURN. Record what was observed, not just which menu appeared. [Server smoke recipes](../packages/server/README.md#gameplay-smoke-recipes) provide more detail.

### 4. Fidelity and release qualification

Pascal mechanics, compiler, ABI, RNG or render changes need the affected native-oracle/replay/browser comparisons in [`docs/gates/`](gates/), not only unit passes. Oracle and historical matrix harnesses have additional compiler-image, native binary, baseline-content and fixture prerequisites; do not treat them as a clean-checkout one-command test. Retain the original receipts and record a new artifact-bound result. See [current status](porting-status.md) for unported work versus pending qualification and [deployment](../deploy/README.md) for public TLS/capacity checks. A short localhost run is not impaired-network acceptance, physical-input latency, a long soak, or a public-launch authorization.

The two large 10,000-tick Arena bot oracle traces are intentionally generated rather than committed. Before a bot T1 run, follow [verified golden restoration](formats/fixtures-and-traces.md#restore-the-large-bot-goldens). Keep fixture definitions, the frozen input manifest and original capture receipts; regeneration is not permission to replace historical expected hashes.
