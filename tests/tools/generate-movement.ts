import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { scanMaps, surfaces, pointInTriangle, sha256, basePin, upstreamPin } from './scan-movement-maps.ts';
import type { Surface, StockMap } from './scan-movement-maps.ts';
import { platform, writeMovementPms } from './write-movement-pms.ts';
import type { Triangle } from './write-movement-pms.ts';
import { parsePms } from '../../packages/content/src/readers.ts';

const output = 'tests/fixtures/movement';
const maps = await scanMaps(), edges = surfaces(maps);
const sim = JSON.parse(await readFile('dist/content/sim/manifest.json', 'utf8'));
await mkdir(`${output}/maps`, {recursive: true});
const fixtureNames: string[] = [];
const counts = Array.from({length:26}, (_,type) => maps.reduce((n,m) => n+m.map.polygons.filter(p=>p.polytype===type).length,0));
const synthetic: Record<number, StockMap> = {};
for (const type of counts.flatMap((count,type)=>count===0?[type]:[])) {
  const triangles: Triangle[] = type===24 ? [
    ...platform(0,100),
    {type:24,vertices:[[-80,-100],[80,-100],[80,100]]},
    {type:24,vertices:[[-80,-100],[80,100],[-80,100]]},
    {type:25,vertices:[[-100,-100],[-80,-100],[-80,100]]},
    {type:25,vertices:[[-100,-100],[-80,100],[-100,100]]},
    {type:25,vertices:[[80,-100],[100,-100],[100,100]]},
    {type:25,vertices:[[80,-100],[100,100],[80,100]]},
  ] : platform(type);
  const name = `movement-poly-${type}`, path = `${output}/maps/${name}.pms`, bytes = writeMovementPms(triangles,190);
  await writeFile(path,bytes);
  synthetic[type] = {name,path,sha256:sha256(bytes),map:parsePms(bytes)};
}
const capacityBytes=writeMovementPms(platform(0),1), capacityPath=`${output}/maps/movement-capacity-one.pms`;
await writeFile(capacityPath,capacityBytes);
const capacityOne: StockMap={name:'movement-capacity-one',path:capacityPath,sha256:sha256(capacityBytes),map:parsePms(capacityBytes)};

function select(type: number): Surface {
  const surface=edges.find(e=>e.polytype===type);
  if(surface) return surface;
  if(type===21) {
    const map=maps.find(m=>m.name==='ctf_Crucifix')!,polygon=map.map.polygons[2]!,a=polygon.vertices[0],b=polygon.vertices[1];
    return {map,polygon:3,edge:1,polytype:type,x:(a.x+b.x)/2,y:(a.y+b.y)/2,width:Math.abs(b.x-a.x),slope:(b.y-a.y)/(b.x-a.x),vertices:polygon.vertices.map(v=>[v.x,v.y]),normals:polygon.normals.map(v=>[v.x,v.y,v.z])};
  }
  if (synthetic[type]) {
    const map=synthetic[type]!,polygon=map.map.polygons.find(p=>p.polytype===type)!;
    return {map,polygon:map.map.polygons.indexOf(polygon)+1,edge:1,polytype:type,x:0,y:polygon.vertices[0].y,width:Math.abs(polygon.vertices[1].x-polygon.vertices[0].x),slope:0,vertices:polygon.vertices.map(v=>[v.x,v.y]),normals:polygon.normals.map(v=>[v.x,v.y,v.z])};
  }
  const map=maps.find(m=>m.map.polygons.some(p=>p.polytype===type)) ?? synthetic[type]!;
  const index=map.map.polygons.findIndex(p=>p.polytype===type), polygon=map.map.polygons[index]!;
  // Thin stock team/flag barriers have no unobstructed horizontal approach.
  // Start 12 units left of their leftmost edge and sweep through the real barrier.
  const left=Math.min(...polygon.vertices.map(v=>v.x)), right=Math.max(...polygon.vertices.map(v=>v.x));
  return {map,polygon:index+1,edge:0,polytype:type,x:map.path.startsWith(output)?0:left-12,y:polygon.vertices.reduce((n,v)=>n+v.y,0)/3+12,width:right-left,slope:0,vertices:polygon.vertices.map(v=>[v.x,v.y]),normals:polygon.normals.map(v=>[v.x,v.y,v.z])};
}
const flat=edges.find(e=>e.polytype===0 && e.slope===0 && e.width>1200)!;
const slope=edges.find(e=>e.map.name==='ctf_MFM'&&e.polygon===57&&e.edge===1)!;
const mirroredSlope=edges.find(e=>e.map.name==='ctf_MFM'&&e.polygon===110&&e.edge===1)!;
type InputSegment = {player:number;start:number;ticks:number;control:Record<string,number|boolean>;pressOrder:number};
const segment=(start:number,ticks:number,control:Record<string,number|boolean>,pressOrder=0)=>({player:1,start,ticks,control,pressOrder});

async function fixture(name:string,surface:Surface,inputs:InputSegment[],options:Record<string,any>={}) {
  const map=surface.map, isSynthetic=map.path.startsWith(output);
  const contentEntries={...sim.files};
  if(isSynthetic) contentEntries[`maps/${map.name.toLowerCase()}.pms`]={sha256:map.sha256};
  const contentSetHash=isSynthetic?sha256(Object.keys(contentEntries).sort().map(id=>`${id}\t${contentEntries[id].sha256}\n`).join('')):sim.sha256;
  const {ticks=360,team=0,heldFlag=0,health=150,x=surface.x,y=surface.y-32,...metadata}=options;
  const record={version:1,map:map.name,mapPath:map.path,mapSha256:map.sha256,contentSetHash,seed:123456789,ticks,traceStages:'all',
    ...(isSynthetic?{mapDirectory:'/fixture-maps'}:{}),
    players:[{team,spawnpoint:map.map.spawnpoints.findIndex(s=>s.active)+1,x,y,health,...(heldFlag?{heldFlag}:{})}],inputs,
    metadata:{purpose:name,coordinateSystem:'Original PMS world units; +X right, +Y down. Main particle starts 32 units above target edge unless explicitly overridden.',target:{polygon:surface.polygon,edge:surface.edge,polytype:surface.polytype,midpoint:[surface.x,surface.y],width:surface.width,slope:surface.slope,vertices:surface.vertices,rawNormals:surface.normals},source:isSynthetic?'test-only PMS: required missing polytype/capacity':'pinned stock PMS byte-identical',...metadata}};
  await writeFile(`${output}/${name}.fixture.json`,JSON.stringify(record,null,2)+'\n');
  fixtureNames.push(`${name}.fixture.json`);
}
for(const [kind,surface] of [['flat',flat],['slope',slope]] as const) for(const direction of [-1,1]) {
  const key=direction<0?'Left':'Right';
  const probe=kind==='slope'&&direction>0?mirroredSlope:surface;
  await fixture(`${kind}-${direction<0?'left':'right'}`,probe,[segment(61,90,{[key]:true,MouseAimX:direction*3000}),segment(151,90,{[direction<0?'Right':'Left']:true,MouseAimX:-direction*3000})],{mirrorPair:`${kind}-left/right`,mirrorMeaning:kind==='slope'?'Opposite stock ctf_MFM hills, exactly opposite top-edge slopes; upstream vertical asymmetry retained.':'Mirrored control/aim around identical starting point on unmodified horizontal stock geometry.'});
}
// Acute triangle from stock terrain, approached at its narrow vertex.
const acute=edges.find(e=>e.polytype===0 && e.vertices.some((v,i)=>{
  const a=e.vertices[(i+1)%3]!, b=e.vertices[(i+2)%3]!, ax=a[0]!-v[0]!,ay=a[1]!-v[1]!,bx=b[0]!-v[0]!,by=b[1]!-v[1]!;
  return (ax*bx+ay*by)/(Math.hypot(ax,ay)*Math.hypot(bx,by))>Math.cos(Math.PI/9);
}))!;
const acuteVertex=acute.vertices.find((v,i)=>{
  const a=acute.vertices[(i+1)%3]!, b=acute.vertices[(i+2)%3]!,ax=a[0]!-v[0]!,ay=a[1]!-v[1]!,bx=b[0]!-v[0]!,by=b[1]!-v[1]!;
  return (ax*bx+ay*by)/(Math.hypot(ax,ay)*Math.hypot(bx,by))>Math.cos(Math.PI/9);
})!;
const acuteDirection=acuteVertex[0]!<acute.x?-1:1, acuteX=acuteVertex[0]!-acuteDirection*24;
await fixture('acute-edges',acute,[segment(41,120,{[acuteDirection<0?'Left':'Right']:true}),segment(161,120,{[acuteDirection<0?'Right':'Left']:true})],{x:acuteX,y:acute.y+(acuteX-acute.x)*acute.slope-32,acuteMaximumAngleDegrees:20,acuteVertex});
// Shared stock triangle seams and overlaid polygons, not newly fabricated geometry.
const overlap=surfaces(maps,false).find(e=>e.polytype===0 && e.map.map.polygons.some((p,i)=>i+1!==e.polygon && p.polytype===0 && pointInTriangle(e.x,e.y+0.5,p.vertices)))!;
await fixture('overlap-seams',overlap,[segment(31,150,{Right:true,Down:true}),segment(181,100,{Left:true,Up:true})],{overlapMeaning:'Probe 0.5 units below target edge lies inside another original solid triangle; overlapping interiors, not only coincident endpoints.',overlapPolygons:overlap.map.map.polygons.flatMap((p,i)=>i+1!==overlap.polygon&&p.polytype===0&&pointInTriangle(overlap.x,overlap.y+0.5,p.vertices)?[i+1]:[])});
for(const first of ['left','right'] as const) for(const jumping of [false,true]) {
  const key=first==='left'?'Left':'Right', order=first==='left'?1:2;
  await fixture(`both-keys-${first}-first-${jumping?'air':'ground'}`,flat,[segment(41,10,{[key]:true,...(jumping?{Up:true}:{})}),segment(51,90,{Left:true,Right:true,...(jumping?{Up:true}:{})},order)]);
}
for(const order of [4,8]) await fixture(`up-down-order-${order===4?'up':'down'}-first`,flat,[segment(41,60,{Up:true,Down:true},order)]);
for(const duration of [1,60]) await fixture(`jump-${duration===1?'tap':'hold'}`,flat,[segment(61,duration,{Up:true,MouseAimX:3000})]);
for(const direction of [-1,1]) {
  const key=direction<0?'Left':'Right', side=direction<0?'left':'right';
  await fixture(`sidejump-${side}`,flat,[segment(41,7,{[key]:true,MouseAimX:direction*3000}),segment(48,30,{[key]:true,Up:true,MouseAimX:direction*3000})]);
  await fixture(`backflip-${side}`,flat,[segment(41,10,{[key]:true,MouseAimX:-direction*3000}),segment(51,2,{[key]:true,Down:true,MouseAimX:-direction*3000}),segment(53,24,{[key]:true,Up:true,MouseAimX:-direction*3000})]);
  await fixture(`roll-crouch-prone-getup-${side}`,flat,[segment(41,15,{[key]:true,MouseAimX:direction*3000}),segment(56,25,{[key]:true,Down:true,MouseAimX:direction*3000}),segment(81,30,{Down:true,MouseAimX:direction*3000}),segment(111,1,{Prone:true,MouseAimX:direction*3000}),segment(112,60,{MouseAimX:direction*3000}),segment(172,35,{[key]:true,MouseAimX:direction*3000}),segment(207,1,{Prone:true,MouseAimX:direction*3000}),segment(208,60,{[key]:true,MouseAimX:direction*3000})]);
}
for(const [label,map] of [['zero',maps.find(m=>m.map.startJet===0)!],['one',capacityOne],['normal',maps.find(m=>m.name==='Arena')!]] as const) {
  const e=surfaces([map]).find(e=>[0,2,4].includes(e.polytype)) ?? surfaces([map],false).find(e=>[0,2,4].includes(e.polytype));
  if(!e) throw new Error(`No stock movement surface on ${map.name}`);
  for(const parity of [0,1]) {
    const spawn=map.map.spawnpoints.find(s=>s.active)!;
    const inputs=label==='normal'
      ? [segment(61+parity,120,{Right:true,MouseAimX:400}),segment(181+parity,20,{Up:true,MouseAimX:400}),segment(201+parity,300,{Jetpack:true,MouseAimX:400})]
      : [segment(61+parity,260,{Jetpack:true}),segment(321+parity,60,{Down:true}),segment(381+parity,40,{Jetpack:true})];
    await fixture(`jets-${label}-refill-${parity===0?'even':'odd'}`,e,inputs,{ticks:label==='normal'?900:600,jetRaw:map.map.startJet,jetCapacity:Math.floor(119*map.map.startJet/100),releaseTick:(label==='normal'?501:321)+parity,...(label==='normal'?{x:spawn.x,y:spawn.y}:{})});
  }
}
for(let type=0;type<26;type++) {
  const surface=select(type);
  if(type>=10&&type<=17) {
    const start=surface.edge===0?1:61;
    for(let team=0;team<=4;team++) await fixture(`poly-${type}-team-${team}`,surface,[segment(start,20,{Right:true}),segment(start+20,40,{Left:true})],{team});
  } else if(type>=20&&type<=23) {
    const start=type===21||surface.edge===0?1:61;
    for(const heldFlag of [0,1,2,3]) {
      const inputs=type===21?[segment(start,20,{Left:true}),segment(start+40,20,{Right:true})]:[segment(start,20,{Right:true}),segment(start+40,20,{Left:true})];
      await fixture(`poly-${type}-flag-${heldFlag}`,surface,inputs,{heldFlag,team:0,...(type===21?{x:surface.x-surface.normals[0]![0]!*12,y:surface.y-surface.normals[0]![1]!*12}:{})});
    }
  } else {
    const input=type===24?[segment(41,80,{Right:true}),segment(141,100,{Left:true})]:type===4?[segment(41,60,{Right:true})]:[];
    await fixture(`poly-${type}-lone-player`,surface,input,{...(type===8?{health:50}:{}),...(type===24?{x:-150,y:68}:{}),lonePlayer:true});
  }
}
for(const [label,surface] of [['flat',flat],['slope',slope]] as const) {
  const inputs=[];
  for(let tick=61;tick<10000;tick+=240) {
    inputs.push(segment(tick,65,{Right:true,MouseAimX:3000}),segment(tick+65,65,{Left:true,MouseAimX:-3000}),segment(tick+130,25,{Up:true,Jetpack:true}),segment(tick+180,30,{Down:true}));
  }
  await fixture(`long-${label}-10000`,surface,inputs,{ticks:10000});
}
const scan={maps:maps.length,basePin,upstreamPin,polytypeCounts:counts,jetCapacities:maps.map(m=>({map:m.name,raw:m.map.startJet,runtime:Math.floor(119*m.map.startJet/100)})),mapHashes:maps.map(m=>({map:m.name,path:m.path,sha256:m.sha256}))};
await writeFile(`${output}/stock-scan.json`,JSON.stringify(scan,null,2)+'\n');
await writeFile(`${output}/corpus.json`,JSON.stringify({
  version:1,basePin,upstreamPin,baseContentSetHash:sim.sha256,fixtures:fixtureNames,
  schema:{
    mapPath:'Repository-relative raw PMS path; canonical VFS id is maps/<lowercase map>.pms.',
    mapSha256:'SHA256 of exact PMS bytes.',
    contentSetHash:'SHA256 of sorted canonical path<TAB>SHA256<LF> sim manifest records; synthetic map entry is added to base set.',
    players:'spawnpoint remains required active one-based PMS index; x/y override initial coordinates; health defaults150; heldFlag optional1/2/3 creates real held flag.',
    pressOrder:'inputs[].pressOrder u16: 0 preserves raw server TControl. Nonzero bit0 left-first, bit1 right-first, bit2 up-first, bit3 down-first. Prior jump history chooses old vs newer L/R as original client resolution. Up/Down remain both held: no original Up/Down exclusivity branch.',
    traceStages:'all includes every per-stage diagnostic; required for the entire corpus including long runs. tick is optional tooling only and not qualifying T1 evidence.',
    observations:'capture-results.json records real oracle outcomes. coverage.json distinguishes measured state outcomes from inferred polygon contact; source polygon geometry and probe coordinates are fixture metadata.',
  },
  regeneration:{
    generate:'bun tests/tools/generate-movement.ts',capture:'bun tests/tools/capture-movement.ts',
    review:'bun tests/tools/review-movement.ts',oracleBuild:'tools/oracle/build.sh',
    image:'sha256:c6c157119f132948a81784aba8e49e51afab22421e70637f39feae191eabb46c',network:'none',
    compression:'gzip level9, mtime0; files under5MB retained, larger traces hash+regeneration only.',
  },
},null,2)+'\n');
console.log(JSON.stringify({fixtures:fixtureNames.length,stockMaps:maps.length,syntheticTypes:Object.keys(synthetic),syntheticCapacity:1,longRuns:2}));
