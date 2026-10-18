#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { stringifyReceipt } from '../../scripts/receipt-paths.mjs';

const root=process.cwd(),out=resolve(process.argv[2]??'build-out/sim/g5/final');
const frozen=process.argv[3];
if(!/^[a-f0-9]{64}$/.test(frozen??'')||!out.startsWith(root+'/'))throw new Error('Usage: node sim/build/run-g5.mjs OUTPUT FROZEN_WASM_SHA256');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
if(await hash('build-out/sim/sim.wasm')!==frozen)throw new Error('Frozen artifact mismatch');
await mkdir(join(out,'logs'),{recursive:true});
const stages=[];
async function run(name,command,args=[],env={},allowFailure=false){
  if(await hash('build-out/sim/sim.wasm')!==frozen)throw new Error('Artifact changed during qualification');
  if(spawnSync('memory_pressure',{stdio:'inherit'}).status!==0)throw new Error('Memory pressure unavailable');
  const started=performance.now(),logPath=join(out,'logs',`${name}.log`),log=createWriteStream(logPath);
  const code=await new Promise((done,reject)=>{
    const child=spawn(command,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.once('error',reject);child.once('close',code=>done(code??-1));
  });log.end();
  const stage={name,command:[command,...args],env,code,wallSeconds:(performance.now()-started)/1000,log:logPath};stages.push(stage);
  await writeFile(join(out,'execution.json'),stringifyReceipt({version:1,frozenWasmSha256:frozen,stages})+'\n');
  console.log(JSON.stringify(stage));
  if(code!==0&&!allowFailure)throw new Error(`${name} failed; inspect ${logPath}`);
}
const FPC=join(root,'build-out/sim/g3/defect-thing-target/toolchain/compile');
await run('build-linux','bash',['sim/build/build-sim.sh','linux'],{FPC});
await run('build-oracle','bash',['tools/oracle/build.sh'],{FPC});
await run('capture-movement','bun',['tests/tools/capture-movement.ts']);
await run('capture-combat','bun',['tools/oracle/capture-combat.ts']);
await run('capture-bots','bun',['tools/oracle/capture-bots.ts']);
await run('t1-movement',process.execPath,['sim/build/run-t1.mjs',join(out,'movement-t1')]);
await run('authority-movement',process.execPath,['sim/build/run-t1.mjs',join(out,'movement-authoritative'),'--authoritative'],{},true);
const authority=JSON.parse(await readFile(join(out,'movement-authoritative/results.json'),'utf8'));
if(authority.total!==98||authority.movementAndPoseIdentical!==98)throw new Error('Unledgered authoritative movement divergence');
for(const corpus of ['combat','bots'])await run(`t1-${corpus}`,process.execPath,['sim/build/run-combat.mjs','--corpus',`tests/fixtures/${corpus}/corpus.json`,'--tier','t1','--rng','original','--out',join(out,corpus)]);
for(const corpus of ['movement','combat','bots'])await run(`t2-${corpus}`,process.execPath,['sim/build/run-combat.mjs','--corpus',`tests/fixtures/${corpus}/corpus.json`,'--tier','t2','--rng','both','--out',join(out,corpus)]);
for(const engine of ['Chrome','Firefox'])await run(`browser-${engine.toLowerCase()}`,process.execPath,['sim/build/run-browser-matrix.mjs','--engine',engine,'--out',out]);
for(const corpus of ['movement','combat','bots'])await run(`t3-${corpus}`,process.execPath,['sim/build/run-combat.mjs','--corpus',`tests/fixtures/${corpus}/corpus.json`,'--tier','t3','--rng','both','--engines','Chrome,Firefox','--out',join(out,corpus)]);
await run('render',process.execPath,['sim/build/check-render.mjs','build-out/sim/sim.wasm',join(out,'render-check.json')]);
for(const weather of [1,2,3])await run(`presentation-${weather}`,process.execPath,['sim/build/check-presentation.mjs',String(weather),join(out,`presentation-${weather}.json`)]);
await run('robustness-5min',process.execPath,['--expose-gc','sim/build/check-bots.mjs','--minutes','5','--out',join(out,'robustness-5min.json')]);
await run('robustness-30min',process.execPath,['--expose-gc','sim/build/check-bots.mjs','--minutes','30','--maps','Arena,ctf_Ash,ctf_Laos','--out',join(out,'robustness-30min.json')]);
await writeFile(join(out,'qualification.json'),stringifyReceipt({version:1,status:'pass',frozenWasmSha256:frozen,nativeSha256:await hash('build-out/sim/linux/sim-native'),macNativeSha256:await hash('build-out/sim/sim-native'),oracleSha256:await hash('build-out/oracle/cmake/bin/opensoldatserver'),stages,omittedEngines:['Safari']})+'\n');
