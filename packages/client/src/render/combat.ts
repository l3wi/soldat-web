import { BULLET_PRESENTATION_FLAGS, RENDER_LAYOUT, THING_PRESENTATION_FLAGS, type RenderView } from '@soldat-web/sim-host';
import type { Regions } from './geometry';
import type { DrawRun, Geometry, ImageAsset, Quad } from './types';

export interface CombatGraphic { index: number; symbol: string; asset: ImageAsset | null }
interface SkeletonAsset { points: { x: number; z: number }[]; constraints: number[][] }
interface Constraint { a: number; b: number; rest: number }
export interface CombatVisibility {
  /** Native Sprite.Active && Sprite.Visible = 0, not screen/frustum culling. */
  ownerHidden(slot: number): boolean;
  /** Native Map.RayCast(bullet, MySprite.Skeleton.Pos[9], ..., GameWidth, True). */
  bulletOccluded(x: number, y: number): boolean;
}

/** Calc.Angle2Points preserves the native vertical/coincident special cases. */
export function combatAngle(x1: number, y1: number, x2: number, y2: number): number {
  if (x2 !== x1) return Math.atan((y2-y1)/(x2-x1)) + (x1>x2 ? Math.PI : 0);
  return y2>y1 ? Math.PI/2 : y2<y1 ? -Math.PI/2 : 0;
}
export function combatRound(value: number): number {
  const low=Math.floor(value);
  return value-low===.5 ? low+(low%2===0?0:1) : Math.round(value);
}
const lerp=(a: number,b: number,p: number): number=>a+(b-a)*p;
const radians=Math.PI/180;
const triangles=[0,1,2,2,3,0] as const;
const bulletFields={...RENDER_LAYOUT.movingEntity,...RENDER_LAYOUT.bullet};
const thingFields={...RENDER_LAYOUT.movingEntity,...RENDER_LAYOUT.thing};
// Things.CreateThing, not the equipped-gun parts used by RenderGostek.
const weaponSymbols: Record<number, readonly [string,string?]>={
  4:['N_SOCOM'],5:['N_DEAGLES'],6:['MP5','MP5_CLIP'],7:['AK74','AK74_CLIP'],
  8:['STEYR','STEYR_CLIP'],9:['SPAS'],10:['RUGER'],11:['M79'],
  12:['BARRETT','BARRETT_CLIP'],13:['MINIMI','MINIMI_CLIP'],14:['MINIGUN'],
  15:['N_BOW'],24:['KNIFE'],25:['CHAINSAW'],26:['LAW'],
};

/** Parts.LoadPOObject (kit scale from Anims.pas:392), in original constraint order. */
function kitConstraints(skeleton: SkeletonAsset): Constraint[] {
  return skeleton.constraints.map(([a,b])=> {
    const p=skeleton.points[a-1], q=skeleton.points[b-1];
    return { a:(a-1)*2,b:(b-1)*2,rest:Math.hypot((q.x-p.x)*2.15/1.2,(q.z-p.z)*2.15) };
  });
}
function satisfyKit(points: Float64Array, constraints: readonly Constraint[]): void {
  for(const c of constraints) {
    const dx=points[c.b]-points[c.a],dy=points[c.b+1]-points[c.a+1];
    const length=Math.hypot(dx,dy),diff=length===0?0:(length-c.rest)/length;
    const x=dx*.5*diff,y=dy*.5*diff;
    points[c.a]+=x;points[c.a+1]+=y;points[c.b]-=x;points[c.b+1]-=y;
  }
}

/** Direct port of TBullet.Render / TThing.Render / TThing.PolygonsRender.
 * ABI OldPos is Verlet state, NOT a cached last-tick current pose. Only the
 * explicit native VelocityPrev/TimeOutPrev/HitMultiplyPrev are interpolated.
 * All outputs and their elements are borrowed, reused until the next same call.
 */
export class CombatRenderer {
  readonly assets: ImageAsset[]=[];
  timeElapsed=0;
  trails=1;
  targetThing=0;
  paused=false;
  realistic=false;
  visibility?: CombatVisibility;
  /** Concrete unsupported native client state; never substituted with guessed simulation data. */
  readonly unavailable=new Set<string>();
  private readonly graphics: (ImageAsset | undefined)[]=[];
  private readonly ids: Record<string,number>={};
  private readonly plainImages=new Set<number>();
  private readonly droppedImages: number[]=[];
  private readonly droppedClips: number[]=[];
  private readonly bulletCache: Quad[]=[];
  private readonly bulletOutput: Quad[]=[];
  private readonly thingCache: Quad[]=[];
  private readonly thingOutput: Quad[]=[];
  private readonly polygonOutput: Geometry={runs:[]};
  private readonly runCache: DrawRun[]=[];
  private readonly points=new Float64Array(32);
  private readonly constraints: Constraint[];
  private data?: DataView;
  constructor(graphics: readonly CombatGraphic[],kit: SkeletonAsset) {
    this.constraints=kitConstraints(kit);
    for(const entry of graphics) if(entry.asset) {
      this.graphics[entry.index]=entry.asset;this.ids[entry.symbol]=entry.index;
      this.assets.push(entry.asset);
    }
    for(const name of ['DEAGLES','MP5','AK74','STEYR','RUGER','BARRETT','MINIMI','MINIGUN','COLT']) {
      this.plainImages.add(this.id(`GFX_WEAPONS_${name}_BULLET`));
    }
    for(const [style,names] of Object.entries(weaponSymbols)) {
      this.droppedImages[Number(style)]=this.id(`GFX_WEAPONS_${names[0]}`);
      this.droppedClips[Number(style)]=names[1]?this.id(`GFX_WEAPONS_${names[1]}`):0;
    }
  }
  private id(symbol: string): number {
    const id=this.ids[symbol];
    if(id===undefined)throw new Error(`Missing native combat graphic ${symbol}`);
    return id;
  }
  private bind(view: RenderView): DataView {
    if(!this.data||this.data.buffer!==view.bytes.buffer||this.data.byteOffset!==view.bytes.byteOffset||this.data.byteLength!==view.bytes.byteLength) {
      this.data=new DataView(view.bytes.buffer,view.bytes.byteOffset,view.bytes.byteLength);
    }
    if(this.realistic&&!this.visibility)throw new Error('Native realistic combat visibility/raycast data unavailable');
    return this.data;
  }
  private hidden(owner: number): boolean { return this.realistic && owner>0 && owner<=RENDER_LAYOUT.slots && this.visibility!.ownerHidden(owner); }
  private emit(output: Quad[],cache: Quad[],image: number,x: number,y: number,sx=1,sy=1,rotation=0,tint=0xffffff,alpha=255,cx=0,cy=0): void {
    const asset=this.graphics[image];
    if(!asset)throw new Error(`Missing native combat image index ${image}`);
    const n=output.length;
    let q=cache[n];
    if(!q) {
      q={asset,x:0,y:0,width:0,height:0,scaleX:1,scaleY:1,pivotX:0,pivotY:0,rotation:0,color:[255,255,255,255],mapPivot:true};cache[n]=q;
    }
    q.asset=asset;q.width=asset.width/asset.scale;q.height=asset.height/asset.scale;
    q.x=x;q.y=y;q.scaleX=sx;q.scaleY=sy;q.rotation=rotation;q.pivotX=cx;q.pivotY=cy;
    q.color[0]=(tint>>>16)&255;q.color[1]=(tint>>>8)&255;q.color[2]=tint&255;q.color[3]=Math.max(0,Math.min(255,Math.trunc(alpha)));
    output.push(q);
  }
  bullets(fraction: number,view: RenderView): Quad[] {
    const d=this.bind(view),f=bulletFields,p=this.paused?1:fraction,out=this.bulletOutput,cache=this.bulletCache;
    out.length=0;
    const bullet=this.id('GFX_WEAPONS_BULLET');
    for(let i=0;i<view.bulletCount;i++) {
      const base=view.bulletsOffset+RENDER_LAYOUT.sectionHeaderBytes+i*RENDER_LAYOUT.bulletBytes;
      const style=d.getUint32(base+f.style,true),owner=d.getUint32(base+f.owner,true);
      const x=lerp(d.getFloat32(base+f.oldPosX,true),d.getFloat32(base+f.posX,true),p),y=lerp(d.getFloat32(base+f.oldPosY,true),d.getFloat32(base+f.posY,true),p);
      if(this.hidden(owner)&&this.visibility!.bulletOccluded(x,y))continue;
      const vx=lerp(d.getFloat32(base+f.velocityPrevX,true),d.getFloat32(base+f.velocityX,true),p),vy=lerp(d.getFloat32(base+f.velocityPrevY,true),d.getFloat32(base+f.velocityY,true),p);
      const timeout=lerp(d.getInt32(base+f.timeoutPrev,true),d.getInt32(base+f.timeout,true),p);
      const speed=Math.hypot(vx,vy),rotation=-combatAngle(x+vx,y+vy,x,y),trails=this.trails===1;
      switch(style) {
        case 1: {
          if(timeout>=418)break;
          let image=d.getUint32(base+f.imageStyle,true);
          if(!this.plainImages.has(image))image=this.id('GFX_WEAPONS_COLT_BULLET');
          const scale=speed/13,hit=lerp(d.getFloat32(base+f.hitMultiplyPrev,true),d.getFloat32(base+f.hitMultiply,true),p);
          let alpha=Math.max(50,Math.min(230,hit*scale*scale/4.63*255));
          const ping=d.getInt32(base+f.pingAdd,true);
          if((d.getUint32(base+f.presentationFlags,true)&BULLET_PRESENTATION_FLAGS.pingUnavailable)!==0)this.unavailable.add('TBullet.PingAdd/PingAddStart: client-only network tracer state unavailable in SERVER');
          if(ping<1)this.emit(out,cache,image,x+vx,y+vy,scale,1,rotation,0xffffff,combatRound(alpha));
          if(ping>0) {
            const distance=Math.hypot(x-d.getFloat32(base+f.initialX,true),y-d.getFloat32(base+f.initialY,true));
            const length=distance*Math.min(1/21,((ping+2)/d.getInt32(base+f.pingAddStart,true))/13);
            alpha/=d.getUint32(base+f.active,true)!==0?6:4;
            this.emit(out,cache,image,x+vx,y+vy,length,1,rotation,0xffffff,combatRound(alpha));
          }
          if(trails&&timeout<413) {
            const hitBody=d.getUint32(base+f.hitBody,true)>0;
            this.emit(out,cache,image,x,y,speed/(hitBody?4:3.5),1,rotation,hitBody?0xffdddd:0xffffff,55);
          }
          break;
        }
        case 2:
          if(trails&&timeout<177)this.emit(out,cache,bullet,x+(vy>0?-1:1),y-3+(vx>0?1:-1),speed/3,1,rotation,0x64ff64,combatRound(110*.75));
          this.emit(out,cache,this.id('GFX_WEAPONS_FRAG_GRENADE'),x-1,y-4);break;
        case 3:
          if(timeout>=418)break;
          this.emit(out,cache,this.id('GFX_WEAPONS_SPAS_BULLET'),x+vx,y+vy,1,1,rotation,0xffffff,150);
          if(trails&&timeout<417)this.emit(out,cache,bullet,x,y,speed/9,1,rotation,0xffffff,22);break;
        case 4:
          if(timeout>=418)break;
          this.emit(out,cache,this.id('GFX_WEAPONS_M79_BULLET'),x,y+1,1,1,timeout*6*radians,0xffffff,252);
          if(trails&&timeout<416)this.emit(out,cache,bullet,x+(vy>0?-1:1),y+(vx>0?1:-1),speed/4,1.3,rotation,0xffff55,110);break;
        case 5:
          if(timeout>0&&timeout<=32)this.emit(out,cache,this.id('GFX_SPARKS_FLAMES_EXPLODE16')-Math.trunc(timeout/2),x-8,y-17);break;
        case 6: case 11: break; // Punch and melee knife deliberately have no native render branch.
        case 7: case 8:
          if(timeout>=418)break;
          this.emit(out,cache,this.id('GFX_WEAPONS_ARROW'),x+vx,y+vy,1,1,rotation);
          if(style===7&&trails&&timeout>280)this.emit(out,cache,bullet,x,y,speed/3,1,rotation,0xffffff,15);break;
        case 9:this.emit(out,cache,this.id('GFX_WEAPONS_CLUSTER_GRENADE'),x,y-3,1,1,timeout*5*radians*(vx<0?-1:1));break;
        case 10:this.emit(out,cache,this.id('GFX_WEAPONS_CLUSTER'),x,y-2);break;
        case 12:
          if(timeout>=418)break;
          this.emit(out,cache,this.id('GFX_WEAPONS_MISSILE'),x+vx,y+vy,1,1,rotation);
          if(trails&&timeout<413)this.emit(out,cache,bullet,x,y,speed/3,1,rotation,0xffffff,22);break;
        case 13:this.emit(out,cache,this.id(vx>=0?'GFX_WEAPONS_KNIFE':'GFX_WEAPONS_KNIFE2'),x+vx,y+vy,1,1,(vx>=0?1:-1)*timeout/Math.PI,0xffffff,255,4,1);break;
        case 14:
          if(timeout>=58)break;
          this.emit(out,cache,bullet,x+vx,y+vy,speed/13,1.2,rotation,0xffbf77,220);
          if(trails&&timeout<47) {
            this.emit(out,cache,bullet,x,y,speed/3,1,rotation,0xffffff,22);
            const sinus=Math.sin(timeout+5.1*this.timeElapsed);
            this.emit(out,cache,this.id('GFX_WEAPONS_SMUDGE'),x,y,speed/(sinus+2.5),sinus,rotation,0xffffff,18);
          }
          break;
      }
    }
    return out;
  }
  private interpolateThing(d: DataView,base: number,p: number,style: number): void {
    const field=RENDER_LAYOUT.thing,count=Math.min(16,d.getUint32(base+field.pointCount,true));
    for(let j=0;j<count;j++) {
      const s=base+field.skeleton+j*16;
      this.points[j*2]=lerp(d.getFloat32(s+8,true),d.getFloat32(s,true),p);
      this.points[j*2+1]=lerp(d.getFloat32(s+12,true),d.getFloat32(s+4,true),p);
    }
    if(style>=16&&style<=22)satisfyKit(this.points,this.constraints);
  }
  private blink(d: DataView,base: number): boolean {
    const time=d.getInt32(base+RENDER_LAYOUT.thing.timeout,true);
    return time<300&&time%6<3;
  }
  things(fraction: number,view: RenderView): Quad[] {
    const d=this.bind(view),f=thingFields,p=this.paused?1:fraction,out=this.thingOutput,cache=this.thingCache,v=this.points;
    out.length=0;
    for(let i=0;i<view.thingCount;i++) {
      const base=view.thingsOffset+RENDER_LAYOUT.sectionHeaderBytes+i*RENDER_LAYOUT.thingBytes,style=d.getUint32(base+f.style,true);
      if(this.hidden(d.getUint32(base+f.owner,true)))continue;
      this.interpolateThing(d,base,p,style);
      const slot=d.getUint32(base+f.slot,true),alpha=combatRound(Math.abs(5+20*Math.sin(5.1*this.timeElapsed)));
      if(this.targetThing===slot)this.emit(out,cache,this.id('GFX_OBJECTS_ILUM'),(v[0]+v[2])/2-12.5,(v[1]+v[3])/2-12.5,1,1,0,0xffffff,alpha);
      if(style>=1&&style<=3) {
        if(this.hidden(d.getUint32(base+f.holdingSprite,true))||this.blink(d,base))continue;
        this.emit(out,cache,this.id('GFX_OBJECTS_FLAG_HANDLE'),v[0],v[1],1,1,-combatAngle(v[0],v[1],v[2],v[3]));
        if((d.getUint32(base+f.flags,true)&2)!==0)this.emit(out,cache,this.id('GFX_OBJECTS_ILUM'),(v[0]+v[2])/2-12.5,(v[1]+v[3])/2-12.5,1,1,0,0xffffff,alpha);
      } else if((style>=4&&style<=15)||(style>=24&&style<=26)) {
        if(this.blink(d,base))continue;
        const variant=d.getUint32(base+f.creationFacing,true);
        const image=this.droppedImages[style]+variant,clip=this.droppedClips[style]>0?this.droppedClips[style]+variant:0,angle=-combatAngle(v[0],v[1],v[2],v[3]);
        if(image===0)continue;
        this.emit(out,cache,image,v[0],v[1]-3,1,1,angle,0xffffff,255,0,2);
        if(clip>0)this.emit(out,cache,clip,v[0],v[1]-3,1,1,angle,0xffffff,255,0,2);
      } else if(style===23) {
        const rope=this.id('GFX_GOSTEK_PARA_ROPE'),chute=this.id('GFX_GOSTEK_PARA');
        this.emit(out,cache,rope,v[6],v[7]-.55,1,1,-combatAngle(v[6],v[7],v[2],v[3]),0xffffff,255,0,.55);
        this.emit(out,cache,rope,v[6],v[7]-.55,1,1,-combatAngle(v[6],v[7],v[4],v[5])+5*radians,0xffffff,255,0,.55);
        this.emit(out,cache,rope,v[6],v[7]-.55,1,1,-combatAngle(v[6],v[7],v[0],v[1]),0xffffff,255,0,.55);
        const scale=Math.hypot(v[2]-v[4],v[3]-v[5])/45.83;
        if(scale>2)continue;
        if((d.getUint32(base+f.presentationFlags,true)&THING_PRESENTATION_FLAGS.colorAvailable)===0) {
          this.unavailable.add('TThing.Color: parachute shirt color unavailable without its original owner');
          continue;
        }
        const tint=d.getUint32(base+f.color,true);
        this.emit(out,cache,chute+1,v[4],v[5],scale,scale,-combatAngle(v[4],v[5],v[0],v[1]),tint);
        this.emit(out,cache,chute,v[0],v[1],scale,scale,-combatAngle(v[0],v[1],v[2],v[3]),tint);
      } else if(style===27) {
        this.emit(out,cache,this.id('GFX_WEAPONS_M2_STAT'),v[4],v[5]-20,1,1,-combatAngle(v[4],v[5],v[2],v[3]));
        const interest=d.getInt32(base+f.interest,true),tint=(255<<16)|(((255-10*interest)&255)<<8)|((255-13*interest)&255);
        this.emit(out,cache,this.id(v[6]>=v[0]?'GFX_WEAPONS_M2_2':'GFX_WEAPONS_M2'),v[0],v[1]-13,1,1,combatAngle(v[6],v[7],v[0],v[1]),tint,255,5,4);
      }
    }
    return out;
  }
  /** Native painter slot: AFTER scenery L1, BEFORE foreground map polygons. Kits also use this slot. */
  polygons(fraction: number,view: RenderView,regions: Regions): Geometry {
    const d=this.bind(view),f=thingFields,p=this.paused?1:fraction,out=this.polygonOutput,v=this.points;
    out.runs.length=0;
    for(let i=0;i<view.thingCount;i++) {
      const base=view.thingsOffset+RENDER_LAYOUT.sectionHeaderBytes+i*RENDER_LAYOUT.thingBytes,style=d.getUint32(base+f.style,true);
      let image=0;
      if(style>=1&&style<=3)image=this.id(view.globals.gameMode===5?'GFX_OBJECTS_INFFLAG':'GFX_OBJECTS_FLAG');
      else if(style>=16&&style<=22)image=this.id('GFX_OBJECTS_MEDIKIT')+style-16;
      if(image===0)continue;
      if(style>=1&&style<=3&&(this.blink(d,base)||this.hidden(d.getUint32(base+f.holdingSprite,true))))continue;
      this.interpolateThing(d,base,p,style);
      const asset=this.graphics[image];
      if(!asset)throw new Error(`Missing native thing texture ${image}`);
      const region=regions.get(asset.frames[0].object);
      if(!region)throw new Error(`Missing atlas region for native thing texture ${image}`);
      let baseColor=0,top=0,low=0;
      if(style===1) {baseColor=view.globals.gameMode===5?0xeeeeee:0xad1515;low=view.globals.gameMode===5?0xddeeee:0x951515;top=view.globals.gameMode===5?0xffeeee:0xb51515;}
      else if(style===2) {baseColor=view.globals.gameMode===5?0x333333:0x0510ad;low=view.globals.gameMode===5?0x333322:0x051095;top=view.globals.gameMode===5?0x333344:0x0510b5;}
      else if(style===3) {baseColor=0xadad15;low=0x959515;top=0xb5b515;}
      else if(style>=16&&style<=22)baseColor=top=low=0xffffff;
      if(style>=1&&style<=3) {v[0]=(v[0]+v[2])/2;v[1]=(v[1]+v[3])/2;}
      const n=out.runs.length;
      let run=this.runCache[n];
      if(!run) {
        run={key:'',repeat:false,vertices:Array.from({length:6},()=>({x:0,y:0,u:0,v:0,color:[0,0,0,255]}))};this.runCache[n]=run;
      }
      run.key=region.key;
      for(let j=0;j<6;j++) {
        const corner=triangles[j],point=corner===0?2:corner===1?0:corner===2?6:4;
        const vertex=run.vertices[j],tint=corner===1?top:corner===3?low:baseColor;
        vertex.x=v[point];vertex.y=v[point+1];
        vertex.u=corner<2?region.u0:region.u1;vertex.v=corner===0||corner===3?region.v0:region.v1;
        vertex.color[0]=(tint>>>16)&255;vertex.color[1]=(tint>>>8)&255;vertex.color[2]=tint&255;
        vertex.color[3]=(style>=1&&style<=3)||(style>=16&&style<=22)?255:0;
      }
      out.runs.push(run);
    }
    return out;
  }
}

export async function loadCombat(): Promise<CombatRenderer> {
  const responses=await Promise.all([fetch('/content/manifest.json'),fetch('/content/skeletons.json')]);
  for(const response of responses)if(!response.ok)throw new Error(`Combat content HTTP ${response.status}`);
  const [manifest,skeletons]=await Promise.all(responses.map(response=>response.json()));
  return new CombatRenderer([...manifest.core.graphics.weapons,...manifest.core.graphics.objects,...manifest.core.graphics.sparks,...manifest.core.graphics.gostek],skeletons['objects/kit.po']);
}

/** Invoked by the integration verifier; no browser, WebGL or generated art required. */
export function assertCombatInvariants(): void {
  const assert=(value: boolean,label: string): void=>{if(!value)throw new Error(`Combat invariant: ${label}`);};
  assert(combatRound(82.5)===82&&combatRound(83.5)===84,'Pascal nearest-even alpha');
  assert(combatAngle(0,0,0,0)===0&&combatAngle(0,0,0,-1)===-Math.PI/2,'native angle degeneracies');
  assert(combatAngle(12,0,0,0)===Math.PI,'native right-moving bullet orientation');
  assert(triangles.join(',')==='0,1,2,2,3,0','GfxDrawQuad triangle winding');
  // Interpolate actual Verlet old/current endpoints; never overwrite them with last-tick caches.
  assert(lerp(2,10,.25)===4,'Verlet interpolation');
  const points=new Float64Array([0,0,10,0,10,10,0,10]);
  satisfyKit(points,[{a:0,b:2,rest:8}]);
  assert(points[0]===1&&points[2]===9,'ordered equal-mass kit constraint');
}
