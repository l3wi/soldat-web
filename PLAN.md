# soldat-web — Delivery and release roadmap

This is the current work sequence for contributors and release reviewers. It replaces the completed bootstrap/extraction roadmap; it is not an instruction to recreate the repository or reimplement working features. Implementation is substantially complete, but remaining product gaps and release qualification still block a public launch.

## Sources of truth

- [SPEC](SPEC.md): required behavior, deliberate scope boundaries and acceptance thresholds.
- [Porting status](docs/porting-status.md): implemented features, remaining implementation, native non-goals and qualification gaps.
- This roadmap: work priority, dependencies and exit criteria.
- [Development](docs/development.md) and [Contributing](CONTRIBUTING.md): current setup, commands, change discipline and evidence requirements.
- [Gate reports](docs/gates/) and [research](docs/research/): dated source/evidence records, not a second live plan. Preserve their recorded failures, hashes and limitations; a later implementation does not retroactively pass an old gate.

A source, ABI, wire or content change requires a new frozen candidate and renewed affected checks. The order below is a priority sequence, not permission to keep using evidence from an earlier candidate after a later feature change.

## Implemented baseline

The maintained Pascal core is `sim/opensoldat/{sim,shared}`. `reference/opensoldat` and `reference/base` are optional pristine pinned submodules, not editable product source or browser payload. Application work can consume prepared artifacts without them; rebuilds still need the maintained source and pinned/patched compiler. Import/oracle/native-reference work needs the [appropriate upstream setup](docs/development.md#pinned-upstream-checkouts-and-dependencies).

Current interfaces are simulation ABI/state/render/FX **6** (`0x00010006`) and independent gameplay **wire7**. Node **24** runs authoritative match workers; Bun is tooling. Default population is **12 total humans plus bots**, with **32 supported slots**. The **16-player launch acceptance target** is a qualification requirement, not a change to the default or a proven capacity guarantee.

| Area | Implemented behavior to retain |
| --- | --- |
| Mechanics and presentation | Original Pascal movement, collision, weapons, Things, deaths/respawns, bots and published render/FX views; React/Phaser/Web Audio presentation. |
| Gameplay | All seven modes, native objectives/scoring, rounds/rotations, alternate rules, bonus spawning, balancing, team changes and appearance/loadout retention. |
| Controls and communication | Console/binds/taunts, spectator controls, native gestures, authenticated administration/votes/radio and opt-in WebRTC voice. |
| Menus and admission | Main menu, settings, practice, region-probed quickplay, friend lobbies and join links. These do not implement a filterable public server browser. |
| Online authority | One worker/WASM per match, bounded input/command admission, confirmed command/input relay, prediction/replay, hashes and join/resync full states. AI runs in authority, confirmed and predicted instances; bot controls are not transmitted. |
| Content and tooling | Pinned import/readers, hash-addressed WebP/Opus derivatives, provenance/notices, native oracle/reference tools and artifact-bound qualification harnesses. These do not implement the local browser import workflow. |

Do not restore the superseded snapshot-ACK/delta transport, server-only AI or DM/CTF-only product scope. Detailed implementations and intentional differences belong in the status ledger and [role-divergence ledger](docs/role-divergence-ledger.md), not a duplicated checklist here.

## 1. Freeze a reproducible release candidate

1. Record the source revision, upstream gitlinks, compiler commit/patch, Node/Bun/browser versions, WASM/native/content hashes and ABI/wire versions. Pin checks validate inputs, not gameplay equivalence.
2. Build/import explicitly when inputs changed. Client packaging and server startup consume existing artifacts; neither rebuilds Pascal or imports missing content. Use [serial check layers](docs/development.md#run-checks-in-layers) and fresh output directories rather than changing an artifact under qualification.
3. Keep client admission and server qualification pins aligned with the actual shared WASM. Module-name normalization removes the local output filename without discarding function symbols; a matching ABI or successful compile is not sufficient justification for a new hash.
4. Preserve fixture provenance, raw simulation inputs, source notices and the distinction between `original` and `keyed` RNG. A deterministic keyed run is not original-RNG oracle equivalence.

**Exit:** the intended candidate is reproducible and identified, with affected checks recorded honestly. The [current artifact record](packages/server/README.md#privacy-safe-artifact-verification--2026-10-18) is a starting point, not blanket release acceptance.

## 2. Close release qualification gaps

Use SPEC thresholds unchanged. Run heavy imports, browser/native comparisons and match-worker matrices serially; record interruptions and unrun cases rather than inferring passes.

### Mechanics, state and runtime equivalence

- Requalify the movement/combat corpora under SPEC §6.1–6.2: T1 native/oracle comparison with the same compiler/host, original RNG and the specified AI-off extraction corpus; T2 native/WASM target equivalence; T3 identical WASM state hashes in Node and supported browsers, including mid-run save/load and round trips every 50th tick.
- Extend observations for later modes, rules, gestures, membership and round epochs. Production AI-on authority/confirmed/prediction instances must remain deterministic; historical AI-off corpora do not replace bot qualification.
- Root-cause deviations and record deliberate role/bug-compatibility decisions in the ledger. Do not substitute TypeScript mechanics, omit state or relax thresholds to make a gate pass.

### Browser, rendering, input and content

- Cover current/previous desktop Chrome/Edge/Firefox and Safari ≥26.4. Firefox115 and skipped Safari runs remain historical gaps, not the supported-browser matrix.
- Apply SPEC §6.3's native screenshot comparisons, camera/filtering/pivot/alpha requirements and physical next-rendered-frame input checks. Record native/veteran side-by-side sessions on Arena and Airpirates as well as the later closed-playtest coverage.
- Name the reference desktop/laptop and exercise the 903-triangle / 500-prop / 32-soldier / 512-spark stress scene against R-CLI-1. Replay the movement corpus with rendering enabled at 60/120/144 Hz and compare oracle hashes; verify context loss/restore and React remount without leaks.
- Qualify the release import: 99 maps parse, 97 classic maps have no missing active assets, and Aftermath/Amnesia retain explicit fallback warnings. Verify all 51 POA / 6 PO inputs, deterministic repeated output and the full 164-SFX decode/duration/loop/listening matrix under SPEC §6.5.
- Exercise actual microphone/device permission, capture-stop, mute/channel/revocation and recovery behavior. Synthetic Chromium audio proves only its recorded scenario; qualify Firefox/Safari and operator-configured ICE/TURN, restrictive NAT and relay-only operation separately.

### Network, capacity and operations

- Run SPEC §6.4's full real-packet RTT/jitter/loss/burst/outage/bandwidth matrix on the current relay protocol, including asymmetric delay. Prove correction bounds, input progress, neutral/stuck-input safety, exactly-once events and clean resync.
- Qualify LAN feel and the 100 ms RTT / 15 ms jitter / 1% loss target at 16 players; retain the invariant-safe degraded 250 ms / 5% bursty requirement. The historical [G4 report](docs/gates/G4.md) stays **NOT PASSED**; later localhost correctness is not an impaired-network pass.
- Measure current per-human wire budgets at 16 and 32 humans, excluding join/resync full states as SPEC defines. Enforce zero confirmed-instance hash mismatches in non-adversarial runs, sim+encode p99 <8 ms and tick-lateness p99 <4 ms at 16 players.
- Run 30-minute and two-hour memory/GC soaks plus representative multi-match loads on the intended Linux/VPS deployment. Configuration limits and supported slots are not matches-per-VM or production-capacity measurements.
- Recheck malformed/flooded/replayed inputs, timestamp bounds, capability enforcement, stalled peers, TLS/WSS and secret-safe diagnostics against the release candidate.

### Full-stock bot acceptance

Run **30-minute eight-bot DM and CTF matches on every bot-capable stock map without crashes**, count/report stuck bots, and review native/browser behavior side-by-side on **three maps**. Preserve the recorded five-minute corpus and its stalls; shorter or selected-map probes do not satisfy this full-map criterion. Do not alter original AI or authored waypoints simply to hide stall counts.

**Exit:** every applicable release criterion names its candidate, corpus, platform and measured result. Remaining failures stay release blockers unless an explicit scope decision changes the contract; editing an old report is not a pass.

## 3. Finish agreed browser product gaps

These are remaining implementation, separate from the qualification work above:

| Work | Required end-to-end outcome |
| --- | --- |
| Local custom-map/mod inspection — R-CON-5 | Local-only `.pms`/`.smod` selection/drop and offline viewing with no upload. Integrate the existing PMS/ZIP reader limits, bounded entries/bytes/dimensions, path/case-collision rejection, dependency resolution and explicit mount policy. Parsing an archive alone is not a browser feature or unrestricted mod compatibility. |
| Public server browsing/discovery — R-SRV-1 | Application-specific public-match discovery and a filterable browser UI with real region/mode/population availability and fresh admission. Keep quickplay/friend lobbies working; do not imply native server-list/lobby protocol interoperability. |

**Exit:** real allowed/denied user flows work, affected contracts/docs are updated and the changed candidate repeats its affected checks. Do not add accounts, public map hosting, demos, native RCON/scripts/HUD compatibility or other excluded native capabilities under the guise of finishing these gaps; the [scope boundaries](docs/porting-status.md#native-capabilities-intentionally-not-carried-over-at-launch) remain explicit.

## 4. Prepare operations and complete release review

1. The initial public deployment reuses a shared host at [soldat.bwc.ad](https://soldat.bwc.ad), with direct game TLS/WSS and a four-worker ceiling. See the [deployment record](deploy/README.md#public-deployment-record). Qualify sustained capacity before increasing limits or selecting additional regions/provider sizes; the existing hosting bill and bandwidth allowance remain unverified.
2. Bounded server RTT, tick/simulation/replay/traffic and process summaries are [deployed](deploy/README.md#performance-logging-rollout). Complete R-SRV-3 alerting/crash diagnostics, GC-tail visibility and client state-age/correction monitoring without credentials or unnecessary player-address disclosure. Validate overload, recovery and thresholds under the intended multi-match load; basic logs are not full operational qualification.
3. Establish release automation that checks pins and runs the required artifact-bound qualification with serialized heavy jobs. No root test/build aggregator or enforced CI release gate exists today; the documented manual workflow is not an installed pipeline. Do not claim Linux/CI success without an actual run.
4. Publish under the chosen Soldat Online name with accurate creator attribution, the custom project wordmark and the unofficial/non-endorsement disclaimer. Do not imply official status or verified rights clearance.
5. Review code/per-file licenses, base/map attribution, font notices, transformations and source availability. Classic-installer assets and excluded SDK/code remain outside distribution.
6. Record closed veteran playtests on **five stock maps**, triage blockers into bugs versus ledgered deliberate differences, and complete the visual/audio/content/platform sign-off.

**Release exit:** the final candidate satisfies the agreed product requirements and all applicable qualification, capacity, rights and playtest criteria, with evidence tied to that candidate. Historical reports, a production build or a short localhost smoke cannot substitute for missing acceptance. No cleanup task silently waives a gate or removes unported work.

## Optional experiments, not replacement architecture

WSS remains the implemented gameplay transport; voice WebRTC is separate. Evaluate WebTransport against the same deterministic simulation and real-packet trace only if warranted, retaining ordered command/record recovery and a deliberate admission-time fallback. Compare current Chrome/Firefox/Safari interoperability, connection success and p99 state/input age under 1–3% loss; promote it only for a demonstrated material benefit. Gameplay WebRTC comes after that evaluation, not by confusing it with working voice media.

A Bun/server-runtime or framework comparison likewise needs the same replay/load corpus, hardware, warm-up, memory ceiling and deployed dependency compatibility. Node24 and the custom protocol remain current decisions until an explicit, evidence-backed change; dated research recommendations are not instructions to migrate them.
