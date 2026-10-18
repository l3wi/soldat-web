# Contributing

Start with the [development guide](docs/development.md) and [current porting status](docs/porting-status.md). [`SPEC.md`](SPEC.md) records the intended contracts; [`PLAN.md`](PLAN.md) and `docs/gates/` preserve the original implementation sequence and artifact-specific evidence, not a current completion checklist. Do not implement or delete an unported feature merely because it appears in the status ledger.

## Current process

1. Define the behavior being changed and read the existing implementation, relevant pinned upstream code, package reference and tests. Identify authority, determinism, content and compatibility impacts before editing.
2. Make a focused, reviewable change with its tests and affected documentation. Keep unrelated local work intact; generated artifacts or another contributor's changes are not cleanup targets.
3. Run the relevant [serial check layers](docs/development.md#run-checks-in-layers). Stop on failures and report them accurately. There is no root test/build aggregator or current CI gate to substitute for this evidence; statements in the original plan about CI are planning intent, not an installed workflow.
4. Submit a commit/pull request describing the behavior, touched contracts, actual commands/results, artifact/content/runtime identities where relevant, and remaining qualification gaps. Distinguish automated results, observed browser/human smoke and unexercised recipes. Do not label an old gate receipt as proof of the new artifact.

No particular branch naming or automated release pipeline is prescribed here. Prefer small commits that can be reviewed against the pinned source and reproduced without the originating chat.

## Preserve the Pascal mechanics

The fidelity baseline is **OpenSoldat 1.8 at the commit in `pins.json`**, not the classic installer or a remembered feel. Editable product simulation source is **`sim/opensoldat/`**, including the repository's extraction changes. `reference/` is ignored and **read-only**: import/compare against it, never patch it in place or use it as a hidden build input containing unrecorded fixes.

- Do not hand-port movement, weapons, hit testing, bots or gameplay pose evaluation to TypeScript. TypeScript hosts Pascal, records intent and renders its published views.
- Preserve fixed simulation steps, float/rounding behavior, RNG consumption, input ordering, original raw map normals, POA/PO inputs and complete state serialization. Rendering must not mutate gameplay state.
- Follow the server-role policy and [`docs/role-divergence-ledger.md`](docs/role-divergence-ledger.md). Deliberate original/client/server differences and bug fixes need an explicit decision and evidence, not a silent "improvement."
- Change the real path rather than suppressing an error, changing a golden to match an unexplained regression, or adding a parallel substitute simulation.

## Authority and trust boundaries

The server owns movement, hits/damage, ammo, health, pickups, scores, membership and round transitions. Clients send bounded **intent**, not authoritative position, team identity, permissions or outcomes. Online browser confirmed/predicted instances use the same shared WASM; prediction is not authority.

- Derive identity and slot/team/role from authenticated admission and native state. Preserve ticket lifetimes, nonce membership, host/operator distinctions and bounds/rate limits at ingress and worker boundaries.
- Keep moderation/console requests typed and permission-checked. Do not introduce arbitrary OS commands, RCON/PascalScript execution or token-bearing history/logs. Expected permission/eligibility denials should remain honest, nonfatal feedback.
- Keep direct TLS/WSS and explicit Origin policy. Forwarded headers do not establish trusted source identity; the deployment is direct-listener TLS. Never commit a certificate exception or disable production verification to make a smoke run pass.
- Voice media uses opt-in peer WebRTC with authenticated WSS signaling, separate from gameplay. Preserve capture-stop and stale-peer/channel/mute rules, and disclose NAT/privacy limitations rather than assuming a default hosted relay.

See the [server reference](packages/server/README.md) for concrete policy and the [wire reference](packages/protocol/README.md) for bounds and ownership.

## Simulation, ABI and wire changes

Simulation ABI/state/render/FX are currently **6** (`0x00010006`); the gameplay wire is independently **7**. Version changes are explicit cutovers, not an invitation to leave old aliases or alternate parsers behind.

For a layout, snapshot/save-state or command change:

1. Update the Pascal writer/reader and all affected host layouts, validators, state save/load/hash paths, render/FX/event readers and callers together. Ensure every gameplay-affecting field needed for deterministic restore/replay is serialized.
2. Update [`docs/formats/sim-abi.md`](docs/formats/sim-abi.md), the protocol reference/types/codecs if affected, fixtures and rejection/boundary tests. Wire changes migrate both directions and lobby/match users; reject unsupported versions clearly.
3. Test cross-instance state round trips, deterministic replay, correction/resync and real client/server admission. Current networking uses ordered command/input relay and full state for join/resync; it has no snapshot ACK/baseline/delta protocol. Do not accidentally restore historical transport assumptions.
4. Build the native/WASM artifact explicitly when Pascal/compiler inputs changed. Client build, preview and server startup do **not** rebuild it. Freeze one artifact while running qualification.
5. Measure its actual SHA-256, then update every affected frozen-artifact consumer together. Current online/qualification pins include `packages/client/src/net/browser.ts` and `packages/server/scripts/support.ts`; search for the prior digest before cutover. These are separate from upstream pins in `pins.json` and dependency locks in `bun.lock`.
6. Update affected evidence/status documentation. Keep historical receipts labeled with their original identities; do not rewrite history to imply fresh native/browser/network qualification.

A successful compile or matching ABI number alone does not establish gameplay equivalence. A changed module hash must be explained, not accepted automatically to unblock admission.

## Tests and smoke evidence

Use the smallest meaningful existing test first, then the encompassing affected layer. Include regressions for the actual bug/behavior and invalid or unauthorized requests, not just a happy-path mock. Preserve client test isolation for globals/module caches. Use real WASM for mechanics/replay and real HTTPS/WSS peers for admission, authority and lifecycle. Run heavy imports, browser/native comparisons and match-worker suites serially rather than racing several qualification jobs over shared files.

For presentation changes, preserve native comparison settings and record the actual framebuffer/browser result. For online changes, use multiple independent admitted clients, verify both accepted and denied actions, and inspect authoritative state/hash agreement across membership, correction and map epochs. Browser-only screenshots do not prove server authority or original mechanics. Listening/voice UI without a microphone/audio exchange does not prove media delivery.

An evidence record should identify:

- Repository revision/change set and exact command, relevant environment/configuration and scope.
- Actual WASM/native hashes, simulation ABI, wire version, content identity and fixture/map hashes as applicable.
- Exact Node/Bun/compiler/browser/OS versions used, sample duration/population and retained output paths.
- Pass/fail and observed counts/metrics, plus skipped tests, known warnings and unqualified surfaces.

Keep useful reproducible fixtures and source-level regression tests in version control. Local receipts/large traces/browser profiles belong under ignored `build-out/`; cite them without committing credentials or treating their mere presence as a pass. Historical evidence is valid for its recorded artifact only. Separate missing implementation from missing qualification and explicit non-goals in the [status ledger](docs/porting-status.md).

## Generated files and secrets

Do not stage `reference/`, `node_modules/`, `dist/`, `build-out/`, `sim/build/.toolchain/`, compiled WASM/object/unit files, local browser profiles or temporary captures as source changes. Deliberate committed fixtures under `tests/fixtures/` are different: review their provenance and the behavior they assert before changing them. Do not delete upstream notices, historical research/gates or user-owned generated artifacts as repository cleanup.

Keep local `.env` files, TLS private keys, operator tokens, TURN secrets, deployment credentials and ban/address stores out of commits, screenshots and logs. `VITE_` variables are delivered to browsers, so never put secrets there. Use documented sanitized example configurations when configuration needs review; removing a secret from the latest diff does not make a leaked historical credential safe.

## Licensing and release boundaries

Follow [SPEC §9](SPEC.md#9-content-licensing-branding), upstream headers and the importer's served notices/provenance. Project/OpenSoldat MIT code does not erase per-file exceptions: retain `Vector.pas`'s MPL 1.1 notice and source availability, base content's CC BY 4.0 attribution, Play/Anton/Barlow Condensed OFL notices, and humanova's MIT toolchain attribution. Preserve repository/commit/path hashes, credits and transformation descriptions when changing imported derivatives.

Do not add redistributed classic-installer assets, the excluded Kraken SDK or other unlicensed code/content. Local archive inspection is not redistribution permission. Public user-content hosting needs its own rights/takedown design.

**Soldat Online remains a development/private-build name pending written THD/MM authorization** covering the name, wordmark, domain and store listings. Keep the unofficial/non-endorsement disclaimer; do not use original Soldat logo/title art as project branding. A technical test pass, deploy guide or merged contribution is not branding permission or authorization for a public launch.
