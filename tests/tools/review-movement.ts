import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { parsePms } from '../../packages/content/src/readers.ts';

const directory='tests/fixtures/movement';
const corpus=JSON.parse(await readFile(`${directory}/corpus.json`,'utf8'));
const results=JSON.parse(await readFile(`${directory}/capture-results.json`,'utf8'));
const byName:Record<string,any>=Object.fromEntries(results.captures.map((c:any)=>[c.fixture.replace('.fixture.json',''),c]));
const checks:{name:string;proven:boolean;evidence:unknown}[]=[];
for(const filename of corpus.fixtures) {
  const capture=byName[filename.replace('.fixture.json','')],bytes=await readFile(`${directory}/${filename}`);
  checks.push({name:`capture:${filename}`,proven:!!capture&&capture.exitCode===0&&capture.fixtureSha256===createHash('sha256').update(bytes).digest('hex')&&capture.summary.ticks>=300&&capture.summary.states===6*capture.summary.ticks+1,evidence:capture?{ticks:capture.summary.ticks,states:capture.summary.states,requiredStates:6*capture.summary.ticks+1,compressedBytes:capture.compressedBytes,sha256:capture.sha256}:'missing capture'});
}
for(const direction of ['left','right']) {
  for(const [kind,required] of [['sidejump',[4]],['backflip',[23]],['roll-crouch-prone-getup',[22,6,34,38,39]]] as const) {
    const c=byName[`${kind}-${direction}`];
    checks.push({name:`animation:${kind}-${direction}`,proven:required.every(id=>c.summary.legs.includes(id)),evidence:{required,observed:c.summary.legs}});
  }
}
for(const direction of ['left','right']) {
  const c=byName[`backflip-${direction}`]; let impulseFrame:any=null;
  for await(const line of createInterface({input:createReadStream(`${directory}/${c.golden}`).pipe(createGunzip()),crlfDelay:Infinity})) {
    const row=JSON.parse(line);if(row.type!=='state'||row.stage!=='tick')continue;
    const s=row.sprites[0],vy=s.particle.velocity[1].decimal;
    if(s.legs.id===23&&s.legs.frame>1&&s.legs.frame<8&&vy<-.5)impulseFrame??={tick:row.tick,frame:s.legs.frame,velocityY:vy};
  }
  checks.push({name:`backflip-upward-impulse:${direction}`,proven:impulseFrame!==null,evidence:impulseFrame});
}
for(const kind of ['flat','slope']) for(const direction of ['left','right']) {
  const s=byName[`${kind}-${direction}`].summary;
  checks.push({name:`terrain-run:${kind}-${direction}`,proven:s.targetObservation.nearTargetStandingTicks>0,evidence:s.targetObservation});
}
for(const first of ['left','right']) for(const mode of ['ground','air']) {
  const s=byName[`both-keys-${first}-first-${mode}`].summary,initial=s.pathSamples[0][1],sample=s.pathSamples.find((p:any)=>p[0]===100),wanted=(first==='left'?1:-1)*(mode==='ground'?1:-1);
  checks.push({name:`key-order:${first}-${mode}`,proven:(sample[1]-initial)*wanted>0,evidence:{initialX:initial,tick100X:sample[1],expectedDirection:wanted}});
}
checks.push({name:'up-down-order-preserves-original-no-priority',proven:byName['up-down-order-up-first'].sha256===byName['up-down-order-down-first'].sha256,evidence:{upFirst:byName['up-down-order-up-first'].sha256,downFirst:byName['up-down-order-down-first'].sha256}});
const acute=byName['acute-edges'],acuteFixture=JSON.parse(await readFile(`${directory}/${acute.fixture}`,'utf8'));let nearestAcuteVertex=Infinity;
for await(const line of createInterface({input:createReadStream(`${directory}/${acute.golden}`).pipe(createGunzip()),crlfDelay:Infinity})) {
  const row=JSON.parse(line);if(row.type!=='state'||row.stage!=='tick')continue;
  const p=row.sprites[0].particle.pos,v=acuteFixture.metadata.acuteVertex;
  nearestAcuteVertex=Math.min(nearestAcuteVertex,Math.hypot(p[0].decimal-v[0],p[1].decimal-v[1]));
}
checks.push({name:'acute-vertex-probe',proven:nearestAcuteVertex<16&&acute.summary.targetObservation.nearTargetStandingTicks>0,evidence:{nearestAcuteVertex,target:acute.summary.targetObservation,acuteVertex:acuteFixture.metadata.acuteVertex}});
const overlap=byName['overlap-seams'],overlapFixture=JSON.parse(await readFile(`${directory}/${overlap.fixture}`,'utf8'));
checks.push({name:'overlapping-stock-triangle-probe',proven:overlapFixture.metadata.overlapPolygons.length>0&&overlap.summary.targetObservation.nearTargetStandingTicks>0,evidence:{overlapPolygons:overlapFixture.metadata.overlapPolygons,target:overlap.summary.targetObservation}});
checks.push({name:'ice-contact',proven:byName['poly-4-lone-player'].summary.targetObservation.nearTargetStandingTicks>0,evidence:byName['poly-4-lone-player'].summary.targetObservation});
checks.push({name:'tap/hold-jump',proven:[byName['jump-tap'],byName['jump-hold']].every(c=>c.summary.legs.includes(3))&&byName['jump-hold'].summary.groundedTicks<byName['jump-tap'].summary.groundedTicks,evidence:{tapGrounded:byName['jump-tap'].summary.groundedTicks,holdGrounded:byName['jump-hold'].summary.groundedTicks}});
for(const parity of ['even','odd']) for(const [label,capacity] of [['zero',0],['one',1],['normal',226]] as const) {
  const c=byName[`jets-${label}-refill-${parity}`],s=c.summary;
  checks.push({name:`fuel:${label}-${parity}`,proven:s.minFuel===0&&s.maxFuel===capacity&&(capacity===0||s.refillDeltas.length>0),evidence:{min:s.minFuel,max:s.maxFuel,firstEmpty:s.firstEmptyTick,groundedAfterEmpty:s.firstGroundedAfterEmpty,groundedRefills:s.refillDeltas.filter((r:any)=>r[2]).length,airborneRefills:s.refillDeltas.filter((r:any)=>!r[2]).length,refillTickParity:[...new Set(s.refillDeltas.map((r:any)=>r[0]%2))]}});
}
for(let type=10;type<=17;type++) {
  const group=Array.from({length:5},(_,team)=>byName[`poly-${type}-team-${team}`]);
  const eligible=type%2===1?(type-9)/2:null;
  const reference=group[0].summary.pathSamples;
  const distinct=group.map(c=>JSON.stringify(c.summary.pathSamples)!==JSON.stringify(reference));
  checks.push({name:`team-filter:${type}`,proven:eligible===null?distinct.every(v=>!v):distinct[eligible]&&group[eligible].summary.targetObservation.minimumMainParticleToEdgeDistance<16,evidence:{eligibleTeam:eligible,distinctFromTeam0:distinct,groups:group.map(c=>({fixture:c.fixture,target:c.summary.targetObservation,standingTypes:c.summary.standingTypes,grounded:c.summary.groundedTicks,final:c.summary.final.pos}))}});
}
for(let type=20;type<=23;type++) {
  const group=Array.from({length:4},(_,flag)=>byName[`poly-${type}-flag-${flag}`]);
  const distinct=group.map(c=>JSON.stringify(c.summary.pathSamples)!==JSON.stringify(group[0].summary.pathSamples));
  const proven=type===20?group[0].summary.minHealth===150&&group.slice(1).every(c=>c.summary.minHealth<150):type===23?distinct.every(v=>!v):group.slice(1).every((c,i)=>distinct[i+1]&&c.summary.targetObservation.minimumMainParticleToEdgeDistance<16);
  checks.push({name:`flag-filter:${type}`,proven,evidence:group.map(c=>({fixture:c.fixture,health:[c.summary.minHealth,c.summary.maxHealth],grounded:c.summary.groundedTicks,standingTypes:c.summary.standingTypes,target:c.summary.targetObservation,final:c.summary.final.pos}))});
}
for(const type of [5,6,7,8,9,19]) {
  const c=byName[`poly-${type}-lone-player`],s=c.summary;
  checks.push({name:`special-poly:${type}`,proven:type===8?s.maxHealth>50:[5,6,19].includes(type)?s.deadTicks>0:s.minHealth<150,evidence:{health:[s.minHealth,s.maxHealth],deadTicks:s.deadTicks,standingTypes:s.standingTypes,target:s.targetObservation}});
}
for(const type of [24,25]) {
  const c=byName[`poly-${type}-lone-player`],transitions=c.summary.backgroundTransitions;
  const fixture=JSON.parse(await readFile(`${directory}/${c.fixture}`,'utf8')),map=parsePms(await readFile(fixture.mapPath));
  const observedBackgroundPolygons=transitions.filter((t:any)=>t.poly>0).map((t:any)=>({polygon:t.poly,polytype:map.polygons[t.poly-1]?.polytype}));
  checks.push({name:`background:${type}`,proven:transitions.some((t:any)=>t.testResult)&&transitions.some((t:any)=>t.status===0)&&transitions.some((t:any)=>t.status===1)&&(type===24?observedBackgroundPolygons.some((p:any)=>p.polytype===24):c.summary.targetObservation.minimumMainParticleToEdgeDistance<16),evidence:{transitions,observedBackgroundPolygons,polygonIdentity:type===24?'Measured original BackgroundPoly resolves to raw PMS type24.':'Specific type25 polygon identity inferred from probe proximity; background entry/exit state transitions are measured.'}});
}
const bounce=byName['poly-18-lone-player'];
let minimumVerticalVelocity=0,maximumVerticalVelocity=0;
for await(const line of createInterface({input:createReadStream(`${directory}/${bounce.golden}`).pipe(createGunzip()),crlfDelay:Infinity})) {
  const row=JSON.parse(line);if(row.type!=='state'||row.stage!=='tick')continue;
  const vy=row.sprites[0].particle.velocity[1].decimal;
  minimumVerticalVelocity=Math.min(minimumVerticalVelocity,vy);maximumVerticalVelocity=Math.max(maximumVerticalVelocity,vy);
}
checks.push({name:'bouncy-raw-normal',proven:minimumVerticalVelocity<-1&&maximumVerticalVelocity>1,evidence:{minimumVerticalVelocity,maximumVerticalVelocity,target:bounce.summary.targetObservation}});
const longRuns=results.captures.filter((c:any)=>c.summary.ticks===10000);
checks.push({name:'two-long-runs',proven:longRuns.length>=2,evidence:longRuns.map((c:any)=>({fixture:c.fixture,ticks:c.summary.ticks,sha256:c.sha256,compressedBytes:c.compressedBytes}))});
const report={version:1,meaning:'Evidence review of original Linux server oracle, not sim-native/WASM equivalence. StandingPolyType is measured; exact source polygon identity is inferred from recorded probe geometry. False checks remain unproven and must not be called passing coverage.',fixtures:corpus.fixtures.length,checks,unproven:checks.filter(c=>!c.proven).map(c=>c.name),rawBytes:results.captures.reduce((n:number,c:any)=>n+c.bytes,0),gzipBytes:results.captures.reduce((n:number,c:any)=>n+c.compressedBytes,0),retainedGoldens:results.captures.filter((c:any)=>c.golden).length};
await writeFile(`${directory}/coverage.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({fixtures:report.fixtures,checks:checks.length,unproven:report.unproven,rawBytes:report.rawBytes,gzipBytes:report.gzipBytes,retainedGoldens:report.retainedGoldens}));
if(report.unproven.length)process.exitCode=1;
