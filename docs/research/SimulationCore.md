# SimulationCore — fidelity and portability research

Scope: read-only inspection of the supplied OpenSoldat/base checkouts, 2026-10-15. No project/reference edits, installs, builds, or runtime fidelity tests were performed. Physical line counts were measured with `wc -l`; recommendations below are proposed decisions/test gates, not achieved results. The clone is shallow (`reference/opensoldat/.git/shallow:1`: bf43a43bdd7a069e02c906768807f66e621b2888) and identifies its branch as develop (`reference/opensoldat/.git/HEAD:1`). Its source explicitly calls itself unfinished 1.8, not the 1.7.1 release (`reference/opensoldat/README.md:9`; `reference/opensoldat/shared/Version.txt:1`).

> Historical inspection of original OpenSoldat, not a description of the current browser core. Use [SPEC](../../SPEC.md), [porting status](../porting-status.md) and [PLAN](../../PLAN.md) for requirements, implementation/qualification and delivery. The maintained core is Pascal WASM in `sim/opensoldat/{sim,shared}`, not the proposed TS rewrite; original server-only AI findings below do not describe current AI, which runs in authority, confirmed and predicted instances. Proposed exclusions and port order are not current feature gaps.

## 1. Verified facts

### 1.1 Loop and module dependency sketch

The default is **60 simulation ticks/second**, with positions/forces authored in tick units, not SI units. `DEFAULT_GOALTICKS=60`, `SECOND=60` (`reference/opensoldat/shared/Constants.pas:29,86`). Particle `TimeStep=1`, not 1/60 (`reference/opensoldat/shared/Anims.pas:380-398`). Multiplying the existing physics constants by a browser frame delta would therefore be wrong.

```text
Wall clock
  client ClientGame.GameLoop [fixed-step accumulator, render fraction]
    -> client UpdateFrame.Update_Frame
  server ServerLoop.AppOnIdle [Number27Timing, network receive, scripts]
    -> server ServerLoop.UpdateFrame

Per simulation tick, ascending stable entity order:
  SpriteParts Euler integration (forces queued previously)
  -> each active Sprites.TSprite.Update
       -> Control.ControlSprite (input interpretation or AI.ControlBot)
       -> animation/body/legs pose, map collision, weapon/timer handling
       -> alive accessory constraints / dead skeleton Verlet
  -> each active Bullets.TBullet.Update (collision, damage, lifetime)
  -> BulletParts Euler integration
  -> each active Things.TThing.Update (collision, Verlet, flags/pickups)
  [client additionally updates Sparks; server additionally spawns bonuses etc.]

Vector -> Calc (geometry)
Vector + Game.Grav -> Parts (Euler/Verlet/constraints + PO loader)
MapFile -> PolyMap (triangle/normal/sector/collider/spawn/waypoint data)
Anims -> POA pose tracks + PO skeletons + particle initialization
Weapons + SharedConfig -> gun definitions + normal/realistic defaults + INI overrides
Game globals <-> Sprites <-> Control <-> Bullets <-> Things
                              -> AI -> Waypoints
The four mechanics units also call network, server/client, audio, effects,
menus, config, logging, and optional ScriptDispatcher directly.
```

Evidence: client accumulator uses `dt=1/GOALTICKS`, loops over elapsed ticks, and computes a clamped render fraction (`reference/opensoldat/client/ClientGame.pas:263-324`); update ordering is `reference/opensoldat/client/UpdateFrame.pas:84-122` and `reference/opensoldat/server/ServerLoop.pas:336-377`. Server receives networking before tick work and invokes script clock handlers before UpdateFrame (`reference/opensoldat/server/ServerLoop.pas:68-79,108-152`). Client Euler integration is gated on `ClientStopMovingCounter`; server controls gate on input silence (`reference/opensoldat/shared/mechanics/Sprites.pas:531-534`). These networking conditions should not become part of a new pure `step(state,input)` function.

**60 Hz is the normal rate, not an invariant of all historical modes.** Bullet time changes GOALTICKS to DEFAULT_GOALTICKS/3, i.e. 20 Hz while retaining tick-authored behavior (`reference/opensoldat/shared/Game.pas:302-311`). Client frames taking >2 seconds are discarded by its timing code (`reference/opensoldat/client/ClientGame.pas:284-285`). A browser suspension policy needs to be explicit, not copied accidentally.

### 1.2 Integration and movement

* **Main soldier position is Euler-integrated**, not Verlet. Euler accumulates gravity, computes `force * inverseMass * TimeStep²`, adds to velocity, adds velocity to position, then multiplies velocity by EDamping and clears forces (`reference/opensoldat/shared/Parts.pas:118-136`). Reordering damping before position changes movement.
* **Skeletons/Things use damped Verlet**: new position is `(1+VDamping)*pos - VDamping*oldPos + force*inverseMass*TimeStep²`, followed by one ordered constraint pass. Constraints split positional error 50/50 for movable endpoints, rather than mass-weighting the correction (`reference/opensoldat/shared/Parts.pas:138-188`). This is a particular solver, not a request to choose a generic Verlet library.
* Soldier input sets forces/animation state, with different grounded/airborne, crouch, prone, roll, jump/backflip and facing-direction branches. Plain right/left sets X force ±RUNSPEED grounded and ±FLYSPEED airborne (`reference/opensoldat/shared/mechanics/Control.pas:1955-2007`). Jump applies -JUMPSPEED only for animation frames 9–14 (`:1929-1937`); it is not an instantaneous uniform impulse. Prone movement force is applied in its animation branch (`:1772-1795`); rolling/backflip likewise gates on animation frames (`:1629-1647`).
* Jets apply -2.5*JETSPEED grounded; airborne non-prone applies upward force, prone applies half-strength horizontal force in facing direction. With reduced gravity, force uses `Grav*2` rather than JETSPEED (`reference/opensoldat/shared/mechanics/Control.pas:350-375`). Fuel decrements once per thrust tick (`:410`); client has an extra 1->0 fuel adjustment (`:411-413`). Fuel recharges +1/tick grounded, +1 every other global tick airborne, and only when Jetpack is not pressed (`reference/opensoldat/shared/mechanics/Sprites.pas:1178-1185`). Runtime capacity is **integer floor(119 * PMS.StartJet / 100)**, not the raw PMS field (`reference/opensoldat/shared/PolyMap.pas:201`).

### 1.3 Constants table (original world units / ticks)

Values are inputs to the particular integration/control branches, **not literal movement speeds in pixels/second**.

| Quantity | Value | Evidence |
|---|---:|---|
| Default simulation rate; time unit | 60 Hz; SECOND=60 | `reference/opensoldat/shared/Constants.pas:29,86` |
| Bullet-time rate | 20 Hz | `reference/opensoldat/shared/Game.pas:302-309` |
| Global gravity | Single 0.06 | `reference/opensoldat/shared/Game.pas:58` |
| Soldier TimeStep / gravity multiplier / Euler damping | 1 / 1 / 0.99 | `reference/opensoldat/shared/Anims.pas:380-383` |
| Bullet TimeStep / gravity multiplier / Euler damping | 1 / 2.25 / 0.99; mass 1 | `reference/opensoldat/shared/Anims.pas:395-398`; `reference/opensoldat/shared/mechanics/Bullets.pas:260-275` |
| Run / uphill run component / air-control force | .118 / .118÷6 / .03 | `reference/opensoldat/shared/Constants.pas:42-44` |
| Vertical jump / directional jump | .66 / .30 | `reference/opensoldat/shared/Constants.pas:45,49` |
| Crouch run / prone move / roll named constants | .118÷.6 / .118×4 / .118÷1.2 | `reference/opensoldat/shared/Constants.pas:46-48` |
| Jets | .10; -0.25 grounded nominal force, -0.10 airborne | `reference/opensoldat/shared/Constants.pas:50`; `reference/opensoldat/shared/mechanics/Control.pas:363-374` |
| Soldier velocity safety cap | ±11 per axis, not vector magnitude | `reference/opensoldat/shared/mechanics/Sprites.pas:1455-1463` |
| Sliding threshold | .2 | `reference/opensoldat/shared/mechanics/Sprites.pas:62` |
| Surface damping X/Y | .970/.970 ordinary; .850/.970 crouch-move; 0/0 standing | `reference/opensoldat/shared/mechanics/Sprites.pas:36-41` |
| Grenade collision surface coefficient | .880 | `reference/opensoldat/shared/mechanics/Sprites.pas:42`; `reference/opensoldat/shared/mechanics/Bullets.pas:1295-1300` |
| Body-part bullet collision radius | 7; frag grenade 8 | `reference/opensoldat/shared/mechanics/Sprites.pas:45`; `reference/opensoldat/shared/mechanics/Bullets.pas:1482-1486` |
| Generic bullet / frag / M2 / flame / melee lifetime | 420 / 180 / 60 / 32 / 1 ticks | `reference/opensoldat/shared/Constants.pas:117-121` |
| Normal / realistic starting health | 150 / 65 | `reference/opensoldat/shared/Constants.pas:77-78` |
| Flag return timeout / flag throw power / regrab cooldown | 1500 ticks / 4.225 / 15 ticks | `reference/opensoldat/shared/Constants.pas:143`; `reference/opensoldat/shared/mechanics/Sprites.pas:65,4733` |
| Object pickup radii | gun 10, bow 20, kit 12, stationary 15 | `reference/opensoldat/shared/Constants.pas:128-131` |
| Current engine caps, not browser performance guarantees | 254 bullets, 90 Things, 558 sparks; particle system slots 560 | `reference/opensoldat/shared/mechanics/Sprites.pas:30-34`; `reference/opensoldat/shared/Parts.pas:34` |
| Map / AI caps | 5000 polys, 255 spawns, 128 colliders; 5000 waypoints ×20 connections | `reference/opensoldat/shared/PolyMap.pas:25,34-35`; `reference/opensoldat/shared/Waypoints.pas:16-17` |

### 1.4 Polygon collision is more than triangle rendering

The current source defines **26 types (0–25)** (`reference/opensoldat/shared/PolyMap.pas:39-64`): normal 0; bullets-only 1; players-only 2; no collision 3; ice 4; deadly 5; bloody-deadly 6; hurts 7; regenerates 8; lava 9; team-specific bullet/player pairs red 10/11, blue 12/13, yellow 14/15, green 16/17; bouncy 18; explodes 19; hurts flaggers 20; only flaggers 21; not flaggers 22; non-flagger-collides 23; background 24; background-transition 25. Keep IDs and behavior separate from names: different query functions filter them differently.

* Soldier collision probes head (X±3.5,Y−12), feet (X±2,Y+2 adjusted for slopes), radius and vertices; ground permanence waits for two matching states (`reference/opensoldat/shared/mechanics/Sprites.pas:861-918`). This is not capsule collision against a polygon mesh.
* Point-in-polygon plus closest-perpendicular response, sector indexing via `Round`, and stable polygon iteration matter (`reference/opensoldat/shared/mechanics/Sprites.pas:2640-2672,2768-2800`). Ice/bouncy bypass ordinary stand/friction logic; bouncy scales the correction by stored bounciness × velocity length (`:2789-2800,2836-2872`). **Bounciness comes from the LENGTH of the third stored normal before normalization**, so recomputing unit normals from triangle vertices destroys gameplay data (`reference/opensoldat/shared/PolyMap.pas:225-240`).
* Background state is per-object transition state, not simply decorative geometry (`reference/opensoldat/shared/PolyMap.pas:66-70`; `reference/opensoldat/shared/mechanics/Sprites.pas:3177-3247`).
* Deadly/bloody-deadly damage is server-only (50+health / 450+health). Hurts/lava subtract 5 with `Random(10)=0`; lava can spawn damaging flame projectiles. Regenerate heals 2 on global ticks divisible by 12; explodes creates M79 explosion and lethal damage; hurts-flaggers subtracts 10 probabilistically (`reference/opensoldat/shared/mechanics/Sprites.pas:3071-3173`). Collision probes can invoke special handlers: don't replace this with a naive fixed damage-per-second volume.
* Realistic mode applies fall damage at downward velocity >3.5, multiplier 5, excluding bouncy (`reference/opensoldat/shared/mechanics/Sprites.pas:2681-2695`).
* `TeamCollides` contains a suspicious blue-bullet condition comparing against YELLOW_BULLETS (`reference/opensoldat/shared/mechanics/Sprites.pas:434-438`). This is observed source, not proof of intended classic behavior. Preserve a regression fixture, then make an explicit bug-compatibility decision; do not silently "correct" it during porting.

### 1.5 Bullets, weapons, grenades

Fourteen bullet styles are explicit: plain, frag, shotgun, M79, flame, punch, arrow, flame arrow, cluster grenade, cluster fragment, knife/chainsaw, LAW, thrown knife, M2 (`reference/opensoldat/shared/Weapons.pas:115-129`). There are **23 internal weapon definitions**, and internal indices differ from external weapon numbers (e.g. COLT index 11 / Num 0; M2 index 18 / Num 30; frag index 20 / Num 50), so a single assumed contiguous weapon ID is unsafe (`:56-113`).

Bullet Update checks map, colliders, sprites, Things, timeout, then later the loop integrates BulletParts. It tracks competing hit distances, not just "first test wins" (`reference/opensoldat/shared/mechanics/Bullets.pas:570-684`). Map collision samples each velocity segment with `max(1,trunc(max(abs(vx),abs(vy))/2.5))` substeps (`:1144-1157`), filters player-only/no-collision/flagger/background geometry (`:1174-1182`), and has style-specific responses. Ordinary bullets can ricochet; arrows stick and cancel gravity; frag/flame bounce with .88 coefficient; rocket/M79 behaviors differ (`:1184-1329`). Lifetime expiry explodes frag/M79/flame-arrow/LAW, but simply kills several other styles (`:653-683`). Most weapons additionally halve hit multiplier after 500 and again after 900 distance, checked every six ticks; Barrett/M79/knife/LAW are exceptions (`:686-713`).

Damage is not simply the INI Damage number: documented normal firearm formula is Damage × current projectile speed × hitbox modifier, with inherited player velocity, decay, vest/bonuses and style-specific damage paths (`reference/base/server/configs/weapons.ini:8-11,22-25`; `reference/opensoldat/shared/mechanics/Sprites.pas:3337-3358`).

**Stats have two layers:** compiled defaults in `Weapons.pas` choose normal or realistic then BuildWeapons (`reference/opensoldat/shared/Weapons.pas:176-217`); server loads configs/weapons.ini or weapons_realistic.ini over those defaults and falls back to compiled defaults (`reference/opensoldat/server/Server.pas:979-999,1170-1179`). INI loads damage, timing, speed, style, startup, bink, movement accuracy, spread, recoil, push, inherited velocity, body modifiers and NoCollision (`reference/opensoldat/shared/SharedConfig.pas:273-301`). The bundled normal config declares **Version=1.7.1**, but that is a weapon-mod version, not proof the engine behaves like 1.7.1 (`reference/base/server/configs/weapons.ini:108-110`). It documents old pre-1.7.1 config scaling incompatibility (`:74-103`).

Grenade throwing is animation-driven and charge-sensitive: Throw frame 15 is pin cue; release at frames 15–36 (forced at 36), speed derives from frame number divided by frag Speed and gains a .65 multiplier before frame 24; directional arc, inherited velocity and polygon/raycast clearance also apply (`reference/opensoldat/shared/mechanics/Sprites.pas:4755-4840`). Merely spawning a grenade at button-down loses the original feel. Cluster detonation spawns **five fragments**, with randomized velocities (`reference/opensoldat/shared/mechanics/Bullets.pas:2331-2340`). The unrelated `CLUSTER_GRENADES=3` constant is not the fragment count.

### 1.6 Animation, hitboxes and ragdoll

**POA is authoritative gameplay input.** Each tick Sprites composes leg/body pose into Skeleton positions from POA frames, then modifies head/hands for aim (`reference/opensoldat/shared/mechanics/Sprites.pas:600-699`). POA loading transforms X by −3/1.1 and its source Z into Y by −3; max 20 pose points ×40 frames (`reference/opensoldat/shared/Anims.pas:21-35,123-133`). Body/legs animation counters advance in simulation ticks (`:72-85`; `reference/opensoldat/shared/mechanics/Sprites.pas:843-844`). Current implementation composes pose before those counters advance: preserve stage ordering in a faithful port.

Bullet collision sweeps line vs circles for body-part IDs **12,11,10,6,5,4,3**, using pose offsets and an extra −2 X correction for non-melee (`reference/opensoldat/shared/mechanics/Bullets.pas:1417-1419,1492-1537`). The muzzle originates at hand point 15 (`reference/opensoldat/shared/mechanics/Sprites.pas:4057-4058`); melee, grenade release, carrying flags also use skeleton points. Thus the server must load/evaluate compatible poses; independent Phaser sprite animation is insufficient.

After death the skeleton fully Verlet-integrates and main position follows skeleton point 12 (`reference/opensoldat/shared/mechanics/Sprites.pas:1371-1385`). Living characters still integrate accessory constraints for points 22/24 (`:1357-1358`). Ragdoll is not only a renderer animation. Whether corpse collisions/weapon interactions should be fully retained in milestone one is a scope decision, not evidence they are safely irrelevant.

### 1.7 Things and AI/scripts

Flags, kits, dropped weapons, parachutes and stationary gun are Things with different skeleton templates, gravity/damping, radii, timers and bullet-collision rules (`reference/opensoldat/shared/mechanics/Things.pas:189-220,385-418,526-552`). Non-static Things collide, then Verlet-integrate, settle using a motion threshold, and attached flags anchor to holder skeleton point 8 (`:707-809`). Server-side pickup chooses the closest eligible player and suppresses useless medkit/full-ammo pickups (`:1636-1725`). Scoring, captures/returns, survival interactions and script events are mixed into this unit; a visual flag alone is not CTF support. Throwing uses directional power 4.225, inherited velocity, collision clearance and 15-tick regrab cooldown (`reference/opensoldat/shared/mechanics/Sprites.pas:4656-4744`).

Bots run on the **server** (`reference/opensoldat/shared/mechanics/Control.pas:332-334`), generating the same TControl-style actions, aiming, firing and pursuing Things (`reference/opensoldat/shared/AI.pas:87-122,405-436`). They use PMS-authored waypoints: movement/jet booleans, path/action, max20 outgoing links (`reference/opensoldat/shared/Waypoints.pas:16-35`), loaded into global BotPath (`reference/opensoldat/shared/PolyMap.pas:221-223`). Waypoint branching uses RNG (`reference/opensoldat/shared/AI.pas:769-775`). AI imports server/network/game globals and is not an isolated pure module (`:40-53`). **Bots are not required to test movement or hit detection:** scripted tick inputs and stationary target soldiers can test those more reproducibly [recommendation]. Bots are desirable for actual offline matches and populated playtests, but can follow the first controllable-soldier slice.

ScriptCore uses PascalScript; the build includes it by default but `BUILD_SCRIPTCORE=False` is supported (`reference/opensoldat/server/CMakeLists.txt:11-29`); server disables sc_enable when compiled without it (`reference/opensoldat/server/Server.pas:767-769`). Vanilla rules therefore do not require executing user scripts. But **scripted-server compatibility is a separate, large gameplay feature**: callbacks can alter damage (`reference/opensoldat/shared/mechanics/Sprites.pas:3353-3355`), respawn position (`reference/opensoldat/server/scriptcore/ScriptDispatcher.pas:686-693`), receive flag drop, clock ticks, etc. Excluding scripts means excluding those custom modes, not preserving all old server gameplay.

### 1.8 Determinism / precision / splits

* Vector components and physics fields are predominantly Pascal **Single** (`reference/opensoldat/shared/Vector.pas:81-96`; `reference/opensoldat/shared/Parts.pas:38-55`); geometry intermediates are Single (`reference/opensoldat/shared/Calc.pas:46-50`), as are health, vest and weapon dynamics (`reference/opensoldat/shared/mechanics/Sprites.pas:128-143`; `reference/opensoldat/shared/Weapons.pas:20-47`). `Extended` appears in wall-clock/render timing and Render parameters (`reference/opensoldat/client/ClientGame.pas:268-269`; `reference/opensoldat/shared/mechanics/Bullets.pas:61`), not an excuse to assume all physics is double precision. FPC confirms Single=4 bytes, Double=8, Real is platform dependent, Extended availability varies: https://docs.freepascal.org/docs-html/current/ref/refsu5.html .
* **No demonstrated bit-exact Pascal→JS equivalence.** JS doubles can drift at collision boundaries. Start with Float32Array state and `Math.fround` at Pascal Single assignments/function results, including local intermediates that feed branch thresholds. Do not claim rounding every arithmetic operator is automatically correct: Pascal compiler/target expression precision, transcendental math and evaluation order still require trace comparison [recommendation/inference]. No evidence this game was originally designed as cross-platform deterministic lockstep.
* Pascal `Round` is ties-to-even, not JS Math.round; sector selection and aim use Round (`reference/opensoldat/shared/mechanics/Sprites.pas:2644-2645`; `reference/opensoldat/shared/mechanics/Control.pas:143-144`). FPC primary docs: https://www.freepascal.org/docs-html/rtl/system/round.html . Port `Round`, `Trunc`, integer div/mod and signed/unsigned ranges deliberately.
* Simulation-affecting randomness includes firing spread (`reference/opensoldat/shared/mechanics/Sprites.pas:4110-4112`), spawn jitter (`reference/opensoldat/shared/mechanics/Things.pas:699-703`), damaging polys (`reference/opensoldat/shared/mechanics/Sprites.pas:3092-3124`), cluster fragments (`reference/opensoldat/shared/mechanics/Bullets.pas:2333-2339`), and bot decisions. Both client/server call Randomize independently (`reference/opensoldat/client/Client.pas:619`; `reference/opensoldat/server/Server.pas:585`). Cosmetic particles/audio also consume Random; particle quality changes can alter consumption (`reference/opensoldat/shared/mechanics/Sprites.pas:2705-2728`). Eagles/shotgun partially seed/save/restore RandSeed using BulletCount (`:4151-4191`), but ordinary spread is not thereby deterministic.
* Shared source is **not one behavior-identical sim compiled twice**. Local input reads SDL and global menu/camera/mouse state (`reference/opensoldat/shared/mechanics/Control.pas:138-180`); bink/self-bink firing inaccuracy is only applied for MySprite client-side (`reference/opensoldat/shared/mechanics/Sprites.pas:4060-4070`), and recoil changes the client cursor (`:4645-4653`). Jet handling has the extra client fuel transition noted above. Damage/pickups/spawns are server-gated. Bullet target history compensation is client-only, server uses current positions (`reference/opensoldat/shared/mechanics/Bullets.pas:2835-2857`). Server push queue has max index0, client125 (`reference/opensoldat/shared/Constants.pas:226-230`), so network-shaped differences are intentional in places, not just cosmetic IFDEFs.
* The loop is fixed-step, but **input event timing, simulation-stage order, global tick parity, RNG consumption, camera-derived aim and compile-time role** all affect outputs. Extract explicit tick inputs and emit effect/network events; do not let rendering call simulation routines or advance animation clocks.

### 1.9 Size / purity / entanglement

Physical LOC measured in supplied files (comments/blanks included; not implementation-effort estimates):

| Unit | LOC | Classification / port concern |
|---|---:|---|
| Vector | 164 | Nearly pure arithmetic; legacy license header must be reviewed independently |
| Calc | 270 | Pure-ish geometry/math, depends only Vector + system Math |
| Parts | 363 | Small solver; imports Game.Grav and PhysFS PO loader, not completely pure |
| Waypoints | 69 | Small query/data module |
| PolyMap | 781 | Geometry/data/query core; map loading plus global BotPath/state |
| MapFile | 497 | Compatibility parser/data, needed before collision |
| Weapons | 1,529 | Mostly data/defaults + derived fields; relatively easy to isolate |
| Anims | 424 | POA loading + animation stepping + global physics/skeleton setup |
| Constants | 604 | Many unrelated UI/network/game constants and IFDEFs |
| SharedConfig | 316 | Weapon INI and other config I/O |
| Game | 947 | Global state, timing, map/match lifecycle; highly entangled |
| Sprites | 4,980 | Movement/pose/health/fire/death/respawn + networking/audio/scripts/UI |
| Control | 2,199 | Input ingestion AND movement/weapon state machine; SDL/UI/net/AI |
| Bullets | 2,875 | Projectile/hit/explosion simulation AND Render/audio/net/latency code |
| Things | 2,347 | Object solver/pickups/scoring + Render/network/scripts |
| AI | 1,126 | Server AI, config/network/global state; optional initial slice |
| Sparks | 607 | Mostly visual effects; exclude from authoritative state |
| Client UpdateFrame / ClientGame | 439 / 577 | Loop/input/camera/net/presentation orchestration |
| ServerLoop | 744 | Authoritative loop/network/scripts/mode orchestration |

Core four mechanics units total **12,401 physical lines**. Listed shared units total **20,098**, and with three loop units **21,858**. This is neither 20K lines of pure simulation nor a weekend 1K-line movement port. [INFERENCE] A faithful TS gameplay core is plausibly **8–15K handwritten TS LOC before tests and netcode/rendering/import tooling**, plus ~1–2K for original AI if retained; extraction and explicit role decisions dominate risk. Those estimates are not measured outcomes or a time commitment. Concrete import entanglement: `reference/opensoldat/shared/mechanics/Sprites.pas:242-279`; `reference/opensoldat/shared/mechanics/Control.pas:13-54`; `reference/opensoldat/shared/Parts.pas:77-85`; `reference/opensoldat/shared/AI.pas:40-53`.

### 1.10 1.8 vs 1.7.1: what is and is not established

The repository itself disclaims equivalence (`reference/opensoldat/README.md:9`). The published manual changelog currently starts at 1.7.1 (2016): bullet/object collision optimization, decimal health/vest, decimal WM values and explicit hitbox modifiers, bullet-time disabled by default. 1.7.0 added rendering interpolation and changed netcode. Earlier versions repeatedly changed sidejump asymmetry, slope friction, roll/prone momentum and flag throwing: https://opensoldat.github.io/manual/changelog.html . These are evidence that "original Soldat feel" is version-specific, not proof of 1.8 deltas.

Later OpenSoldat history does show post-classic mechanics changes: global-gravity multiplication (2022), INF-mode fix (2022), bots attacking regardless of underlying team, and degenerate-normal division guard. Primary commit links:
* https://github.com/opensoldat/opensoldat/commit/2635f7acc4552b60cbfd5bf866122386cdf90965
* https://github.com/opensoldat/opensoldat/commit/a41997cda8a53afb0ccf9d81ba1bec1b9d7c3c11
* https://github.com/opensoldat/opensoldat/commit/0335e7f80c1481dca92ee608e39ac573646fd293
* https://github.com/opensoldat/opensoldat/commit/18c0249f2b68af2f6711946f1e3feb054f4d6c07
Their messages/dates were observed in https://github.com/opensoldat/opensoldat/commits/develop/shared/mechanics/Sprites.pas . I did not diff/reproduce each commit; resulting classic-vs-current quantitative trajectory differences remain **unknown**. GitHub API history returned HTTP403; HTML history succeeded. Official classic downloads remain separately offered at https://www.soldat.pl/en/downloads . A complete 1.7.1→1.8 behavioral diff is not established by these sources or by the shallow checkout.

## 2. Research assumptions

| Claim | Verdict | Evidence / consequence |
|---|---|---|
| Custom shared simulation rather than Phaser physics preserves feel | Confirmed direction | Particular Euler+Verlet, probe/normal collision, frame-gated controls: Parts:118-188; Control:1929-1937; Sprites:861-918 |
| Physics should be fixed 60Hz independent of display refresh | Confirmed for normal play; nuanced globally | Constants:29; ClientGame:287-324; bullet-time 20Hz Game:302-309 |
| Port shared Pascal to a single browser/server TS sim | Nuanced | Shared mechanics are deeply role-/network-/UI-entangled, not pure identical logic: Control:13-54; Sprites:4060-4070; Bullets:2835-2857 |
| Character animation can be presentation-only | Refuted if inferred | POA drives hit circles, aim hands/muzzle/grenade/flag: Sprites:600-699,4057; Bullets:1514-1527 |
| Import map polygons and retain gameplay properties | Confirmed, larger than simple geometry | 26 polytypes, stateful backgrounds, stored-normal bounciness: PolyMap:39-70,225-240 |
| OpenSoldat source is a sufficient exact specification of classic 1.7.1 | Refuted as an equivalence claim | README:9 identifies changed unfinished 1.8; manual version history differs |
| Original weapons.ini alone defines weapon feel | Refuted | Defaults, derived fields, code branches, pose state, velocity, bink/cursor all contribute: Weapons:176-217; SharedConfig:273-301; Sprites:4024-4256 |
| Same TS on both ends automatically guarantees deterministic prediction | Refuted | Need explicit role policy, float rounding, seeded RNG, command ordering; independent original Randomize and client-only paths exist |
| Server authority is a straight port of existing shared code | Nuanced | Server decisions exist but old client owns cursor/bink and role-specific prediction; new input-authoritative behavior requires explicit migration rather than deleting IFDEFs blindly |
| Map viewer -> one soldier -> two-player is a useful order | Confirmed, with gating | Soldier milestone must include shared POA evaluation and fidelity fixtures, not just a sprite plus velocity |
| Bots are required for earliest local fidelity checks | Refuted | AI generates inputs; deterministic recorded commands + targets exercise core without AI [recommendation grounded in AI:87-122] |
| Existing custom server scripts are automatically supported | Refuted | Optional PascalScript APIs/events alter damage, respawn, flags; not implied by map/asset compatibility |

## 3. Hidden assumptions and whether they hold

1. **"Original" names one immutable rule set — does not hold.** 1.6.x movement bugs/fixes, 1.7.1 and current 1.8 differ. Pin a reference build, asset hash, WM hash, game mode and realism/survival settings for every fixture.
2. **Float32 state alone equals Pascal — unverified.** Local Single intermediates, native math, rounding and compiler target can matter. Choose measured fidelity rather than a blanket bit-exact promise.
3. **Rendering/cosmetic RNG is independent — does not hold in existing code.** New architecture should split gameplay/effect RNG; this is an intentional reproducibility change, requiring reference fixtures at event boundaries.
4. **Server can skip original animation assets — false.** Poses determine hit geometry and shot/throw origins. Server/browser must share gameplay-relevant POA and skeleton hashes, not just PMS.
5. **Recomputed polygon normals are harmless — false for bouncy.** Raw normal magnitude encodes bounciness.
6. **Opposite direction key handling is a simple held boolean — false for fidelity.** Existing Control includes first-key/conflicting-key resolution and stateful client flags (`reference/opensoldat/shared/mechanics/Control.pas:64-70,175-180`). Inputs must retain transition/order semantics where required, not only unordered snapshots.
7. **Every miss is projectile geometry — false.** Aim is rounded camera/mouse world state, recoil manipulates cursor, spread includes movement and client-local bink. Define command aim semantics and the server validation model together.
8. **Porting every fixed array verbatim is necessary — no.** Preserve iteration, IDs, caps and solver order first; storage can be preallocated SoA/typed arrays, avoiding per-tick vector object allocation [recommendation]. Do not generalize to variable-delta physics.
9. **All original community server experiences are vanilla — false.** Script hooks can make essential custom gameplay. Treat scripts/modded rules as an explicit compatibility tier.

## 4. Risks and mitigations

| Severity | Risk | Mitigation |
|---|---|---|
| High | Targeting classic feel using changed unfinished source as unquestioned oracle | Pin source and classic playable benchmark; compare movement/combat in named scenarios; track approved deviations |
| High | Extracting only Forces/velocity while omitting animation state and update order | Include leg/body IDs/frame/count, posture, grounding history and POA evaluation in shared authoritative state from soldier milestone |
| High | Copying client-only trust/bink/recoil behavior into a new authoritative server | Make aim/spread/bink/recoil explicit per-player sim inputs/state; move cursor rendering feedback out of authoritative calculations; compare outcome behavior |
| High | RNG/float/rounding divergence breaks reconciliation replay | Seeded gameplay RNG; separate effect RNG; ties-even Round; f32 assignment helpers; deterministic order; record/replay state traces on Node and browser |
| High | Slope/vertex/background/bouncy maps look right but play wrong | Polygon semantics matrix; raw-normal preservation; actual original maps plus adversarial geometry fixtures |
| Medium | Kit/flag/corpse rules balloon a movement prototype | Maintain incremental milestone scope, but preserve entity/pose/event interfaces; don't claim CTF/full combat complete until pickup/capture/death suites pass |
| Medium | Golden-trace harness accidentally measures old net corrections or client input acquisition | Offline deterministic command injection at a defined stage, fixed seed, no networking, no scripts; then separate client/server role fixture suites |
| Medium | Unsupported legacy WM or scripts silently produce different gameplay | Explicit compatibility tier/version checks; support 1.7.1-style INI first and say pre-1.7.1 scaling/PascalScript unsupported unless deliberately implemented |
| Medium | Source-level bugs become "fixes" that break expected tricks | Catalogue suspicious cases and fixture before changing; nominate bug-compatibility policy for movement/weapon edge cases |
| Low | Physics abstraction or allocation-heavy TS creates unnecessary GC | Flat typed arrays/pools; mutation-based vector math; do not clone all 560-slot systems per entity/tick |

## 5. Concrete recommendations / decisions for spec

These architecture options, scope suggestions and gates were recorded on 2026-10-15, before the current implementation. They are retained as research recommendations, not active instructions to defer bots/modes or replace the implemented core.

### Baseline and architecture decisions

1. **Normal-play simulation 60Hz, integer tick, TimeStep=1.** Keep real-time accumulator and render interpolation outside simulation. Start with bullet time disabled (matches 1.7.1 default), but record this as an intentional ruleset choice.
2. Shared pure-ish API: `stepMatch(state, tickCommands, rules, map, gameplayAssets) -> ordered gameplayEvents`; rendering consumes snapshots/events. Stable entity/polygon iteration and allocation-free vector/typed-array storage. Inputs include tick, player, held actions AND ordered transitions where first-/last-key semantics matter, and explicit rounded world aim.
3. Baseline proposal: use **pinned OpenSoldat source mechanics as executable development oracle; classic 1.7.1.1 as independent feel acceptance benchmark**, with deviations logged. Do not promise binary trajectory identity with unavailable 1.7.1 source.
4. **Float32 compatibility policy** from day one: float state + Single assignment-result rounding + tested Pascal rounding/int semantics. Golden-trace evidence decides extra expression rounding. New JS browser/server use the same gameplay RNG implementation and per-match/per-shot deterministic seeds; no Math.random in authoritative gameplay. Deliberately split effect RNG.
5. Bundle/hash PMS, raw gameplay normals, weapon rules, POA animations, PO skeletons and sim/rules version together. Their compatibility is gameplay-critical, not just downloads.
6. For the first weapon, choose a conventional automatic hitscan-looking-but-actually-projectile firearm (e.g. MP5) rather than simultaneously implementing shotgun/Eagles special seeding, LAW posture gates or grenade charging. This is milestone scoping only; full weapon support remains end-to-end work if requested.
7. Vanilla-only initially is viable. Explicitly exclude PascalScript/custom scripted-server compatibility, bot fidelity, realistic/survival/bonus game modes unless desired; do not confuse those exclusions with original asset/PMS compatibility. Original AI should operate later against the same command interface.
8. The [prior-art report](PriorArtPortPaths.md) identifies an existing Pascal/WASM browser port at https://github.com/humanova/soldat-web . **Not independently audited in this simulation inspection.** The research recommended considering reuse/extraction of original WASM mechanics or using it as an oracle before committing to a manual TS rewrite; it did not establish a proven drop-in library.

### Recommended port order

A. Freeze fixtures/rules/hashes; implement numeric semantics, deterministic commands/RNG and Vector/Calc tests.

B. MapFile + PolyMap queries: triangle tests, sector order, raw normals/bounciness, all collision classes, colliders/spawns/waypoints; integrate map viewer without substituting Phaser physics.

C. Parts + Anims + pose composition + Control movement subset, then all move transitions: stand/run/air/jump/sidejump, jets/refill, crouch/prone/roll/backflip, slope/background transitions and grounding. One-soldier acceptance includes correct gameplay pose, not only visuals.

D. Weapons/default/INI derived values + one projectile family; fire/reload/bink/spread/aim; targets and hit circles; health/death/ragdoll; complete grenade/cluster/remaining style branches and push/decay rules before claiming full combat fidelity.

E. Things/weapon drops/kits + flags/returns/captures and chosen game modes; then two-player online with reconciliation using the exact same core and role-neutral gameplay rules. Network code can be developed alongside C/D once input/state contracts are frozen, but it cannot validate physics merely by drawing two soldiers.

F. Original AI/waypoint following and any selected extended modes; custom scripts only as a separately scoped compatibility decision.

### Fidelity-test strategy (proposed, not executed)

* Create a **small instrumented Pascal oracle harness**, outside reference tree or in a controlled fork, with a no-network command-injection path. The existing dedicated server can run without a client build (`reference/opensoldat/README.md:65`), but there is **no demonstrated ready-made deterministic headless trace mode**: it needs instrumentation and injected controls. Baseline builds should disable scripts and time-seeded Randomize or replace it with a fixed recorded seed.
* Capture at **each simulation stage**, not just after render: main pos/oldPos/velocity/force, fuel, posture/facing, OnGround/current/last/permanent, leg/body ID/frame/count, relevant skeleton points, weapon timers/ammo/bink, projectile IDs/positions/velocity/timeouts/damage, Things state, RNG state and emitted events. Record f32 bit patterns in addition to decimal diagnostics.
* Test exact numeric primitives and discrete events/branches. Initially compare numeric absolute errors with proposed diagnostic thresholds **1e-4 world units for short primitive/flat motion cases and 1e-3 for long scenarios**, but **require exact event ticks, grounding transitions, shot counts, damage/pickup/capture outcomes**. Those tolerances are proposed debugging aids, not measured acceptable gameplay drift; any change of collision/event branch fails regardless of distance tolerance.
* Movement corpus: mirrored left/right flat and slope runs; steep/acute/overlapping polygon edges; both-key press orders; tap vs hold jump; directional jumps/backflips; roll→crouch/prone/get-up; jets at capacities 0/1/N and low gravity; refill on ground vs alternating global tick parity; background entry/exit; every team/flag collision type; bounce preserving raw normal magnitude.
* Combat corpus: standing/crouching/prone/moving pose targets; all seven body circles and −2X offset; thin-wall high-speed collision, ricochets, collider/Thing/player ordering; speed-dependent damage decay; burst/reload interruption; shotgun/Eagles seed paths; grenade release at frames14/15/23/24/36; fragment count/velocities; self-boost, vest/friendly-fire, corpse interactions and weapon drops.
* Compare deterministic replay under 30/60/120/144Hz presentation and render disabled; outputs at tick N must match. Run identical command fixtures in Node and real browser engines; preserve no-render gameplay RNG stream. Add online correction/replay tests separately so old networking behavior doesn't obscure sim differences.
* Classic 1.7.1.1 does not expose the source-level harness here. Use timed replay/video and skilled-player comparison for its feel; do not label those measurements bit-exact golden state traces. Keep the current-source oracle and classic acceptance benchmark distinct.

## 6. Product questions recorded at research time

1. Which experience defines "original": classic 1.7.1.1, a specific earlier competitive-era release/weapon mod, or current OpenSoldat behavior with classic presentation?
2. Should known movement/weapon quirks and bugs be reproduced when players rely on them, or intentionally repaired with documented deviations?
3. Which rules/modes are launch-critical: normal CTF/DM only, or realistic/survival/INF/HTF/Rambo, kits/bonuses and stationary guns too?
4. Are bots/offline matches a launch feature, or are deterministic practice inputs and target dummies sufficient until multiplayer works?
5. Does "compatible" include custom weapons.ini and existing PascalScript-driven community modes, or only untouched base content and vanilla rules?
6. Is a WASM-based shared core acceptable if it substantially lowers fidelity risk, or is maintainable TypeScript ownership itself a hard requirement?
