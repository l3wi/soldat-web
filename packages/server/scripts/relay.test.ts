import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSim, loadSimContent, requireStatus, encodeInput, type SimHost } from "@soldat-web/sim-host";
import { decodeMessage, encodeMessage, encodeTicksMessage, type Message } from "@soldat-web/protocol";
import { OnlineSession } from "../../client/src/net/session.ts";
import { BOT_PROFILES } from "../src/bots.ts";
import { AuthoritativeMatch } from "../src/match.ts";
import type { WorkerResponse } from "../src/worker-messages.ts";
import { qualificationConfig } from "./support.ts";

for (const [map, mode, ticks] of [["ctf_Ash", "ctf", 3000], ["Arena", "dm", 1200]] as const) {
  test(`${map}: AI-on loaded client stays bit-identical without bot inputs for ${ticks} ticks`, {timeout: 90_000}, async () => {
    const config = await qualificationConfig(resolve("build-out/net-v4/ai", map));
    const hosts: SimHost[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const host = await loadSim(config.wasm); hosts.push(host);
        await loadSimContent(host, config.manifest, path => readFile(resolve(config.match.contentRoot, path)));
        requireStatus(host.init({mode, rng: "keyed", world: "original", ai: true, botDifficulty: 100}, 123456789, 42), "init");
        requireStatus(host.loadMap(map), "map");
      }
      const [server, client] = hosts;
      for (let i = 0; i < 8; i++) requireStatus(server!.command(0, {kind: "join", slot: 25 + i, control: "bot", bot: BOT_PROFILES[i]!, team: mode === "ctf" ? 1 + i % 2 : 0}), "bot join");
      for (let i = 0; i < 120; i++) { requireStatus(server!.step(), "warm"); server!.events(); }
      const bytes = server!.saveState(); if (typeof bytes === "number") throw new Error(`save ${bytes}`);
      requireStatus(client!.loadState(bytes), "load"); assert.equal(client!.hash(), server!.hash());
      for (let i = 0; i < ticks; i++) {
        requireStatus(server!.step(), "server step"); requireStatus(client!.step(1), "client step");
        server!.events(); client!.events();
        assert.equal(client!.hash(), server!.hash(), `AI diverged at ${i + 120}`);
      }
    } finally { for (const host of hosts) host.dispose(); }
  });
}

test("real match relay: independent clients verify every hash across bot replacement/refill, weapon commands and forced correction", {timeout: 90_000}, async () => {
  const config = await qualificationConfig(resolve("build-out/net-v4/integration"));
  const responses: WorkerResponse[] = [];
  const match = await AuthoritativeMatch.start({...config.match, targetPlayers: 8, rules: {...config.match.rules, world: "original"}}, response => responses.push(response));
  const clients = new Map<number, OnlineSession>();
  const states = new Map<number, number>();
  let corrections = 0, hashes = 0, commands = 0;
  const join = async (slot: number) => {
    const hosts: SimHost[] = [];
    for (let i = 0; i < 2; i++) {
      const host = await loadSim(config.wasm); hosts.push(host);
      await loadSimContent(host, config.manifest, path => readFile(resolve(config.match.contentRoot, path)));
      requireStatus(host.init({rng: "keyed", world: "original", ai: true}, 123456789), "client init"); requireStatus(host.loadMap("Arena"), "client map");
    }
    const session = new OnlineSession({prediction: hosts[0]!, confirmed: hosts[1]!, slot, send(message) {
      if (message.type === "resync") throw new Error(`Unexpected resync client ${slot}`);
      if (message.type === "eventAck") match.receive({...message, slot}, BigInt(match.tick) * 16_666_667n);
    }});
    clients.set(slot, session);
    match.receive({type: "join", slot, weapon: 4, secondaryWeapon: 0}, BigInt(match.tick) * 16_666_667n);
    // Model a settled probe history; a single delayed sample no longer unlocks rewind.
    for (let sample = 0; sample < 64; sample++) match.receive({type: "rtt", slot, milliseconds: 400}, 0n);
  };
  const deliver = () => {
    for (const response of responses.splice(0)) {
      if (response.type === "ticks") {
        for (const recipient of response.recipients) {
          const client = clients.get(recipient.slot); if (!client) continue;
          const message = decodeMessage(encodeTicksMessage(recipient.lastConsumedInputSeq, response.records));
          if (message.type !== "ticks") throw new Error("Wrong relay frame");
          for (const record of message.records) {
            if (record.type === "correct") corrections++;
            if (record.type === "hash") hashes++;
            if (record.type === "step") { commands += record.commands.length; assert.ok(record.inputs.every(input => input.slot <= 3), "Bot input leaked onto wire"); }
          }
          const before = client.metrics.hashMatches;
          client.receive(message);
          assert.equal(client.metrics.hashMatches - before, message.records.filter(record => record.type === "hash").length, "Every hash must be verified");
          assert.equal(client.metrics.hashMismatches, 0);
        }
      } else if (response.type === "send") {
        if (response.message.type === "state") states.set(response.slot, (states.get(response.slot) ?? 0) + 1);
        clients.get(response.slot)?.receive(decodeMessage(encodeMessage(response.message)));
      }
      else if (response.type === "reject" || response.type === "failure") throw new Error(response.reason);
    }
  };
  try {
    await join(1); await join(2);
    for (let tick = 0; tick < 900; tick++) {
      if (tick === 90) await join(3);
      if (tick === 180) { match.receive({type: "leave", slot: 3}, BigInt(tick) * 16_666_667n); clients.get(3)!.dispose(); clients.delete(3); }
      if (tick === 240) match.receive({type: "weapon-choice", slot: 2, primary: 6, secondary: 0, selection: "primary"}, BigInt(tick) * 16_666_667n);
      if (tick === 608) match.receive({type: "input", slot: 1, frames: [{seq: 1, tick: 600, viewTick: 596, input: encodeInput({Fire: true, MouseAimX: 300})}]}, BigInt(tick) * 16_666_667n);
      if (tick === 620) match.receive({type: "resync", slot: 2}, BigInt(tick) * 16_666_667n);
      if (tick === 626) match.receive({type: "input", slot: 1, frames: [{seq: 2, tick: 618, viewTick: 614, input: encodeInput({ThrowNade: true, MouseAimX: 300})}]}, BigInt(tick) * 16_666_667n);
      match.step(); deliver();
    }
    assert.ok(commands >= 8, `Missing membership/weapon commands: ${commands}`);
    assert.equal(corrections, 3, "First correction reaches both clients; pre-sync correction reaches only its eligible client"); assert.ok(hashes >= 60);
    assert.equal(states.get(2), 3, "Join, explicit resync, then fresh state instead of a pre-sync correction");
    for (const client of clients.values()) {
      assert.equal(client.metrics.confirmedTick, match.tick); assert.equal(client.metrics.hashMismatches, 0);
      assert.equal(client.metrics.rollbacks, client.metrics.slot === 1 ? 2 : 1);
      assert.ok(client.metrics.hashMatches >= 30);
    }
  } finally { for (const client of clients.values()) client.dispose(); match.dispose(); }
});
