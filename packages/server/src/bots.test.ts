import assert from "node:assert/strict";
import test from "node:test";
import { BOT_PROFILES, configureMatch, reservedBotSlots } from "./bots.ts";
import type { MatchConfiguration } from "./worker-messages.ts";
import { GAME_MODES, normalizeMatchRules } from "@soldat-web/protocol";

const config: MatchConfiguration = { wasmPath: "sim.wasm", contentRoot: "content", contentSetHash: "ab".repeat(32), map: "Arena", matchSeed: "1", rules: {} };

test("bot count accepts 0..31 and preserves at least one human slot", () => {
  assert.equal(configureMatch(config).botCount, 0);
  for (let botCount = 0; botCount <= 31; botCount++) {
    const match = configureMatch({ ...config, botCount });
    const bots = reservedBotSlots(match.botCount);
    assert.equal(bots.length, botCount);
    assert.equal(new Set(bots).size, botCount);
    const humans = Array.from({ length: 32 - botCount }, (_, index) => index + 1);
    assert.ok(humans.every(slot => !bots.includes(slot)));
    assert.equal(new Set([...humans, ...bots]).size, 32);
  }
  for (const botCount of [-1, 32, 100, 1.5, NaN, Infinity, "4", null]) {
    assert.throws(() => configureMatch({ ...config, botCount: botCount as number }), /botCount/);
  }
});

test("server enables AI without mutating caller rules and bounds original bot difficulty", () => {
  const rules = { mode: "ctf", rng: "keyed", ai: false, botDifficulty: 300 };
  const match = configureMatch({ ...config, rules, botCount: 4 });
  assert.deepEqual(match.rules, { ...normalizeMatchRules(rules), ai: true, world: "original" });
  assert.equal(rules.ai, false);
  for (const mode of GAME_MODES) assert.equal(configureMatch({ ...config, rules: { mode } }).rules.mode, mode);
  for (const botDifficulty of [0, 100, 300]) assert.equal(configureMatch({ ...config, rules: { botDifficulty } }).rules.botDifficulty, botDifficulty);
  for (const botDifficulty of [-1, 301, 0.5, "100", null, NaN, Infinity]) {
    assert.throws(() => configureMatch({ ...config, rules: { botDifficulty } }), /botDifficulty/);
  }
  assert.throws(() => configureMatch({ ...config, rules: { mode: "team" } }), /mode/);
  for (const world of ["original", "fixture"]) assert.equal(configureMatch({ ...config, rules: { world } }).rules.world, world);
  for (const world of ["empty", null, false]) assert.throws(() => configureMatch({ ...config, rules: { world } }), /world/);
  assert.equal(BOT_PROFILES.length, 16);
  assert.equal(new Set(BOT_PROFILES).size, BOT_PROFILES.length);
});

test("explicit compatible catalogs are independent of ordered rotation and must contain every rotating map", () => {
  const mapRotation = ["Arena"], allowedMaps = ["Arena", "Arena2"];
  const configured = configureMatch({ ...config, mapRotation, allowedMaps });
  assert.deepEqual(configured.mapRotation, ["Arena"]);
  assert.deepEqual(configured.allowedMaps, ["Arena", "Arena2"]);
  for (const value of [[], ["Arena2"], ["Arena", "Arena"], ["Arena", ""], ["Arena", "m".repeat(129)], null, "Arena", Array.from({ length: 4097 }, (_, index) => `Map${index}`)]) {
    assert.throws(() => configureMatch({ ...config, allowedMaps: value as string[] }), /allowed map catalog/);
  }
  assert.throws(() => configureMatch({ ...config, mapRotation: ["Arena", "Arena2"], allowedMaps: ["Arena"] }), /allowed map catalog/);
  assert.deepEqual(mapRotation, ["Arena"]); assert.deepEqual(allowedMaps, ["Arena", "Arena2"]);
});
