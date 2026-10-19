import assert from "node:assert/strict";
import { before, test } from "node:test";
import { resolve } from "node:path";
import { encodeInput, type SimHost } from "@soldat-web/sim-host";
import { AuthoritativeMatch } from "../src/match.ts";
import { FixedStepAccumulator, type FixedStepTiming } from "../src/clock.ts";
import type { WorkerResponse } from "../src/worker-messages.ts";
import { qualificationConfig, type QualificationConfig } from "./support.ts";

let config: QualificationConfig;
before(async () => { config = await qualificationConfig(resolve("build-out/worker-processing")); });

test("native input consumption separates fresh neutral, repeated held and timeout across metric reports", async () => {
  const match = await AuthoritativeMatch.start({ ...config.match, botCount: 0 }, () => {});
  try {
    match.receive({ type: "join", slot: 1, weapon: 4, secondaryWeapon: 0 }, 0n);
    match.receive({ type: "input", slot: 1, frames: [{ seq: 1, tick: 0, viewTick: 0, input: encodeInput({}) }] }, 0n);
    for (let tick = 0; tick < 8; tick++) match.step();
    assert.deepEqual(match.takeLagMetrics().inputConsumption, { scheduled: 1, repeatedHeld: 7, timeoutNeutral: 0, maxMissingRunTicks: 7 });
    for (let tick = 8; tick <= 16; tick++) match.step();
    assert.deepEqual(match.takeLagMetrics().inputConsumption, { scheduled: 0, repeatedHeld: 8, timeoutNeutral: 1, maxMissingRunTicks: 16 });
    assert.deepEqual(match.takeLagMetrics().inputConsumption, { scheduled: 0, repeatedHeld: 0, timeoutNeutral: 0, maxMissingRunTicks: 0 });
    match.receive({ type: "input", slot: 1, frames: [{ seq: 2, tick: 17, viewTick: 13, input: encodeInput({}) }] }, 1_000_000n);
    for (let tick = 17; tick <= 19; tick++) match.step();
    assert.deepEqual(match.takeLagMetrics().inputConsumption, { scheduled: 1, repeatedHeld: 2, timeoutNeutral: 0, maxMissingRunTicks: 2 });
    match.receive({ type: "resync", slot: 1 }, 2_000_000n);
    match.step();
    assert.deepEqual(match.takeLagMetrics().inputConsumption, { scheduled: 0, repeatedHeld: 1, timeoutNeutral: 0, maxMissingRunTicks: 1 });
  } finally { match.dispose(); }
});

test("native fixed-step scheduling matches direct gameplay across catch-up, input, map and memory changes", async () => {
  const responses: WorkerResponse[] = [], directResponses: WorkerResponse[] = [];
  const matchConfig = { ...config.match, botCount: 0, mapRotation: ["Arena", "Arena2"] };
  const match = await AuthoritativeMatch.start(matchConfig, response => responses.push(response));
  const direct = await AuthoritativeMatch.start(matchConfig, response => directResponses.push(response));
  const host = Reflect.get(match, "host") as SimHost, directHost = Reflect.get(direct, "host") as SimHost;
  let now = 0n;
  const clock = new FixedStepAccumulator(0n);
  const timing: FixedStepTiming = { now: () => now, completed: () => {} };
  const stepped = () => { direct.step(); assert.equal(host.hash(), directHost.hash()); };
  try {
    for (const current of [match, direct]) current.receive({ type: "join", slot: 1, weapon: 4, secondaryWeapon: 0 }, now);
    assert.equal(match.advance(clock, timing, stepped), 0);
    assert.equal(match.tickScale, direct.tickScale);
    host.exports.memory.grow(1);
    now = 16_666_667n;
    assert.equal(match.advance(clock, timing, stepped), 1);
    assert.equal(match.tickScale, direct.tickScale);
    now = 66_666_667n;
    assert.equal(match.advance(clock, timing, stepped), 3);
    assert.equal(match.tickScale, direct.tickScale);
    for (const current of [match, direct]) current.receive({ type: "input", slot: 1, frames: [{ seq: 1, tick: current.tick, viewTick: 0, input: encodeInput({ Right: true }) }] }, now);
    now = 83_333_334n;
    assert.equal(match.advance(clock, timing, stepped), 1);
    assert.equal(match.tickScale, direct.tickScale);
    assert.equal(match.advance(clock, timing, stepped), 0);
    for (const current of [match, direct]) current.receive({ type: "map-control", map: "Arena2" }, now);
    host.exports.memory.grow(1);
    now = 100_000_001n;
    assert.equal(match.advance(clock, timing, stepped), 1);
    assert.equal(match.tickScale, direct.tickScale);
    assert.deepEqual(responses, directResponses, "accepted inputs, lifecycle messages and relay bytes stay identical");
  } finally { match.dispose(); direct.dispose(); }
});

test("native observation work is included before the scheduling sample", async () => {
  const match = await AuthoritativeMatch.start({ ...config.match, botCount: 0 }, () => {});
  const host = Reflect.get(match, "host") as SimHost;
  const renderView = host.renderView.bind(host);
  let now = 15_000_000n;
  host.renderView = () => { const view = renderView(); now += 2_000_000n; return view; };
  const clock = new FixedStepAccumulator(0n);
  const starts: number[] = [], completions: number[] = [];
  try {
    assert.equal(match.advance(clock, { now: () => now, completed: value => { completions.push(value); } }, value => { starts.push(value); }), 1);
    assert.ok(Math.abs(starts[0]! - 1 / 3) < 1e-9, "the native getter's two milliseconds make this tick due");
    assert.deepEqual(completions, starts);
    const scale = match.tickScale;
    assert.ok(Math.abs(clock.delayMilliseconds(now, scale) - 14.333333333333334) < 1e-9, "post-step native observation also consumes the remaining sleep interval");
  } finally { match.dispose(); }
});

test("automatic native round/map transition refreshes the borrowed pre-state inside catch-up", async () => {
  const responses: WorkerResponse[] = [], directResponses: WorkerResponse[] = [];
  const matchConfig = { ...config.match, botCount: 0, mapRotation: ["Arena", "Arena2"], rules: { ...config.match.rules, timeLimitTicks: 1 } };
  const match = await AuthoritativeMatch.start(matchConfig, response => responses.push(response));
  const direct = await AuthoritativeMatch.start(matchConfig, response => directResponses.push(response));
  const host = Reflect.get(match, "host") as SimHost, directHost = Reflect.get(direct, "host") as SimHost;
  const loadMap = host.loadMap.bind(host);
  let transitions = 0, now = 0n;
  host.loadMap = name => {
    const result = loadMap(name);
    if (result >= 0) { transitions++; host.exports.memory.grow(1); }
    return result;
  };
  const clock = new FixedStepAccumulator(0n);
  const timing: FixedStepTiming = { now: () => now, completed: () => {} };
  try {
    for (const current of [match, direct]) current.receive({ type: "join", slot: 1, weapon: 4, secondaryWeapon: 0 }, now);
    while (!transitions && match.tick < 2000) {
      now += 66_666_667n;
      const steps = match.advance(clock, timing, () => {
        direct.step();
        assert.equal(host.hash(), directHost.hash(), `native state differs at tick ${match.tick}`);
      });
      assert.equal(steps, 4);
    }
    assert.equal(transitions, 1, "the real native results countdown reaches the map boundary");
    assert.ok(responses.some(response => response.type === "round" && response.map === "Arena2" && response.roundEpoch === 1));
    assert.deepEqual(responses, directResponses);
    assert.equal(clock.overloads, 0);
    assert.equal(clock.discardedSteps, 0n);
  } finally { match.dispose(); direct.dispose(); }
});

test("native bullet-time entry/exit preserves twenty-hertz ticks and post-step return to sixty hertz", async () => {
  const match = await AuthoritativeMatch.start({ ...config.match, botCount: 0, rules: { ...config.match.rules, bulletTime: true } }, () => {});
  const host = Reflect.get(match, "host") as SimHost;
  let now = 0n;
  const clock = new FixedStepAccumulator(now);
  const timing: FixedStepTiming = { now: () => now, completed: () => {} };
  try {
    match.receive({ type: "join", slot: 1, weapon: 4, secondaryWeapon: 0 }, now);
    now = 16_666_667n;
    assert.equal(match.advance(clock, timing, () => {}), 1);
    assert.equal(match.tickScale, 1);
    match.receive({ type: "player-kill", slot: 1 }, now);
    assert.ok(match.tickScale < 1, "a real original self-kill with no distant players enters native bullet time");
    for (let tick = 1; tick <= 30; tick++) {
      now += 50_000_000n;
      assert.equal(match.advance(clock, timing, () => {}), 1);
      const scale = match.tickScale;
      const sleep = clock.delayMilliseconds(now, scale);
      if (tick < 30) { assert.ok(scale < 1); assert.ok(sleep > 49.99 && sleep <= 50); }
      else { assert.equal(scale, 1); assert.ok(sleep > 16.66 && sleep < 16.67); }
    }
    assert.equal(match.tick, 31);
    now += 16_666_667n;
    assert.equal(match.advance(clock, timing, () => {}), 1);
    assert.equal(match.tick, 32);
    assert.equal(clock.overloads, 0);
    assert.equal(clock.discardedSteps, 0n);
    const view = host.renderView();
    assert.notEqual(typeof view, "number");
    if (typeof view !== "number") assert.equal(view.globals.bulletTimeTimer, -1);
  } finally { match.dispose(); }
});
