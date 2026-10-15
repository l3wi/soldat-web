#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSim, loadSimContent, requireStatus } from '../../packages/sim-host/src/sim.ts';
const wasm = new Uint8Array(await readFile('build-out/sim/sim.wasm'));
const weather = Number(process.argv[2] ?? 1);
if (![1,2,3].includes(weather)) throw new Error("Weather must be 1, 2 or 3");
const manifest = JSON.parse(await readFile('dist/content/sim/manifest.json','utf8'));
const hosts = await Promise.all([loadSim(wasm),loadSim(wasm)]);
const result = { weather, wasmSha256:createHash('sha256').update(wasm).digest('hex'), ticks:600, hashComparisons:0, replayComparisons:0, soundEvents:0, sparks:0, weatherAlpha105:true };
try {
  for (const host of hosts) {
    await loadSimContent(host,manifest,async path=>new Uint8Array(await readFile(resolve('dist/content',path))));
    const arena = manifest.files['maps/arena.pms'];
    const raw = new Uint8Array(await readFile(resolve('dist/content',arena.path)));
    raw[82] = weather; // PMS v11 header: weather after two fixed shortstrings, colors, jets and kit counts.
    requireStatus(host.putFile('maps/arena.pms',raw),'weather map overlay');
    requireStatus(host.init({},123456789),'init');requireStatus(host.loadMap('Arena'),'map');
    requireStatus(host.command(0,{kind:'join',slot:1,team:0,spawn:1}),'join');
    requireStatus(host.fxSetView(0,0,854,480,1),'fx camera');
  }
  for (let tick=0;tick<result.ticks;tick++) {
    const control={Right:tick<180,Up:tick>=60&&tick<95,Jetpack:tick>=100&&tick<300,MouseAimX:200,MouseAimY:-40};
    for (const host of hosts) requireStatus(host.setInput(1,tick,control),'input');
    const before=hosts[0].saveState();if(typeof before==='number')throw new Error('save failure');
    requireStatus(hosts[0].step(),'step');requireStatus(hosts[1].step(),'step');
    const expected=hosts[0].hash();
    if(hosts[1].hash()!==expected)throw new Error(`pre-FX hash mismatch at ${tick}`);
    requireStatus(hosts[1].fxStep(),'fx step');
    const fx=hosts[1].fxRenderView();if(typeof fx==='number')throw new Error('missing FX view');
    result.sparks+=fx.count;
    for(let i=0;i<fx.count;i++){const spark=fx.spark(i);if([38,39,53].includes(spark.style)&&spark.alpha!==105)result.weatherAlpha105=false;}
    if(hosts[1].hash()!==expected)throw new Error(`FX changed gameplay at ${tick}`);result.hashComparisons++;
    requireStatus(hosts[0].loadState(before),'rewind');requireStatus(hosts[0].step(1),'replay');
    if(hosts[0].hash()!==expected)throw new Error(`replay gameplay mismatch at ${tick}`);result.replayComparisons++;
    const replayView=hosts[0].fxRenderView();requireStatus(hosts[0].fxStep(),'replay fx no-step');
    if(typeof replayView==='number')throw new Error('missing replay FX view');
    if(hosts[0].fxRenderView().count!==replayView.count)throw new Error('FX stepped in replay');
    for(const host of hosts){const events=host.events();if(typeof events==='number')throw new Error('events failure');
      const view=new DataView(events.buffer,events.byteOffset,events.byteLength);
      for(let o=0;o<events.length;){if(view.getUint32(o,true)===0x80000004)result.soundEvents++;o+=20+view.getUint32(o+16,true);}
    }
  }
  if(!result.sparks||!result.soundEvents||!result.weatherAlpha105)throw new Error('presentation was not exercised');
  await mkdir('build-out/sim/g3',{recursive:true});await writeFile(`build-out/sim/g3/presentation-${weather}.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {for(const host of hosts)host.dispose();}
