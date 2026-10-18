import assert from "node:assert/strict";
import { test } from "node:test";
import { GAME_MODES } from "@soldat-web/protocol";
import { ATTRACT_SANDBOX, BOT_PROFILES, DEFAULT_SANDBOX, compatibleSandboxMaps, sandboxBotTeam, sandboxRules, validateSandbox } from "./sandbox-options";
import type { ContentIndex, MapManifest } from "./content";

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

test("all original modes validate and team match balances four native teams", () => {
  for (const mode of GAME_MODES) assert.doesNotThrow(() => validateSandbox({ ...DEFAULT_SANDBOX, mode }));
  const options = { ...DEFAULT_SANDBOX, mode: "tm" as const, team: 3 };
  assert.deepEqual([0, 1, 2, 3].map(index => sandboxBotTeam(options, index)), [4, 1, 2, 3]);
  assert.equal(sandboxBotTeam({ ...options, botTeam: "delta" }, 0), 4);
  for (const mode of ["dm", "pm", "rambo"] as const) assert.equal(sandboxBotTeam({ ...options, mode }, 0), 0);
  assert.throws(() => validateSandbox({ ...options, mapRotation: ["Arena", "Arena"] }), RangeError);
});

test("practice forwards an opt-in validated balanceTeams rule to native membership commands", () => {
  assert.equal(DEFAULT_SANDBOX.balanceTeams, false);
  for (const mode of GAME_MODES) {
    const options = { ...DEFAULT_SANDBOX, mode, balanceTeams: true };
    assert.doesNotThrow(() => validateSandbox(options));
    assert.equal(sandboxRules(options).balanceTeams, true);
  }
  assert.throws(() => validateSandbox({ ...DEFAULT_SANDBOX, balanceTeams: "true" as unknown as boolean }), RangeError);
});


test("map compatibility follows imported evidence, not name prefixes, and requires waypoints only for bots", () => {
  const base = { path: "maps/fixture.json", mapSha256: "fixture", simContentSha256: "fixture", missing: [],
    simPack: { path: "sim/packs/fixture.spk", sha256: "fixture", bytes: 0 } };
  const maps: Record<string, MapManifest> = {
    ctf_Misnamed: { ...base, modes: ["dm", "pm"], botCapable: true },
    Arena: { ...base, modes: ["ctf", "inf"], botCapable: true },
    htf_NoWaypoints: { ...base, modes: ["htf"], botCapable: false },
  };
  const index: Pick<ContentIndex, "maps"> = { maps };
  assert.deepEqual(compatibleSandboxMaps(index, "dm", true), ["ctf_Misnamed"]);
  assert.deepEqual(compatibleSandboxMaps(index, "inf"), ["Arena"]);
  assert.deepEqual(compatibleSandboxMaps(index, "htf"), ["htf_NoWaypoints"]);
  assert.deepEqual(compatibleSandboxMaps(index, "htf", true), []);
});
