import assert from "node:assert/strict";
import test from "node:test";
import { BOT_PROFILES, configureMatch, reservedBotSlots } from "./bots.ts";
import type { MatchConfiguration } from "./worker-messages.ts";

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
  assert.deepEqual(match.rules, { ...rules, ai: true });
  assert.equal(rules.ai, false);
  for (const mode of ["dm", "ctf"]) assert.equal(configureMatch({ ...config, rules: { mode } }).rules.mode, mode);
  for (const botDifficulty of [0, 100, 300]) assert.equal(configureMatch({ ...config, rules: { botDifficulty } }).rules.botDifficulty, botDifficulty);
  for (const botDifficulty of [-1, 301, 0.5, "100", null, NaN, Infinity]) {
    assert.throws(() => configureMatch({ ...config, rules: { botDifficulty } }), /botDifficulty/);
  }
  assert.throws(() => configureMatch({ ...config, rules: { mode: "team" } }), /mode/);
  assert.equal(BOT_PROFILES.length, 16);
  assert.equal(new Set(BOT_PROFILES).size, BOT_PROFILES.length);
});
