import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { encodeInput, loadSim, loadSimContent, requireStatus, type SimHost } from "@soldat-web/sim-host";
import { type Message } from "@soldat-web/protocol";
import { AuthoritativeMatch } from "../src/match.ts";
import type { WorkerResponse } from "../src/worker-messages.ts";
import { FROZEN_WASM_SHA256, qualificationConfig, type QualificationConfig } from "./support.ts";
import { distribution } from "./workload.ts";

let config: QualificationConfig;
const out = resolve(process.env.NET_G4_LAG_OUT ?? "build-out/net-g4/lagcomp");
let inspector: SimHost;
const firingEvidence: object[] = [];
before(async () => {
  config = await qualificationConfig(out);
  inspector = await loadSim(config.wasm);
  await loadSimContent(inspector, config.manifest, async path => new Uint8Array(await readFile(resolve(config.match.contentRoot, path))));
  requireStatus(inspector.init(config.match.rules, 123456789, 0, 0), "inspector init");
  requireStatus(inspector.loadMap("Arena"), "inspector map");
});
after(async () => { inspector?.dispose(); await writeFile(resolve(out, "firing-evidence.json"), JSON.stringify({ wasmSha256: FROZEN_WASM_SHA256, evidence: firingEvidence }, null, 2)); });

interface Timeline { match: AuthoritativeMatch; responses: WorkerResponse[]; now: bigint; sequence: number; boundary?: { stateHash: bigint; lastConsumedInputSeq: number }; state?: Uint8Array }
async function timeline(weapon = 4, players = 2, diagnostics = false): Promise<Timeline> {
  const responses: WorkerResponse[] = [];
  const match = await AuthoritativeMatch.start(diagnostics ? { ...config.match, rules: { ...config.match.rules, traceCombat: true } } : config.match, response => responses.push(response));
  const result: Timeline = { match, responses, now: 0n, sequence: 0 };
  for (let slot = 1; slot <= players; slot++) match.receive({ type: "join", slot, weapon: slot === 1 ? weapon : 4, secondaryWeapon: 0 }, result.now);
  for (let sample = 0; sample < 64; sample++) match.receive({ type: "rtt", slot: 1, milliseconds: 400 }, result.now);
  return result;
}
function stepTo(timeline: Timeline, target: number): void {
  while (timeline.match.tick < target) {
    timeline.now += 16_666_667n;
    timeline.match.step();
    for (const response of timeline.responses.splice(0)) {
      if (response.type === "ticks") {
        const recipient = response.recipients.find(player => player.slot === 1);
        if (recipient) timeline.boundary = { stateHash: 0n, lastConsumedInputSeq: recipient.lastConsumedInputSeq };
      } else if (response.type === "send" && response.message.type === "state" && response.slot === 1) {
        timeline.boundary = { stateHash: response.message.hash, lastConsumedInputSeq: response.message.lastConsumedInputSeq };
      } else if (response.type === "send" && response.message.type === "events") timeline.match.receive({ type: "eventAck", slot: response.slot, eventId: response.message.events.at(-1)!.id }, timeline.now);
    }
  }
  // This suite compares the actual authoritative boundary after each scripted
  // advance; end-to-end relay fidelity is covered by relay.test.ts.
  // Test-only access to the actual host: simulation state is not sent per tick.
  const internals = timeline.match as unknown as { host: SimHost };
  const host = internals.host;
  const bytes = host.saveState(); if (typeof bytes === "number") throw new Error(`save ${bytes}`);
  timeline.state = bytes;
  timeline.boundary = { stateHash: BigInt(`0x${host.hash()}`), lastConsumedInputSeq: timeline.boundary?.lastConsumedInputSeq ?? 0 };
}

function warmSeparatedPlayers(value: Timeline, shotTick: number): void {
  // Default Arena joins share spawn 1. Genuine controls avoid the melee override.
  for (let tick = 0; tick < shotTick; tick += 10) {
    const seq = ++value.sequence;
    for (const slot of [1, 2]) value.match.receive({ type: "input", slot, frames: [{ seq, tick, viewTick: Math.max(0, tick - 4), input: encodeInput(tick < shotTick - 10 ? { Left: slot === 1, Right: slot === 2 } : {}) }] }, value.now);
    stepTo(value, tick + 10);
  }
}

for (const weapon of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13]) {
  test(`weapon ${weapon}: 12-tick original-mechanics replay matches timely authoritative state`, async () => {
    const timely = await timeline(weapon), late = await timeline(weapon);
    try {
      const shotTick = 600; // Original spawn reloads, including Minigun's 480 ticks, have completed.
      for (const value of [timely, late]) warmSeparatedPlayers(value, shotTick);
      requireStatus(inspector.loadState(timely.state!), "inspect before fire");
      const initialView = inspector.renderView();
      if (typeof initialView === "number") throw new Error("Missing initial firing render view");
      const before = { ammo: initialView.sprite(0).ammo, bullets: initialView.bulletCount, grenades: initialView.sprite(0).grenades, health: initialView.sprite(0).health, flags: initialView.sprite(0).flags, x: initialView.sprite(0).posX, y: initialView.sprite(0).posY, otherX: initialView.sprite(1).posX, otherY: initialView.sprite(1).posY };
      const frame = { seq: timely.sequence + 1, tick: shotTick, viewTick: shotTick - 4, input: encodeInput({ Fire: true, MouseAimX: 300, MouseAimY: -100, MouseDist: 500 }) };
      timely.match.receive({ type: "input", slot: 1, frames: [frame] }, timely.now);
      // A single logical fire edge: release on the following tick in both histories.
      stepTo(timely, shotTick + 1);
      timely.match.receive({ type: "input", slot: 1, frames: [{ seq: frame.seq + 1, tick: shotTick + 1, viewTick: shotTick - 3, input: encodeInput({}) }] }, timely.now);
      stepTo(timely, shotTick + 2);
      requireStatus(inspector.loadState(timely.state!), "inspect after fire");
      const firedView = inspector.renderView();
      if (typeof firedView === "number") throw new Error("Missing fired render view");
      let ownedProjectiles = 0;
      for (let index = 0; index < firedView.bulletCount; index++) if (firedView.bullet(index).owner === 1) ownedProjectiles++;
      const after = { ammo: firedView.sprite(0).ammo, bullets: firedView.bulletCount, ownedProjectiles, grenades: firedView.sprite(0).grenades, reloadTicks: firedView.sprite(0).reloadTicks };
      const actualFireObserved = after.ammo < before.ammo || ownedProjectiles > 0;
      if (![8, 10, 13].includes(weapon)) assert.ok(actualFireObserved, `Immediate-fire weapon ${weapon} did not really fire`);
      firingEvidence.push({ weapon, before, after, actualFireObserved, scope: actualFireObserved ? "real original firing plus late/timely state equality" : "equality-only; one-tick edge does not complete original startup/stance firing gate" });
      stepTo(timely, shotTick + 12); stepTo(late, shotTick + 12);
      late.match.receive({ type: "input", slot: 1, frames: [frame] }, late.now);
      const metrics = late.match.takeLagMetrics();
      assert.equal(metrics.replayTicks, 12); assert.equal(metrics.rejectedShots, 0); assert.equal(metrics.replayMs.length, 1);
      stepTo(timely, shotTick + 14); stepTo(late, shotTick + 14);
      assert.equal(late.boundary?.stateHash, timely.boundary?.stateHash, `weapon ${weapon} late/timely state differs`);
    } finally { timely.match.dispose(); late.match.dispose(); }
  });
}

test("historical grenade intent replays the original throwing animation", async () => {
  const timely = await timeline(), late = await timeline();
  try {
    stepTo(timely, 60); stepTo(late, 60);
    const frame = { seq: 1, tick: 60, viewTick: 56, input: encodeInput({ ThrowNade: true, MouseAimX: 300, MouseAimY: -100, MouseDist: 500 }) };
    timely.match.receive({ type: "input", slot: 1, frames: [frame] }, timely.now);
    stepTo(timely, 61);
    timely.match.receive({ type: "input", slot: 1, frames: [{ seq: 2, tick: 61, viewTick: 57, input: encodeInput({}) }] }, timely.now);
    stepTo(timely, 72); stepTo(late, 72);
    late.match.receive({ type: "input", slot: 1, frames: [frame] }, late.now);
    assert.equal(late.match.takeLagMetrics().replayTicks, 12);
    stepTo(timely, 74); stepTo(late, 74);
    assert.equal(late.boundary?.stateHash, timely.boundary?.stateHash);
  } finally { timely.match.dispose(); late.match.dispose(); }
});

test("delayed grenade plus genuine current held frames produces a real grenade without duplicate ammo", async () => {
  const timely = await timeline(), late = await timeline();
  try {
    stepTo(timely, 60); stepTo(late, 60);
    requireStatus(inspector.loadState(timely.state!), "inspect initial grenade");
    const initial = inspector.renderView();
    if (typeof initial === "number") throw new Error("Grenade fixture view unavailable");
    const beforeAmmo = initial.sprite(0).grenades;
    const input = encodeInput({ ThrowNade: true, MouseAimX: 300, MouseAimY: -100, MouseDist: 500 });
    const frame = { seq: 1, tick: 60, viewTick: 56, input: encodeInput({ ThrowNade: true }) };
    timely.match.receive({ type: "input", slot: 1, frames: [frame] }, timely.now);
    stepTo(timely, 72); stepTo(late, 72);
    late.match.receive({ type: "input", slot: 1, frames: [frame] }, late.now);
    assert.equal(late.match.takeLagMetrics().replayTicks, 12);
    let sequence = 1;
    for (let tick = 72; tick <= 90; tick++) {
      const held = { seq: ++sequence, tick, viewTick: tick - 4, input };
      for (const value of [timely, late]) {
        value.match.receive({ type: "input", slot: 1, frames: [held] }, value.now);
        stepTo(value, tick + 1);
      }
    }
    for (const value of [timely, late]) {
      value.match.receive({ type: "input", slot: 1, frames: [{ seq: sequence + 1, tick: 91, viewTick: 87, input: encodeInput({}) }] }, value.now);
      stepTo(value, 94);
    }
    requireStatus(inspector.loadState(timely.state!), "inspect actual grenade launch");
    const after = inspector.renderView();
    if (typeof after === "number") throw new Error("Launched grenade view unavailable");
    let grenades = 0;
    for (let index = 0; index < after.bulletCount; index++) if (after.bullet(index).owner === 1 && [2, 9, 10].includes(after.bullet(index).style)) grenades++;
    const result = { wasmSha256: FROZEN_WASM_SHA256, beforeAmmo, afterAmmo: after.sprite(0).grenades, grenadeProjectiles: grenades, equal: timely.boundary?.stateHash === late.boundary?.stateHash, timelyHash: timely.boundary?.stateHash.toString(16), lateHash: late.boundary?.stateHash.toString(16), initialTick: 60, insertedAtTick: 72, actualHeldFromTick: 72, actualHeldThroughTick: 90, note: "Repeat gaps clear ThrowNade; actual held frames, not fake held repeats, complete the native animation" };
    await writeFile(resolve(out, "delayed-held-grenade.json"), JSON.stringify(result, null, 2));
    assert.ok(result.afterAmmo < beforeAmmo || grenades > 0, "No real original grenade was launched");
    assert.equal(late.boundary?.stateHash, timely.boundary?.stateHash);
  } finally { timely.match.dispose(); late.match.dispose(); }
});

for (const weapon of [8, 10, 13]) {
  test(`startup weapon ${weapon}: delayed initial edge and genuine current held frames really fire`, async () => {
    const timely = await timeline(weapon), late = await timeline(weapon);
    try {
      const shotTick = 600;
      for (const value of [timely, late]) warmSeparatedPlayers(value, shotTick);
      requireStatus(inspector.loadState(timely.state!), "inspect startup ammo");
      const before = inspector.renderView();
      if (typeof before === "number") throw new Error("Startup firing view unavailable");
      const beforeAmmo = before.sprite(0).ammo;
      const first = { seq: timely.sequence + 1, tick: shotTick, viewTick: shotTick - 4, input: encodeInput({ Fire: true }) };
      timely.match.receive({ type: "input", slot: 1, frames: [first] }, timely.now);
      stepTo(timely, shotTick + 1);
      // Explicit release: neither timeline invents a historical continuous hold.
      timely.match.receive({ type: "input", slot: 1, frames: [{ seq: first.seq + 1, tick: shotTick + 1, viewTick: shotTick - 3, input: encodeInput({}) }] }, timely.now);
      stepTo(timely, shotTick + 12); stepTo(late, shotTick + 12);
      late.match.receive({ type: "input", slot: 1, frames: [first] }, late.now);
      assert.equal(late.match.takeLagMetrics().replayTicks, 12);
      let sequence = first.seq + 1;
      for (let tick = shotTick + 12; tick <= shotTick + 102; tick++) {
        const frame = { seq: ++sequence, tick, viewTick: tick - 4, input: encodeInput({ Fire: true, Down: weapon === 13, MouseAimX: 300, MouseAimY: -100, MouseDist: 500 }) };
        for (const value of [timely, late]) {
          value.match.receive({ type: "input", slot: 1, frames: [frame] }, value.now);
          stepTo(value, tick + 1);
        }
      }
      for (const value of [timely, late]) stepTo(value, shotTick + 104);
      requireStatus(inspector.loadState(timely.state!), "inspect real startup shot");
      const after = inspector.renderView();
      if (typeof after === "number") throw new Error("Startup projectile view unavailable");
      let projectiles = 0;
      for (let index = 0; index < after.bulletCount; index++) if (after.bullet(index).owner === 1) projectiles++;
      const result = { wasmSha256: FROZEN_WASM_SHA256, weapon, beforeAmmo, afterAmmo: after.sprite(0).ammo, ownedProjectiles: projectiles, equal: timely.boundary?.stateHash === late.boundary?.stateHash, timelyHash: timely.boundary?.stateHash.toString(16), lateHash: late.boundary?.stateHash.toString(16), initialTick: shotTick, insertedAtTick: shotTick + 12, genuineHeldThroughTick: shotTick + 102, stance: weapon === 13 ? "original grounded crouch via Down control" : "original standing", note: "No startup override; explicit initial release, then genuine received held-fire frames complete original startup" };
      await writeFile(resolve(out, `startup-held-${weapon}.json`), JSON.stringify(result, null, 2));
      assert.ok(result.afterAmmo < beforeAmmo || projectiles > 0, `Startup weapon ${weapon} never actually fired`);
      assert.equal(late.boundary?.stateHash, timely.boundary?.stateHash);
    } finally { timely.match.dispose(); late.match.dispose(); }
  });
}

for (const weapon of [11, 12, 255]) {
  test(`historical melee/unarmed weapon ${weapon} is rejected without advancing time`, async () => {
    const value = await timeline(weapon);
    try {
      stepTo(value, 72);
      value.match.receive({ type: "input", slot: 1, frames: [{ seq: 1, tick: 60, viewTick: 56, input: encodeInput({ Fire: true }) }] }, value.now);
      assert.equal(value.match.tick, 72);
      const metrics = value.match.takeLagMetrics();
      assert.equal(metrics.replayTicks, 0); assert.equal(metrics.rejectedShots, 1);
      stepTo(value, 74); assert.equal(value.boundary?.lastConsumedInputSeq, 0);
    } finally { value.match.dispose(); }
  });
}

test("trusted RTT, replay window and per-player rewind budget are enforced", async () => {
  const value = await timeline();
  try {
    stepTo(value, 72);
    for (let sample = 0; sample < 64; sample++) value.match.receive({ type: "rtt", slot: 1, milliseconds: 0 }, value.now);
    value.match.receive({ type: "input", slot: 1, frames: [{ seq: 1, tick: 60, viewTick: 56, input: encodeInput({ Fire: true }) }] }, value.now);
    const expired = value.match.takeLagMetrics();
    assert.equal(expired.replayTicks, 0); assert.equal(expired.uncompensatedShots, 1);
    for (let sample = 0; sample < 64; sample++) value.match.receive({ type: "rtt", slot: 1, milliseconds: 400 }, value.now);
    value.match.receive({ type: "input", slot: 1, frames: [{ seq: 2, tick: 61, viewTick: 57, input: encodeInput({ Fire: true }) }] }, value.now);
    const compensated = value.match.takeLagMetrics();
    assert.equal(compensated.replayMs.length, 1); assert.equal(compensated.rejectedShots, 0);
    assert.ok(compensated.replayTicks >= 11 && compensated.replayTicks <= 14, "11-tick shot plus at most three sparse-anchor prefix ticks");
    value.match.receive({ type: "input", slot: 1, frames: [{ seq: 3, tick: 62, viewTick: 58, input: encodeInput({ Fire: true }) }] }, value.now);
    assert.equal(value.match.takeLagMetrics().replayTicks, 0);
    assert.equal(value.match.tick, 72);
  } finally { value.match.dispose(); }
});

for (const action of ["Fire", "ThrowNade"] as const) {
  test(`delayed intent cannot retarget an existing historical ${action}`, async () => {
    const value = await timeline();
    try {
      const originalTick = action === "Fire" ? 59 : 60;
      stepTo(value, originalTick);
      value.match.receive({ type: "input", slot: 1, frames: [{ seq: 1, tick: originalTick, viewTick: originalTick - 4, input: encodeInput({ [action]: true, MouseAimX: 300 }) }] }, value.now);
      stepTo(value, 72);
      value.match.receive({ type: "input", slot: 1, frames: [{ seq: 2, tick: 60, viewTick: 56, input: encodeInput({ [action]: true, MouseAimX: -300 }) }] }, value.now);
      assert.equal(value.match.takeLagMetrics().replayTicks, 0);
    } finally { value.match.dispose(); }
  });
}

test("grenade plus Fire cannot bypass historical melee policy", async () => {
  const value = await timeline(11);
  try {
    stepTo(value, 72);
    value.match.receive({ type: "input", slot: 1, frames: [{ seq: 1, tick: 60, viewTick: 56, input: encodeInput({ Fire: true, ThrowNade: true }) }] }, value.now);
    const metrics = value.match.takeLagMetrics();
    assert.equal(metrics.replayTicks, 0); assert.equal(metrics.rejectedShots, 1);
  } finally { value.match.dispose(); }
});

test("eight-player worst-window replay benchmark records all projectile styles", async () => {
  const rows: { weapon: number; grenade: boolean; milliseconds: number; replayTicks: number; rejectedShots: number }[] = [];
  for (const weapon of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13]) {
    const value = await timeline(weapon, 8);
    try {
      stepTo(value, 72);
      for (let sample = 0; sample < 5; sample++) {
        const tick = value.match.tick;
        const grenade = sample === 4;
        value.match.receive({ type: "input", slot: 1, frames: [{ seq: ++value.sequence, tick: tick - 12, viewTick: tick - 16, input: encodeInput({ Fire: !grenade, ThrowNade: grenade, MouseAimX: 300, MouseAimY: -100, MouseDist: 500 }) }] }, value.now);
        const metrics = value.match.takeLagMetrics();
        assert.equal(metrics.replayMs.length, 1); assert.equal(metrics.rejectedShots, 0);
        assert.ok(metrics.replayTicks >= 12 && metrics.replayTicks <= 15, "12-tick shot plus at most three sparse-anchor prefix ticks");
        rows.push({ weapon, grenade, milliseconds: metrics.replayMs[0]!, replayTicks: metrics.replayTicks, rejectedShots: metrics.rejectedShots });
        stepTo(value, tick + 18);
      }
    } finally { value.match.dispose(); }
  }
  const result = { type: "lagcomp-worst-window", wasmSha256: FROZEN_WASM_SHA256, runtime: process.version, players: 8, replayWindowTicks: 12, samples: rows, replayMs: distribution(rows.map(row => row.milliseconds)), note: "Direct real-WASM AuthoritativeMatch benchmark, not wall-clock worker scheduling or human play" };
  await writeFile(resolve(out, "worst-window.json"), `${JSON.stringify(result, null, 2)}\n`);
});

test("eight-player 12-tick rewind processes a real 224-projectile fourteen-style load", async () => {
  const rows: object[] = [], timings: number[] = [];
  const weapons = [1, 50, 5, 7, 14, 255, 15, 16, 51, 52, 11, 13, 53, 30];
  for (let sample = 0; sample < 8; sample++) {
    const value = await timeline(4, 8, true);
    try {
      stepTo(value, 60);
      // Trusted qualification fixture seam only: never reachable from WSS.
      // Same diagnostic sim_command schema as the pinned combat corpus.
      const host = Reflect.get(value.match, "host") as SimHost;
      for (let kind = 0; kind < weapons.length; kind++) {
        for (let projectile = 0; projectile < 16; projectile++) {
          requireStatus(host.command(60, { kind: "bullet", weapon: weapons[kind]!, owner: projectile % 8 + 1, x: -240 + projectile * 30, y: -500 - kind * 12, vx: 0.2, vy: -0.2, timeout: 120 }), "trusted loaded projectile fixture");
        }
      }
      const loaded = host.renderView();
      if (typeof loaded === "number") throw new Error("Loaded projectile view unavailable");
      const styles: Record<string, number> = {};
      for (let index = 0; index < loaded.bulletCount; index++) {
        const style = loaded.bullet(index).style; styles[style] = (styles[style] ?? 0) + 1;
      }
      assert.equal(loaded.bulletCount, 224); assert.equal(Object.keys(styles).length, 14);
      stepTo(value, 72);
      value.match.receive({ type: "input", slot: 1, frames: [{ seq: 1, tick: 60, viewTick: 56, input: encodeInput({ Fire: true, MouseAimX: 300, MouseAimY: -100 }) }] }, value.now);
      const metrics = value.match.takeLagMetrics();
      assert.equal(metrics.replayTicks, 12); assert.equal(metrics.rejectedShots, 0);
      timings.push(metrics.replayMs[0]!);
      rows.push({ sample, loadedProjectiles: 224, initialStyleHistogram: styles, replayTicks: metrics.replayTicks, milliseconds: metrics.replayMs[0] });
    } finally { value.match.dispose(); }
  }
  await writeFile(resolve(out, "loaded-worst-window.json"), JSON.stringify({ type: "loaded-lagcomp-worst-window", wasmSha256: FROZEN_WASM_SHA256, runtime: process.version, players: 8, replayWindowTicks: 12, samples: rows, replayMs: distribution(timings), scope: "Actual original projectile objects, all fourteen styles, diagnostic trusted fixture; not network-admissible projectile injection or proof all player guns fired" }, null, 2));
});

test("overlapping delayed shots rebuild from a retained coherent anchor", async () => {
  const timely = await timeline(4, 8), late = await timeline(4, 8);
  try {
    for (const value of [timely, late]) warmSeparatedPlayers(value, 600);
    const first = { seq: timely.sequence + 1, tick: 600, viewTick: 596, input: encodeInput({ Fire: true, MouseAimX: 300, MouseAimY: -100, MouseDist: 500 }) };
    const second = { seq: timely.sequence + 3, tick: 606, viewTick: 602, input: encodeInput({ ThrowNade: true, MouseAimX: 350, MouseAimY: -100, MouseDist: 500 }) };
    timely.match.receive({ type: "input", slot: 1, frames: [first] }, timely.now);
    stepTo(timely, 601);
    timely.match.receive({ type: "input", slot: 1, frames: [{ seq: first.seq + 1, tick: 601, viewTick: 597, input: encodeInput({}) }] }, timely.now);
    stepTo(timely, 606);
    timely.match.receive({ type: "input", slot: 1, frames: [second] }, timely.now);
    stepTo(timely, 607);
    timely.match.receive({ type: "input", slot: 1, frames: [{ seq: second.seq + 1, tick: 607, viewTick: 603, input: encodeInput({}) }] }, timely.now);
    stepTo(timely, 618);
    stepTo(late, 612);
    late.match.receive({ type: "input", slot: 1, frames: [first] }, late.now);
    stepTo(late, 618);
    // Tick 606 was invalidated by the first rewind. Restoring its stale
    // pre-shot state would erase the first shot; nearest-anchor replay cannot.
    late.match.receive({ type: "input", slot: 1, frames: [second] }, late.now);
    assert.equal(late.match.takeLagMetrics().replayTicks, 30);
    stepTo(timely, 620); stepTo(late, 620);
    assert.equal(late.boundary?.stateHash, timely.boundary?.stateHash);
    // Let all invalidated boundaries age out of the retained history.
    stepTo(timely, 660); stepTo(late, 660);
    assert.equal(late.boundary?.stateHash, timely.boundary?.stateHash);
  } finally { timely.match.dispose(); late.match.dispose(); }
});

test("eight synced recipients share one record encoding per flush", async () => {
  const previous = process.env.NET_G4_PROFILE;
  process.env.NET_G4_PROFILE = "1";
  let value: Timeline | undefined;
  try {
    value = await timeline(4, 8);
    stepTo(value, 2);
    const first = value.match.takeWorkProfile()!;
    assert.equal(first.recipients, 8); assert.equal(first.recordEncodes, 1);
    stepTo(value, 4);
    const next = value.match.takeWorkProfile()!;
    assert.equal(next.recipients, 8); assert.equal(next.recordEncodes, 1);
    requireStatus(inspector.loadState(value.state!), "inspect shared relay boundary");
    assert.equal(inspector.hash(), value.boundary!.stateHash.toString(16).padStart(16, "0"));
  } finally {
    value?.match.dispose();
    if (previous === undefined) delete process.env.NET_G4_PROFILE;
    else process.env.NET_G4_PROFILE = previous;
  }
});

for (const action of ["Fire", "ThrowNade"] as const) {
  test(`expired ${action} runs at present time with original ammo/cooldown, never historical movement`, async () => {
    const present = await timeline(), expired = await timeline();
    try {
      for (const value of [present, expired]) { warmSeparatedPlayers(value, 600); stepTo(value, 630); }
      const before = present.state!;
      const current = { seq: present.sequence + 1, tick: 630, viewTick: 626, input: encodeInput({ [action]: true, MouseAimX: 300, MouseAimY: -100, MouseDist: 500 }) };
      present.match.receive({ type: "input", slot: 1, frames: [current] }, present.now);
      expired.match.receive({ type: "input", slot: 1, frames: [{ ...current, tick: 600, viewTick: 570, input: encodeInput({ Left: true, Reload: true, [action]: true, MouseAimX: 300, MouseAimY: -100, MouseDist: 500 }) }] }, expired.now);
      assert.equal(expired.match.tick, 630);
      const metrics = expired.match.takeLagMetrics();
      assert.equal(metrics.replayTicks, 0); assert.equal(metrics.uncompensatedShots, 1);
      stepTo(present, 631); stepTo(expired, 631);
      // Original throwing animation reaches its launch gate after 36 frames.
      for (let tick = 631; tick < 670; tick++) {
        const held = { ...current, seq: current.seq + tick - 630, tick, viewTick: tick - 4 };
        for (const value of [present, expired]) {
          value.match.receive({ type: "input", slot: 1, frames: [held] }, value.now);
          stepTo(value, tick + 1);
        }
      }
      assert.equal(expired.boundary?.lastConsumedInputSeq, current.seq + 39);
      assert.equal(expired.boundary?.stateHash, present.boundary?.stateHash);
      requireStatus(inspector.loadState(before), "inspect pre-expired action");
      const beforeView = inspector.renderView(); if (typeof beforeView === "number") throw new Error("Missing before view");
      const ammo = action === "Fire" ? beforeView.sprite(0).ammo : beforeView.sprite(0).grenades;
      requireStatus(inspector.loadState(expired.state!), "inspect expired action result");
      const afterView = inspector.renderView(); if (typeof afterView === "number") throw new Error("Missing after view");
      assert.ok((action === "Fire" ? afterView.sprite(0).ammo : afterView.sprite(0).grenades) < ammo, `Original action did not consume real ammo: before=${ammo}, after=${action === "Fire" ? afterView.sprite(0).ammo : afterView.sprite(0).grenades}, health=${afterView.sprite(0).health}, body=${afterView.sprite(0).bodyId}/${afterView.sprite(0).bodyFrame}`);
    } finally { present.match.dispose(); expired.match.dispose(); }
  });
}

test("timely fire with an old genuine view is present-only and counted", async () => {
  const value = await timeline();
  try {
    warmSeparatedPlayers(value, 600);
    value.match.receive({ type: "input", slot: 1, frames: [{ seq: value.sequence + 1, tick: 600, viewTick: 0, input: encodeInput({ Fire: true }) }] }, value.now);
    const metrics = value.match.takeLagMetrics();
    assert.equal(metrics.uncompensatedShots, 1); assert.equal(metrics.replayTicks, 0);
    stepTo(value, 602);
    assert.equal(value.boundary?.lastConsumedInputSeq, value.sequence + 1);
  } finally { value.match.dispose(); }
});

test("F-05 per-match replay budget falls back to consumed present fire and reports metrics", async () => {
  const responses: WorkerResponse[] = [];
  const match = await AuthoritativeMatch.start({ ...config.match, replayTicksPerSecond: 1 }, response => responses.push(response));
  try {
    for (let slot = 1; slot <= 8; slot++) {
      match.receive({ type: "join", slot, weapon: 4, secondaryWeapon: 0 }, 0n);
      for (let sample = 0; sample < 64; sample++) match.receive({ type: "rtt", slot, milliseconds: 400 }, 0n);
    }
    while (match.tick < 72) match.step();
    responses.length = 0;
    for (let slot = 1; slot <= 8; slot++) {
      match.receive({ type: "input", slot, frames: [{ seq: 1, tick: match.tick - 12, viewTick: match.tick - 16, input: encodeInput({ Fire: true }) }] }, 1_000_000_000n);
      match.step();
    }
    const metrics = match.takeLagMetrics();
    assert.ok(metrics.replayTicks <= 60);
    assert.ok(metrics.replayBudgetFallbacks > 0);
    assert.ok(metrics.uncompensatedShots >= metrics.replayBudgetFallbacks);
    assert.ok(responses.some(response => response.type === "ticks" && response.recipients.some(recipient => recipient.lastConsumedInputSeq === 1)));
  } finally { match.dispose(); }
});

test("F-01 consumed-input AFK rejects once and leaving refills the original bot population", async () => {
  const responses: WorkerResponse[] = [];
  const match = await AuthoritativeMatch.start({ ...config.match, targetPlayers: 2, afkMs: 100 }, response => responses.push(response));
  try {
    match.receive({ type: "join", slot: 1, weapon: 4, secondaryWeapon: 0 }, 0n);
    // Inject monotonic time: AFK must expire even if an overloaded worker advances few ticks.
    const nowMs = performance.now();
    match.step(nowMs + 101);
    match.step(nowMs + 102);
    const rejects = responses.filter(response => response.type === "reject");
    assert.equal(rejects.length, 1); assert.match(rejects[0]!.reason, /AFK/);
    match.receive({ type: "leave", slot: 1 }, 200_000_000n);
    const host = Reflect.get(match, "host") as SimHost;
    const view = host.renderView(); if (typeof view === "number") throw new Error("Missing render view");
    assert.equal(Array.from({ length: 32 }, (_, i) => view.sprite(i)).filter(sprite => sprite.flags & 1).length, 2);
  } finally { match.dispose(); }
});

test("F-05 a delayed RTT sample changes smoothed allowance conservatively", async () => {
  const match = await AuthoritativeMatch.start(config.match, () => {});
  try {
    match.receive({ type: "join", slot: 1, weapon: 4, secondaryWeapon: 0 }, 0n);
    match.receive({ type: "rtt", slot: 1, milliseconds: 10_000 }, 0n);
    const players = Reflect.get(match, "players") as Map<number, { rttMs: number }>;
    assert.equal(players.get(1)!.rttMs, 12.5);
    match.receive({ type: "rtt", slot: 1, milliseconds: 0 }, 0n);
    assert.equal(players.get(1)!.rttMs, 9.375);
  } finally { match.dispose(); }
});
