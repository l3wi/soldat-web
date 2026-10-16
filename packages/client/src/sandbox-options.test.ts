import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTRACT_SANDBOX, BOT_PROFILES, DEFAULT_SANDBOX, sandboxBotTeam, validateSandbox } from "./sandbox-options";

test("practice supports 0..31 original profile bots with valid original difficulty", () => {
  assert.equal(BOT_PROFILES.length, 16);
  assert.equal(BOT_PROFILES[0], "Admiral");
  for (const bots of [0, 4, 8, 31]) assert.doesNotThrow(() => validateSandbox({ ...DEFAULT_SANDBOX, bots }));
  for (const bots of [-1, 32, 1.5, NaN]) assert.throws(() => validateSandbox({ ...DEFAULT_SANDBOX, bots }), RangeError);
  for (const botDifficulty of [-1, 301, 0.5]) assert.throws(() => validateSandbox({ ...DEFAULT_SANDBOX, botDifficulty }), RangeError);
});

test("attract matches use eight original-profile DM bots", () => {
  assert.doesNotThrow(() => validateSandbox(ATTRACT_SANDBOX));
  assert.equal(ATTRACT_SANDBOX.bots, 8);
  assert.equal(ATTRACT_SANDBOX.mode, "dm");
  assert.equal(ATTRACT_SANDBOX.botDifficulty, 100);
  for (let index = 0; index < ATTRACT_SANDBOX.bots; index++) {
    assert.equal(sandboxBotTeam(ATTRACT_SANDBOX, index), 0);
    assert.ok(BOT_PROFILES[index]);
  }
});

test("DM is solo and CTF balances including the local human", () => {
  assert.deepEqual([0, 1, 2, 3].map(index => sandboxBotTeam({ ...DEFAULT_SANDBOX, mode: "dm" }, index)), [0, 0, 0, 0]);
  for (const team of [1, 2] as const) {
    const options = { ...DEFAULT_SANDBOX, mode: "ctf" as const, team };
    assert.deepEqual([0, 1, 2, 3].map(index => sandboxBotTeam(options, index)), [3 - team, team, 3 - team, team]);
    assert.equal(sandboxBotTeam({ ...options, botTeam: "alpha" }, 0), 1);
    assert.equal(sandboxBotTeam({ ...options, botTeam: "bravo" }, 0), 2);
  }
});
