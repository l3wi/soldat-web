import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BULLET_PRESENTATION_FLAGS, RENDER_ABI_VERSION, RENDER_LAYOUT, THING_PRESENTATION_FLAGS, readRenderView } from '@soldat-web/sim-host';
import { CombatRenderer, assertCombatInvariants, type CombatGraphic } from './combat';
import type { Regions } from './geometry';

// Rendering-only ABI fixtures. These are NOT simulation or movement qualification.
const manifest=JSON.parse(readFileSync(new URL('../../../../dist/content-next/manifest.json',import.meta.url),'utf8'));
const skeletons=JSON.parse(readFileSync(new URL('../../../../dist/content-next/skeletons.json',import.meta.url),'utf8'));
const graphics: CombatGraphic[]=[...manifest.core.graphics.weapons,...manifest.core.graphics.objects,...manifest.core.graphics.sparks,...manifest.core.graphics.gostek];
function fixture() {
  const memory=new WebAssembly.Memory({initial:2}),pointer=8,d=new DataView(memory.buffer,pointer,RENDER_LAYOUT.totalBytes);
  const h=RENDER_LAYOUT.header;
  d.setUint32(h.version,RENDER_ABI_VERSION,true);d.setUint32(h.slots,RENDER_LAYOUT.slots,true);
  d.setUint32(h.spriteStride,RENDER_LAYOUT.spriteBytes,true);d.setUint32(h.bulletsOffset,RENDER_LAYOUT.bulletsOffset,true);
  d.setUint32(h.thingsOffset,RENDER_LAYOUT.thingsOffset,true);d.setUint32(h.totalBytes,RENDER_LAYOUT.totalBytes,true);
  d.setUint32(RENDER_LAYOUT.bulletsOffset+4,RENDER_LAYOUT.bulletBytes,true);
  d.setUint32(RENDER_LAYOUT.thingsOffset+4,RENDER_LAYOUT.thingBytes,true);
  const renderer=new CombatRenderer(graphics,skeletons['objects/kit.po']);
  const id=(name: string)=>graphics.find(g=>g.symbol===name)!.index;
  const view=()=> {
    const value=readRenderView(memory,pointer);
    if(typeof value==='number')throw new Error(`Fixture render view ${value}`);
    return value;
  };
  return {d,renderer,id,view};
}

test('native combat math invariants',assertCombatInvariants);

test('all native bullet styles, interpolation, alpha, pivots and borrowed outputs',()=> {
  const {d,renderer,id,view}=fixture(),b=RENDER_LAYOUT.bulletsOffset+8,f={...RENDER_LAYOUT.movingEntity,...RENDER_LAYOUT.bullet};
  d.setUint32(RENDER_LAYOUT.bulletsOffset,1,true);
  for(const [field,value] of [[f.posX,30],[f.posY,40],[f.oldPosX,10],[f.oldPosY,20],[f.velocityX,14],[f.velocityPrevX,10],[f.hitMultiply,5],[f.hitMultiplyPrev,1]] as const)d.setFloat32(b+field,value,true);
  d.setInt32(b+f.timeout,20,true);d.setInt32(b+f.timeoutPrev,22,true);
  d.setUint32(b+f.imageStyle,id('GFX_WEAPONS_AK74_BULLET'),true);d.setUint32(b+f.active,1,true);
  const counts=[0,2,2,2,2,1,0,1,1,1,1,0,2,1,3];
  for(let style=1;style<=14;style++) {
    d.setUint32(b+f.style,style,true);
    const output=renderer.bullets(.5,view());
    assert.equal(output.length,counts[style],`TBullet.Render style ${style}`);
    if(style===1) {
      assert.equal(output[0].x,32);assert.equal(output[0].y,30);
      assert.equal(output[0].scaleX,12/13);assert.equal(output[0].rotation,Math.PI);
      assert.equal(output[0].color[3],141);assert.equal(output[1].color[3],55);
      const first=output[0];assert.equal(renderer.bullets(.5,view()),output);assert.equal(output[0],first);
    }
    if(style===13) {assert.equal(output[0].pivotX,4);assert.equal(output[0].pivotY,1);assert.equal(output[0].mapPivot,true);}
  }
  d.setUint32(b+f.style,1,true);d.setInt32(b+f.timeout,420,true);d.setInt32(b+f.timeoutPrev,420,true);
  assert.equal(renderer.bullets(.5,view()).length,0,'native first-two-ticks suppression');
  d.setInt32(b+f.timeout,20,true);d.setInt32(b+f.timeoutPrev,22,true);
  d.setInt32(b+f.pingAdd,2,true);d.setInt32(b+f.pingAddStart,4,true);
  assert.equal(renderer.bullets(.5,view()).length,2,'native ping tracer replaces primary trail');
  d.setUint32(b+f.presentationFlags,BULLET_PRESENTATION_FLAGS.pingUnavailable,true);
  renderer.bullets(.5,view());assert.ok([...renderer.unavailable].some(message=>message.includes('PingAdd')));
  renderer.paused=true;d.setInt32(b+f.pingAdd,0,true);
  assert.equal(renderer.bullets(0,view())[0].x,44,'paused native interpolation is current state');
});

test('bullet trails extend behind the projectile along -velocity for every direction',()=> {
  const {d,renderer,id,view}=fixture(),b=RENDER_LAYOUT.bulletsOffset+8,f={...RENDER_LAYOUT.movingEntity,...RENDER_LAYOUT.bullet};
  d.setUint32(RENDER_LAYOUT.bulletsOffset,1,true);
  d.setUint32(b+f.style,1,true);d.setUint32(b+f.active,1,true);
  d.setUint32(b+f.imageStyle,id('GFX_WEAPONS_AK74_BULLET'),true);
  d.setInt32(b+f.timeout,20,true);d.setInt32(b+f.timeoutPrev,20,true);
  d.setFloat32(b+f.hitMultiply,1,true);d.setFloat32(b+f.hitMultiplyPrev,1,true);
  for(const [vx,vy] of [[10,0],[-10,0],[8,-6],[8,6],[-8,-6],[-8,6],[0,10],[0,-10]]) {
    for(const [field,value] of [[f.posX,0],[f.posY,0],[f.oldPosX,0],[f.oldPosY,0],[f.velocityX,vx],[f.velocityPrevX,vx],[f.velocityY,vy],[f.velocityPrevY,vy]] as const)d.setFloat32(b+field,value,true);
    const trail=renderer.bullets(1,view())[1]!;
    // Quad local +X (texture width) maps to (cos r, sin r) in world space (GfxMat3Transform).
    const ux=Math.cos(trail.rotation),uy=Math.sin(trail.rotation),len=Math.hypot(vx,vy);
    assert.ok(Math.abs(ux+vx/len)<1e-6&&Math.abs(uy+vy/len)<1e-6,`trail for velocity (${vx},${vy}) points (${ux.toFixed(3)},${uy.toFixed(3)})`);
  }
});

test('every thing style, creation-facing textures, blink, heat and parachute branches',()=> {
  const {d,renderer,id,view}=fixture(),b=RENDER_LAYOUT.thingsOffset+8,f={...RENDER_LAYOUT.movingEntity,...RENDER_LAYOUT.thing};
  d.setUint32(RENDER_LAYOUT.thingsOffset,1,true);d.setUint32(b+f.slot,9,true);d.setUint32(b+f.pointCount,4,true);
  d.setInt32(b+f.timeout,600,true);d.setUint32(b+f.color,0x123456,true);d.setUint32(b+f.presentationFlags,THING_PRESENTATION_FLAGS.colorAvailable,true);
  const points=[0,0,0,-20,20,-20,20,0];
  for(let p=0;p<4;p++)for(let axis=0;axis<2;axis++) {
    d.setFloat32(b+f.skeleton+p*16+axis*4,points[p*2+axis],true);
    d.setFloat32(b+f.skeleton+p*16+8+axis*4,points[p*2+axis],true);
  }
  for(let style=1;style<=27;style++) {
    d.setUint32(b+f.style,style,true);
    const output=renderer.things(.5,view());
    const count=style>=16&&style<=22?0:style===23?5:[6,7,8,12,13,27].includes(style)?2:1;
    assert.equal(output.length,count,`TThing.Render style ${style}`);
    if(style===23) {assert.deepEqual(output[3].color,[0x12,0x34,0x56,255]);assert.equal(output[0].pivotY,.55);}
  }
  d.setUint32(b+f.style,7,true);d.setUint32(b+f.creationFacing,1,true);
  assert.equal(renderer.things(.5,view())[0].asset,graphics.find(g=>g.index===id('GFX_WEAPONS_AK74')+1)!.asset);
  assert.equal(renderer.things(.5,view())[1].asset,graphics.find(g=>g.index===id('GFX_WEAPONS_AK74_CLIP')+1)!.asset);
  d.setInt32(b+f.timeout,2,true);assert.equal(renderer.things(.5,view()).length,0,'dropped gun native blink');
  d.setUint32(b+f.style,1,true);assert.equal(renderer.things(.5,view()).length,0,'flag native blink');
  renderer.targetThing=9;assert.equal(renderer.things(.5,view()).length,1,'target highlight precedes blink exit');
  renderer.targetThing=0;d.setUint32(b+f.style,27,true);d.setInt32(b+f.interest,10,true);
  assert.deepEqual(renderer.things(.5,view())[1].color,[255,155,125,255]);
  d.setUint32(b+f.style,23,true);d.setUint32(b+f.presentationFlags,0,true);
  assert.equal(renderer.things(.5,view()).length,3,'missing original color is explicit, never guessed');
  assert.ok([...renderer.unavailable].some(message=>message.includes('TThing.Color')));
});

test('native cloth corner order, triangulation, flag half-handle, palettes and kit geometry slot',()=> {
  const {d,renderer,view}=fixture(),b=RENDER_LAYOUT.thingsOffset+8,f={...RENDER_LAYOUT.movingEntity,...RENDER_LAYOUT.thing};
  d.setUint32(RENDER_LAYOUT.thingsOffset,1,true);d.setUint32(b+f.pointCount,4,true);d.setInt32(b+f.timeout,600,true);
  const points=[0,0,0,-20,12,-20,12,0];
  for(let p=0;p<4;p++)for(let axis=0;axis<2;axis++) {
    d.setFloat32(b+f.skeleton+p*16+axis*4,points[p*2+axis],true);
    d.setFloat32(b+f.skeleton+p*16+8+axis*4,points[p*2+axis],true);
  }
  const regions: Regions=new Map();
  for(const entry of graphics)if(entry.asset)regions.set(entry.asset.frames[0].object,{key:'stock-atlas',u0:.1,v0:.2,u1:.7,v1:.8});
  d.setUint32(b+f.style,1,true);
  const geometry=renderer.polygons(.5,view(),regions),vertices=geometry.runs[0].vertices,first=vertices[0];
  assert.deepEqual(vertices.map(v=>[v.x,v.y]),[[0,-20],[0,-10],[12,0],[12,0],[12,-20],[0,-20]]);
  assert.deepEqual(vertices.map(v=>[v.u,v.v]),[[.1,.2],[.1,.8],[.7,.8],[.7,.8],[.7,.2],[.1,.2]]);
  assert.deepEqual(vertices[0].color,[0xad,0x15,0x15,255]);assert.deepEqual(vertices[1].color,[0xb5,0x15,0x15,255]);
  assert.equal(renderer.polygons(.5,view(),regions),geometry);assert.equal(geometry.runs[0].vertices[0],first);
  d.setUint32(RENDER_LAYOUT.globalsOffset+RENDER_LAYOUT.globals.gameMode,5,true);
  assert.deepEqual(renderer.polygons(.5,view(),regions).runs[0].vertices[0].color,[0xee,0xee,0xee,255]);
  for(const style of [2,3,16,17,18,19,20,21,22]) {
    d.setUint32(b+f.style,style,true);
    assert.equal(renderer.polygons(.5,view(),regions).runs[0].vertices.length,6,`polygon style ${style}`);
  }
  d.setUint32(b+f.style,7,true);assert.equal(renderer.polygons(.5,view(),regions).runs.length,0,'guns have no polygon texture');
});
