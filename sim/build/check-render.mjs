#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSim, loadSimContent, requireStatus, SIM_ABI_VERSION, SIM_PRESENTATION_EVENTS } from '../../packages/sim-host/src/sim.ts';
import { RENDER_LAYOUT, BULLET_PRESENTATION_FLAGS } from '../../packages/sim-host/src/render.ts';
import { SIM_GAMEPLAY_EVENTS } from '../../packages/sim-host/src/gameplay-events.ts';
import { runFixture } from '../../packages/sim-host/src/fixture.ts';
import { readFixture, readManifest } from '../../packages/sim-host/src/fixture-files.ts';

const wasmPath = process.argv[2] ?? 'build-out/sim/sim.wasm';
const outputPath = process.argv[3] ?? 'build-out/sim/g5/render-check.json';
const wasm = new Uint8Array(await readFile(wasmPath));
const manifest = await readManifest('dist/content');
const readContent = async path => new Uint8Array(await readFile(resolve('dist/content', path)));
const result = { abiVersion: SIM_ABI_VERSION, wasm: wasmPath, wasmSha256: createHash('sha256').update(wasm).digest('hex'), publications: 0, bullets: 0, things: 0, gameplayEvents: {}, crossInstanceFacing: [], replayComparisons: 0, replayGameplayEvents: 0 };
const canonicalKinds = new Set(Object.values(SIM_GAMEPLAY_EVENTS));
function gameplay(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 20 <= bytes.length);
    const kind = view.getUint32(offset, true), length = 20 + view.getUint32(offset + 16, true);
    assert.ok(offset + length <= bytes.length);
    if (canonicalKinds.has(kind)) records.push(Buffer.from(bytes.subarray(offset, offset + length)).toString('hex'));
    offset += length;
  }
  return records;
}
function checkScalarFields(record, raw, offsets, fields, floats = [], signed = [], booleans = []) {
  for (const field of fields) {
    const offset = offsets[field];
    assert.equal(typeof offset, 'number', `missing offset ${field}`);
    let value = floats.includes(field) ? raw.getFloat32(offset, true) : signed.includes(field) ? raw.getInt32(offset, true) : raw.getUint32(offset, true);
    if (booleans.includes(field)) value = value !== 0;
    assert.equal(record[field], value, field);
  }
}
for (const fixturePath of ['tests/fixtures/combat/target-standing.fixture.json', 'tests/fixtures/combat/weapon-drop-pickup.fixture.json']) {
  const file = await readFixture(fixturePath);
  const receipt = await runFixture({ wasm, fixture: file.fixture, fixtureBytes: file.bytes, fixtureName: file.name, manifest, readContent,
    readFixtureAsset: async path => new Uint8Array(await readFile(path)), runtime: process.version,
    trace(host, tick) {
      const before = host.hash(), view = host.renderView();
      assert.notEqual(typeof view, 'number');
      assert.equal(view.version, SIM_ABI_VERSION); assert.equal(view.tick, tick);
      assert.equal(view.bytes.length, RENDER_LAYOUT.totalBytes);
      const bytes = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength);
      assert.deepEqual([...view.globals.teamScores], Array.from({ length: 6 }, (_, i) => bytes.getInt32(RENDER_LAYOUT.globalsOffset + i * 4, true)));
      for (const field of ['startHealth', 'mapStartJet', 'gameMode', 'killLimit', 'ceaseFireTime']) assert.equal(view.globals[field], bytes.getInt32(RENDER_LAYOUT.globalsOffset + RENDER_LAYOUT.globals[field], true));
      for (let index = 0; index < view.slots; index++) {
        const sprite = view.sprite(index), base = RENDER_LAYOUT.headerBytes + index * RENDER_LAYOUT.spriteBytes;
        const raw = new DataView(bytes.buffer, bytes.byteOffset + base, RENDER_LAYOUT.spriteBytes);
        checkScalarFields(sprite, raw, RENDER_LAYOUT.sprite, ['fired','clipTexture','clipInTime','clipOutTime','secondaryWeapon','tertiaryWeapon','vest','jetpack','alpha','wearHelmet','hasCigar','chain','headCap','hairStyle','shirtColor','pantsColor','skinColor','hairColor','jetColor','ceaseFireCounter','visible','style','demoPlayer','weaponAmmo','weaponReloadTime','weaponFireInterval','fireIntervalCount','kills','deaths','ping','playerFlags','controlMethod','primaryIndex','secondaryIndex','weaponBink','controlBits','mouseDist','currentWaypoint','nextWaypoint'], ['vest'], ['ceaseFireCounter','kills','deaths','primaryIndex','secondaryIndex','weaponBink','mouseDist','currentWaypoint','nextWaypoint'], ['jetpack','demoPlayer']);
        const nameLength = raw.getUint32(RENDER_LAYOUT.sprite.playerNameLength, true);
        assert.equal(sprite.playerName, new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset + base + RENDER_LAYOUT.sprite.playerName, nameLength)));
        if (sprite.flags & 1) assert.ok(sprite.playerName.length > 0);
      }
      for (let index = 0; index < view.bulletCount; index++) {
        const bullet = view.bullet(index), raw = new DataView(bytes.buffer, bytes.byteOffset + view.bulletsOffset + 8 + index * RENDER_LAYOUT.bulletBytes, RENDER_LAYOUT.bulletBytes);
        checkScalarFields(bullet, raw, RENDER_LAYOUT.bullet, ['velocityPrevX','velocityPrevY','hitMultiply','hitMultiplyPrev','timeoutPrev','initialX','initialY','hitBody','pingAdd','pingAddStart','active','presentationFlags'], ['velocityPrevX','velocityPrevY','hitMultiply','hitMultiplyPrev','initialX','initialY'], ['timeoutPrev','pingAdd','pingAddStart'], ['active']);
        assert.ok(bullet.presentationFlags & BULLET_PRESENTATION_FLAGS.pingUnavailable);
        result.bullets++;
      }
      for (let index = 0; index < view.thingCount; index++) {
        const thing = view.thing(index), raw = new DataView(bytes.buffer, bytes.byteOffset + view.thingsOffset + 8 + index * RENDER_LAYOUT.thingBytes, RENDER_LAYOUT.thingBytes);
        checkScalarFields(thing, raw, RENDER_LAYOUT.thing, ['timeout','interest','color','presentationFlags','creationFacing'], [], ['timeout','interest']);
        assert.ok(thing.creationFacing === 0 || thing.creationFacing === 1);
        result.things++;
      }
      assert.equal(host.hash(), before, 'render publication mutates state');
      result.publications++;
    },
  });
  assert.equal(receipt.identical, true);
  for (const row of receipt.baseline) for (const event of gameplay(Buffer.from(row.events, 'hex'))) {
    const kind = Buffer.from(event, 'hex').readUInt32LE(0);
    result.gameplayEvents[kind] = (result.gameplayEvents[kind] ?? 0) + 1;
  }
}
assert.ok(result.bullets > 0 && result.things > 0, 'combat fixtures must exercise bullets and Things');

const hosts = await Promise.all([loadSim(wasm), loadSim(wasm)]);
try {
  for (const host of hosts) {
    await loadSimContent(host, manifest, readContent);
    requireStatus(host.init({ traceCombat: true }, 123456789), 'init');
    requireStatus(host.loadMap('Arena'), 'map');
    requireStatus(host.command(0, { kind: 'join', slot: 1, team: 0, spawn: 1, control: 'authoritative', weapon: 2 }), 'join');
    host.events();
  }
  const host = hosts[0];
  for (let tick = 0; tick < 2; tick++) {
    const aim = tick === 0 ? -10000 : 10000;
    requireStatus(host.setInput(1, tick, { MouseAimX: aim, MouseAimY: 0 }), 'aim');
    requireStatus(host.step(), 'step'); host.events();
    const direction = host.renderView().sprite(0).direction;
    requireStatus(host.command(tick + 1, { kind: 'thing', style: 5, owner: 1, x: 1000 + tick * 100, y: -1000 }), 'create facing Thing');
    const view = host.renderView(), item = view.thing(view.thingCount - 1);
    assert.equal(item.creationFacing, direction === 1 ? 0 : 1);
    result.crossInstanceFacing.push(item.creationFacing);
  }
  assert.deepEqual(result.crossInstanceFacing, [1, 0], 'must exercise both native creation variants');
  const state = host.saveState(); assert.ok(state instanceof Uint8Array);
  assert.equal(new DataView(state.buffer, state.byteOffset).getUint32(4, true), 0x00010006);
  requireStatus(hosts[1].loadState(state), 'cross-instance load');
  const left = host.renderView(), right = hosts[1].renderView();
  assert.equal(left.thingCount, right.thingCount);
  for (let i = 0; i < left.thingCount; i++) assert.deepEqual(right.thing(i), left.thing(i));
  assert.equal(hosts[1].hash(), host.hash());
  host.events(); // Creation commands precede the per-step replay comparison window.
  requireStatus(host.command(2, { kind: 'join', slot: 2, team: 0, spawn: 1, x: 1000, y: -1000, health: 1, control: 'authoritative', weapon: 2 }), 'join replay target');
  let cached = host.renderView(), cachedBuffer = cached.bytes.buffer;
  for (let tick = 2; tick < 182; tick++) {
    if (tick === 110) requireStatus(host.command(tick, { kind: 'bullet', weapon: 2, owner: 1, target: 2, hitCircle: 12, x: 0, y: 0, vx: 30, vy: 0, hitMultiply: 1000 }), 'inject genuine lethal projectile after spawn protection');
    const input = { Left: tick < 35, MouseAimX: -10000, MouseAimY: 0, Fire: tick > 60 };
    const before = host.saveState(); assert.ok(before instanceof Uint8Array);
    requireStatus(host.setInput(1, tick, input), 'live input'); requireStatus(host.step(), 'live step');
    const liveHash = host.hash(), liveEvents = host.events(); assert.ok(liveEvents instanceof Uint8Array);
    requireStatus(host.loadState(before), 'rewind'); requireStatus(host.setInput(1, tick, input), 'replay input'); requireStatus(host.step(1), 'replay step');
    const replayEvents = host.events(); assert.ok(replayEvents instanceof Uint8Array);
    assert.equal(host.hash(), liveHash); assert.deepEqual(gameplay(replayEvents), gameplay(liveEvents));
    result.replayGameplayEvents += gameplay(replayEvents).length;
    host.renderView();
    if (host.exports.memory.buffer !== cachedBuffer) { cached = host.renderView(); cachedBuffer = cached.bytes.buffer; }
    assert.equal(cached.tick, tick + 1, 'retained header getter must be live');
    result.replayComparisons++;
  }
  assert.ok(result.replayGameplayEvents > 0, 'replay must exercise non-presentation gameplay notifications');
} finally { for (const host of hosts) host.dispose(); }
const binkHost=await loadSim(wasm);
try {
  await loadSimContent(binkHost,manifest,readContent);
  const flat=await readFixture('tests/fixtures/combat/target-standing.fixture.json');
  requireStatus(binkHost.putFile(`maps/${flat.fixture.map.toLowerCase()}.pms`,new Uint8Array(await readFile(flat.fixture.mapPath))),'bink map');
  requireStatus(binkHost.init({traceCombat:true},123456789),'bink init');
  requireStatus(binkHost.loadMap(flat.fixture.map),'bink load map');
  for(let slot=1;slot<=2;slot++) requireStatus(binkHost.command(0,{kind:'join',slot,spawn:1,control:'authoritative',x:slot===1?-300:100,y:-32,weapon:slot===1?2:8,secondaryWeapon:0}),'bink join');
  requireStatus(binkHost.command(0,{kind:'weapon-apply',slot:1,weapon:2,secondaryWeapon:11,selection:'secondary'}),'secondary limbo');
  assert.equal(binkHost.renderView().sprite(0).secondaryWeapon,11);
  requireStatus(binkHost.command(0,{kind:'weapon-apply',slot:1,weapon:4,secondaryWeapon:11}),'primary limbo');
  assert.equal(binkHost.command(0,{kind:'weapon-apply',slot:1,weapon:3}),-4,'closed native limbo');
  for(let tick=0;tick<100;tick++){requireStatus(binkHost.step(),'bink protection');binkHost.events();}
  assert.equal(binkHost.renderView().sprite(1).weaponBink,65,'original Barrett bink');
  const before=binkHost.saveState(),command={kind:'bullet',weapon:2,owner:1,target:2,hitCircle:12,x:-15,y:0,vx:30,vy:0,hitMultiply:0.1};
  requireStatus(binkHost.command(100,command),'bink impact');requireStatus(binkHost.step(),'bink live');
  const liveHash=binkHost.hash(),live=binkHost.events(),amounts=[];
  const eventView=new DataView(live.buffer,live.byteOffset,live.byteLength);
  for(let offset=0;offset<live.length;offset+=20+eventView.getUint32(offset+16,true))
    if(eventView.getUint32(offset,true)===SIM_PRESENTATION_EVENTS.BINK && eventView.getUint32(offset+8,true)===2) amounts.push(eventView.getInt32(offset+20,true));
  assert.deepEqual(amounts,[65],'genuine original hit-spray input');
  requireStatus(binkHost.loadState(before),'bink rewind');requireStatus(binkHost.command(100,command),'bink replay impact');requireStatus(binkHost.step(1),'bink replay');
  assert.equal(binkHost.hash(),liveHash);
  const replay=binkHost.events(),replayView=new DataView(replay.buffer,replay.byteOffset,replay.byteLength);
  for(let offset=0;offset<replay.length;offset+=20+replayView.getUint32(offset+16,true)) assert.notEqual(replayView.getUint32(offset,true),SIM_PRESENTATION_EVENTS.BINK,'replay bink suppression');
  result.bink={hitAmounts:amounts,replaySuppressed:true,gameplayHashIdentical:true};result.limbo={secondaryApplied:true,primaryApplied:true,closedRejected:true};
} finally {binkHost.dispose();}
const botHosts=await Promise.all([loadSim(wasm),loadSim(wasm)]);
try {
  for(let index=0;index<botHosts.length;index++){
    await loadSimContent(botHosts[index],manifest,readContent);
    requireStatus(botHosts[index].init({ai:index===0,rng:'keyed'},123456789),'bot snapshot init');
    requireStatus(botHosts[index].loadMap('Arena'),'bot snapshot map');
  }
  const bot=botHosts[0];
  requireStatus(bot.command(0,{kind:'join',slot:1,control:'bot',bot:'Admiral'}),'profile bot join');
  assert.notEqual(bot.renderView().sprite(0).weapon,255,'original startup arms bot');
  const name=bot.renderView().sprite(0).playerName;
  requireStatus(bot.command(0,{kind:'spawn',slot:1}),'explicit profile bot respawn');
  assert.notEqual(bot.renderView().sprite(0).weapon,255,'explicit respawn retains profile weapon choice');
  assert.equal(bot.renderView().sprite(0).playerName,name);
  let waypoint=false;
  for(let tick=0;tick<120;tick++){requireStatus(bot.step(),'bot decisions');bot.events();waypoint ||= bot.renderView().sprite(0).currentWaypoint>0;}
  assert.equal(waypoint,true,'explicit respawn must not convert AI to Dummy');
  const state=bot.saveState();requireStatus(botHosts[1].loadState(state),'AI-on snapshot into AI-off prediction');
  assert.equal(botHosts[1].hash(),bot.hash());
  result.botSnapshot={explicitRespawnRetainsAI:true,waypointObserved:waypoint,aiOffLoadIdentical:true};
} finally {for(const host of botHosts)host.dispose();}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
