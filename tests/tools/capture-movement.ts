import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const root=process.cwd(), directory='tests/fixtures/movement', output='build-out/movement-oracle';
const image='sha256:c6c157119f132948a81784aba8e49e51afab22421e70637f39feae191eabb46c';
const corpus=JSON.parse(await readFile(`${directory}/corpus.json`,'utf8'));
const requested=process.argv.slice(2), names: string[]=requested.length?corpus.fixtures.filter((name:string)=>requested.some(prefix=>name.startsWith(prefix))):corpus.fixtures;
if(!names.length) throw new Error('No fixtures match requested prefixes');
await mkdir(`${directory}/golden`,{recursive:true});
await mkdir(`${output}/tmp`,{recursive:true}); await mkdir(`${output}/home`,{recursive:true});
let previous:any={captures:[]};
try { previous=JSON.parse(await readFile(`${directory}/capture-results.json`,'utf8')); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
const captures=new Map<string,any>(previous.captures.map((c:any)=>[c.fixture,{oracleBinarySha256:previous.oracleBinarySha256,harnessSha256:previous.harnessSha256,sharedTraceSha256:previous.sharedTraceSha256,...c}]));

async function execute(args:string[]) {
  return await new Promise<{code:number;stdout:string;stderr:string}>(done=>{
    const child=spawn('docker',args,{cwd:root}),out:Buffer[]=[],err:Buffer[]=[];
    child.stdout.on('data',chunk=>out.push(chunk)); child.stderr.on('data',chunk=>err.push(chunk));
    child.on('error',error=>done({code:-1,stdout:'',stderr:String(error)}));
    child.on('close',code=>done({code:code??-1,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()}));
  });
}
async function hashFile(path:string) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function summarize(path:string,fixture:any) {
  let records=0,states=0,lastTick=0,minFuel=Infinity,maxFuel=-Infinity,groundedTicks=0,deadTicks=0,firstEmptyTick:number|null=null,firstGroundedAfterEmpty:number|null=null,minHealth=Infinity,maxHealth=-Infinity;
  let minimumTargetDistance=Infinity,firstStandingTypeTick:number|null=null,nearTargetStandingTicks=0,priorFuel:number|undefined,priorBackground:string|undefined;
  const legs=new Set<number>(),body=new Set<number>(),background=new Set<number>(),postures=new Set<number>(),held=new Set<number>(),standingTypes=new Set<number>();
  const fuelSamples:any[]=[],pathSamples:any[]=[],backgroundTransitions:any[]=[],refillDeltas:any[]=[]; let final:any;
  const target=fixture.metadata.target,vertices=target.vertices;
  for await(const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})) {
    records++; const row=JSON.parse(line); if(row.type!=='state') continue; states++;
    if(!['initial','tick'].includes(row.stage)) continue;
    lastTick=row.tick;
    const sprite=row.sprites[0]; if(!sprite) continue;
    legs.add(sprite.legs.id);body.add(sprite.body.id);background.add(sprite.backgroundStatus);postures.add(sprite.position);held.add(sprite.heldThing);standingTypes.add(sprite.standingPolyType);
    const x=sprite.particle.pos[0].decimal,y=sprite.particle.pos[1].decimal;
    let distance=Infinity;
    for(let edge=0;edge<3;edge++) {
      const a=vertices[edge],b=vertices[(edge+1)%3],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));
      distance=Math.min(distance,Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy));
    }
    minimumTargetDistance=Math.min(minimumTargetDistance,distance);
    if(sprite.standingPolyType===target.polytype&&sprite.onGround) {
      if(firstStandingTypeTick===null)firstStandingTypeTick=row.tick;
      if(distance<16)nearTargetStandingTicks++;
    }
    const bg=`${sprite.backgroundStatus}:${sprite.backgroundPoly}:${sprite.backgroundTestResult}`;
    if(bg!==priorBackground) {backgroundTransitions.push({tick:row.tick,status:sprite.backgroundStatus,poly:sprite.backgroundPoly,testResult:sprite.backgroundTestResult});priorBackground=bg;}
    minFuel=Math.min(minFuel,sprite.jetsCount);maxFuel=Math.max(maxFuel,sprite.jetsCount);
    minHealth=Math.min(minHealth,sprite.health.decimal);maxHealth=Math.max(maxHealth,sprite.health.decimal);
    if(sprite.onGround) groundedTicks++;if(sprite.dead) deadTicks++;
    if(sprite.jetsCount===0&&firstEmptyTick===null)firstEmptyTick=row.tick;
    if(firstEmptyTick!==null&&row.tick>firstEmptyTick&&sprite.onGround&&firstGroundedAfterEmpty===null)firstGroundedAfterEmpty=row.tick;
    if(priorFuel!==undefined&&sprite.jetsCount>priorFuel)refillDeltas.push([row.tick,sprite.jetsCount-priorFuel,sprite.onGround]);
    priorFuel=sprite.jetsCount;
    if(row.tick>=315&&row.tick<=Math.max(430,(fixture.metadata.releaseTick??0)+90))fuelSamples.push([row.tick,sprite.jetsCount,sprite.onGround]);
    if(row.tick<=180&&row.tick%10===0)pathSamples.push([row.tick,x,y,sprite.onGround,sprite.standingPolyType]);
    final={tick:row.tick,pos:sprite.particle.pos,dead:sprite.dead,health:sprite.health,jetsCount:sprite.jetsCount};
  }
  return {records,states,ticks:lastTick,minFuel,maxFuel,groundedTicks,deadTicks,firstEmptyTick,firstGroundedAfterEmpty,minHealth,maxHealth,legs:[...legs].sort((a,b)=>a-b),body:[...body].sort((a,b)=>a-b),background:[...background].sort(),backgroundTransitions,standingTypes:[...standingTypes].sort((a,b)=>a-b),targetObservation:{polygon:target.polygon,polytype:target.polytype,minimumMainParticleToEdgeDistance:minimumTargetDistance,firstStandingTypeTick,nearTargetStandingTicks,evidence:nearTargetStandingTicks>0?'Measured matching StandingPolyType while grounded within16 world units of target geometry; polygon identity inferred from geometry.':'No matched grounded contact proof; inspect paired path/health/background outcomes. Proximity alone is not proof.'},postures:[...postures].sort(),heldThings:[...held].sort(),fuelSamples,refillDeltas,pathSamples,final};
}
const oracleBinarySha256=await hashFile('build-out/oracle/cmake/bin/opensoldatserver');
const harnessSha256=await hashFile('build-out/oracle/source/server/OracleHarness.pas');
const sharedTraceSha256=await hashFile('build-out/oracle/source/server/OracleTrace.inc');
for(const name of names) {
  const basename=name.replace(/\.fixture\.json$/,''), raw=`${output}/${basename}.jsonl`, gzip=`${directory}/golden/${basename}.jsonl.gz`;
  const fixture=JSON.parse(await readFile(`${directory}/${name}`,'utf8'));
  // Bind host directories for every write; the image root and oracle artifacts stay read-only.
  const args=['run','--rm','--network','none','--read-only','--platform','linux/arm64',
    '-v',`${root}/build-out/oracle:/work:ro`,'-v',`${root}/${directory}/${name}:/fixture.json:ro`,
    '-v',`${root}/${directory}:/fixture-maps:ro`,'-v',`${root}/${output}:/output`,
    '-w','/work/runtime','-e','LD_LIBRARY_PATH=/work/cmake/bin','-e','TMPDIR=/output/tmp','-e','HOME=/output/home',image,
    '/work/cmake/bin/opensoldatserver','/fixture.json',`/output/${basename}.jsonl`,'/work/base/soldat.smod','/work/runtime'];
  const started=performance.now(),result=await execute(args);
  if(result.code!==0) throw new Error(`${name}: oracle exit ${result.code}\n${result.stdout}\n${result.stderr}`);
  const summary=await summarize(raw,fixture);
  if(summary.ticks!==fixture.ticks)throw new Error(`${name}: truncated trace ${summary.ticks}/${fixture.ticks}`);
  const bytes=(await stat(raw)).size,sha256=await hashFile(raw);
  await pipeline(createReadStream(raw),createGzip({level:9}),createWriteStream(gzip));
  const compressedBytes=(await stat(gzip)).size,compressedSha256=await hashFile(gzip),retained=compressedBytes<5_000_000;
  if(!retained)await unlink(gzip);
  let repeat:any;
  if(basename==='flat-left') {
    const repeated=await execute(args),repeatSha256=repeated.code===0?await hashFile(raw):null;
    repeat={command:['docker',...args],exitCode:repeated.code,sha256:repeatSha256,byteIdentical:repeatSha256===sha256,stdout:repeated.stdout,stderr:repeated.stderr};
    if(repeated.code!==0||repeatSha256!==sha256)throw new Error(`${name}: repeat oracle capture differs`);
  }
  const capture={oracleBinarySha256,harnessSha256,sharedTraceSha256,fixture:name,fixtureSha256:await hashFile(`${directory}/${name}`),mapSha256:fixture.mapSha256,contentSetHash:fixture.contentSetHash,
    command:['docker',...args],exitCode:result.code,stdout:result.stdout,stderr:result.stderr,wallSeconds:Math.round((performance.now()-started)/10)/100,
    golden:retained?`golden/${basename}.jsonl.gz`:null,bytes,sha256,compressedBytes,compressedSha256,compression:'gzip level9 mtime0',...(repeat?{repeat}:{}),summary};
  captures.set(name,capture);await unlink(raw);
  await writeFile(`${directory}/capture-results.json`,JSON.stringify({version:1,image,platform:'linux/arm64',network:'none',oracleBinarySha256,harnessSha256,sharedTraceSha256,captures:[...captures.values()].sort((a,b)=>a.fixture.localeCompare(b.fixture))},null,2)+'\n');
  console.log(JSON.stringify({fixture:name,exitCode:0,bytes,compressedBytes,sha256,retained,ticks:summary.ticks,legs:summary.legs,background:summary.background,health:[summary.minHealth,summary.maxHealth]}));
}
console.log(JSON.stringify({captured:names.length,total:captures.size,rawBytes:[...captures.values()].reduce((n,c)=>n+c.bytes,0),gzipBytes:[...captures.values()].reduce((n,c)=>n+c.compressedBytes,0)}));
