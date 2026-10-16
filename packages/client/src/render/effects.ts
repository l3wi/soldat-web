import type { ImageAsset, Quad } from './types';
import { FX_LAYOUT, requireStatus, type SimHost } from '@soldat-web/sim-host';

export interface SparkView {
  style: number; owner: number; life: number; lifePrev: number;
  x: number; y: number; previousX: number; previousY: number; tint: number;
}
export interface SparkCollection { count: number; spark(index: number): SparkView }

/** Reuses one decoded record; shared ABI constants are the only byte offsets. */
export class SimEffectsView implements SparkCollection {
  count = 0;
  private data?: DataView;
  private pointer = 0;
  private readonly value: SparkView = { style: 0, owner: 0, life: 0, lifePrev: 0, x: 0, y: 0, previousX: 0, previousY: 0, tint: 0 };
  constructor(private readonly host: SimHost) {}
  sync(): void {
    const pointer = requireStatus(this.host.exports.fx_render_view(), 'fx_render_view');
    if (!pointer) throw new Error('FX render view unavailable');
    if (pointer !== this.pointer || this.data?.buffer !== this.host.exports.memory.buffer) {
      const view = this.host.fxRenderView();
      if (typeof view === 'number') throw new Error(`FX render view unavailable: ${view}`);
      this.pointer = pointer;
      this.data = new DataView(this.host.exports.memory.buffer, pointer, FX_LAYOUT.totalBytes);
    }
    this.count = this.data.getUint32(FX_LAYOUT.header.count, true);
  }
  spark(index: number): SparkView {
    const data = this.data!, base = FX_LAYOUT.headerBytes + index * FX_LAYOUT.sparkBytes, field = FX_LAYOUT.spark, value = this.value;
    value.style = data.getUint32(base + field.style, true); value.owner = data.getUint32(base + field.owner, true);
    value.life = data.getUint32(base + field.life, true); value.lifePrev = data.getUint32(base + field.lifePrev, true);
    value.x = data.getFloat32(base + field.posX, true); value.y = data.getFloat32(base + field.posY, true);
    value.previousX = data.getFloat32(base + field.oldPosX, true); value.previousY = data.getFloat32(base + field.oldPosY, true);
    value.tint = data.getUint32(base + field.tint, true);
    return value;
  }
}
interface Graphic { index: number; symbol: string; asset: ImageAsset | null }
const STATIC_IMAGE: Record<number, string> = {
  1:'SMOKE',2:'LILFIRE',3:'ODPRYSK',4:'LILBLOOD',5:'BLOOD',25:'SPAWNSPARK',26:'ODPRYSK',27:'ODPRYSK',
  24:'BIGSMOKE',29:'BIGSMOKE',30:'PIN',31:'LILSMOKE',32:'STUFF',34:'CYGARO',35:'LILSMOKE',36:'PLOMYK',37:'BLACKSMOKE',
  38:'RAIN',39:'SAND',40:'ODLAMEK1',41:'ODLAMEK2',42:'ODLAMEK3',43:'ODLAMEK4',44:'ODLAMEK1',45:'ODLAMEK2',46:'ODLAMEK3',47:'ODLAMEK4',
  48:'SKRAWEK',49:'SKRAWEK',50:'PUFF',53:'SNOW',55:'SPLAT',56:'MINISMOKE',57:'ODPRYSK',58:'ODPRYSK',59:'SMOKE',60:'BIGSMOKE',61:'SPAWNSPARK',62:'JETFIRE',64:'PLOMYK',
};
const WEAPON_IMAGE: Record<number, string> = {
  7:'SHELL',8:'SHELL',9:'AK74_CLIP',10:'MINIMI_CLIP',11:'MP5_CLIP',16:'SHELL',18:'DEAGLES_CLIP',19:'STEYR_CLIP',20:'BARRETT_CLIP',
  21:'SHELL',22:'SHELL',23:'SOCOM_CLIP',33:'SHELL',51:'SPAS_SHELL',52:'M79_SHELL',65:'COLT_SHELL',66:'DEAGLES_SHELL',67:'MP5_SHELL',68:'AK74_SHELL',69:'STEYR_SHELL',70:'RUGER_SHELL',71:'BARRETT_SHELL',72:'MINIMI_SHELL',73:'MINIGUN_SHELL',
};
function roundEven(value: number): number { const low = Math.floor(value); return value - low === 0.5 ? low + (low % 2 === 0 ? 0 : 1) : Math.round(value); }

/** TSpark.Render painter order and lifetime formulas; no additive blending. */
export class EffectsRenderer {
  readonly assets: ImageAsset[] = [];
  private readonly graphics: Record<string, ImageAsset> = {};
  private readonly indices: Record<number, ImageAsset> = {};
  private readonly ids: Record<string, number> = {};
  private readonly images: (ImageAsset | undefined)[] = new Array(74);
  private readonly cache: Quad[] = [];
  private readonly output: Quad[] = [];
  constructor(graphics: Graphic[]) {
    for (const entry of graphics) if (entry.asset) { this.graphics[entry.symbol] = entry.asset; this.indices[entry.index] = entry.asset; this.ids[entry.symbol] = entry.index; this.assets.push(entry.asset); }
    for (const [style, symbol] of Object.entries(STATIC_IMAGE)) this.images[Number(style)] = this.graphics[`GFX_SPARKS_${symbol}`];
    for (const [style, symbol] of Object.entries(WEAPON_IMAGE)) this.images[Number(style)] = this.graphics[`GFX_WEAPONS_${symbol}`];
  }
  private emit(asset: ImageAsset | undefined, x: number, y: number, sx: number, sy: number, rotation: number, tint: number, alpha: number): void {
    if (!asset) throw new Error('Missing native spark graphic');
    const index = this.output.length;
    let quad = this.cache[index];
    if (!quad) { quad = { asset, x, y, width: asset.width/asset.scale, height: asset.height/asset.scale, scaleX: 1, scaleY: 1, pivotX: 0, pivotY: 0, rotation: 0, color: [255,255,255,255] }; this.cache[index] = quad; }
    if (quad.asset !== asset) { quad.asset=asset; quad.width=asset.width/asset.scale; quad.height=asset.height/asset.scale; }
    quad.x=x; quad.y=y;
    // `rotation` is the native GfxDrawSprite `r` argument; GfxDrawSprite passes -r to GfxSpriteVertices (Gfx.pas:1508).
    quad.scaleX=sx; quad.scaleY=sy; quad.rotation=-rotation;
    quad.color[0]=(tint>>>16)&255; quad.color[1]=(tint>>>8)&255; quad.color[2]=tint&255; quad.color[3]=Math.max(0,Math.min(255,Math.trunc(alpha)));
    this.output.push(quad);
  }
  quads(fraction: number, view: SparkCollection): Quad[] {
    this.output.length = 0;
    const rad = Math.PI/180;
    for (let index=0;index<view.count;index++) {
      const spark=view.spark(index), style=spark.style;
      const l=spark.lifePrev+(spark.life-spark.lifePrev)*fraction;
      let x=spark.previousX+(spark.x-spark.previousX)*fraction, y=spark.previousY+(spark.y-spark.previousY)*fraction;
      let sx=1, sy=1, rotation=0, tint=0xffffff, alpha=255;
      let asset=this.images[style];
      if (style===6 || style===63) continue; // Native headcap is absent on default players; 63 has no render branch.
      switch(style) {
        case 1: case 31: case 32: alpha=l+10; break;
        case 2: alpha=l; break;
        case 3: alpha=l*3+10; break;
        case 4: sx=sy=.75; rotation=l*10*rad; alpha=l*2+65; break;
        case 5: sx=sy=l>10?.33+10/l:1; rotation=l*2*rad; alpha=l*2+85; break;
        case 7: case 30: case 34: case 65: case 66: case 67: case 68: case 69: case 70: case 72: case 73: rotation=l*4*rad; break;
        case 8: sx=1.1;sy=1.2;rotation=l*3.5*rad;tint=0xff3333;break;
        case 9: case 10: case 11: case 18: case 19: case 20: case 23: x+=8;rotation=Math.PI;break;
        case 12: case 13: case 14: case 15: case 17: case 28: {
          const large=style===12||style===17;
          const frame=this.ids.GFX_SPARKS_EXPLOSION_EXPLODE16!-roundEven(l/(large?4:3));
          sx=sy=style===12?.75:style===13?.3:style===14?2:style===15?3:style===28?.5:1;
          x-=style===12?19:style===13?8:style===14?50:style===15?75:style===28?15:25;
          y-=style===12?38:style===13?17:style===14?100:style===15?150:style===28?37:50;
          if (style!==13&&style!==28&&frame-1>=this.ids.GFX_SPARKS_EXPLOSION_EXPLODE1!) this.emit(this.indices[frame-1],x,y,sx,sy,0,style===17?0xaaaaaa:0xadadad,100);
          asset=this.indices[frame];alpha=large?175+l:255-2*l;break;
        }
        case 16:sx=1;sy=2;rotation=l*3.5*rad;tint=0x8877ff;break;
        case 21:sx=1.1;rotation=l*3.77*rad;break;
        case 22:sx=1.3;rotation=l*3.5*rad;break;
        case 24:sx=.6+(75/l)/126;sy=.6+(75/l)/120;x-=22*sx;y+=-64+l/2;alpha=3*l;break;
        case 25:x-=20;y-=20;rotation=l*rad;tint=spark.tint;alpha=Math.min(6*l,255);break;
        case 26:tint=0xfffe35;alpha=Math.min(l*3+154,255);break;
        case 27:tint=0xaaaaaa;alpha=Math.min(l*3+154,255);break;
        case 29:sx=.5*(.6+(75/l)/96);sy=.5*(.6+(75/l)/90);x-=22*sx;y+=-48+l/1.5;alpha=2.5*l;break;
        case 33:rotation=l*4*rad;tint=0xbbaaa9;break;
        case 35:alpha=l*13;break;
        case 36:case 64:sx=sy=l/35;y-=1/sy;alpha=l*2+185;break;
        case 37:sx=sy=l/75;y-=1/sy;alpha=l*3;break;
        case 38:case 39:case 53:alpha=105;break;
        case 40:case 41:case 42:case 43:rotation=l*8*rad;alpha=Math.trunc(l+10);break;
        case 44:case 45:case 46:case 47:sx=sy=.7;alpha=Math.trunc(l*2)+15;break;
        case 48:case 49:rotation=l*5*rad;tint=spark.tint;alpha=Math.trunc(l*2)+15;break;
        case 50:alpha=Math.trunc(l)+5;break;
        case 51:case 52:rotation=l*3.77*rad;break;
        case 54:{
          if(l>40)continue;x-=26;y-=48;const frame=this.ids.GFX_SPARKS_MINISMOKE!-roundEven(l/4);
          if(frame-1>=this.ids.GFX_SPARKS_EXPLOSION_SMOKE1!)this.emit(this.indices[frame-1],x,y,1,1,0,0xcccccc,2*l+10);
          asset=this.indices[frame];tint=0xdddddd;alpha=3*l+10;break;
        }
        case 55:sx=sy=l>20?.63+10/l:1;rotation=l*rad;alpha=Math.min(l*2+55,255);break;
        case 56:x-=3;y-=3;alpha=2.5*l;break;
        case 57:tint=0xffff00;alpha=l*2+10;break;
        case 58:tint=0xffff00;alpha=l*3+10;break;
        case 59:y-=50-l;sx=sy=1.5+(620/l)/50;alpha=l*2;break;
        case 60:{
          sx=sy=.5+16/(l+50);x-=14*sx;y-=30;
          this.emit(asset,x,y,sx,sy,0,0xffffff,l/3.3);
          asset=this.graphics.GFX_SPARKS_BIGSMOKE2;tint=l>30?0x666666:0xbfbfbf;alpha=l>30?(255-l)/9:l;break;
        }
        case 61:x-=10;y-=10;sx=sy=.5;rotation=l*rad;tint=spark.tint;alpha=14*l;break;
        case 62:rotation=l*rad;tint=spark.tint;alpha=l*5;break;
        case 71:rotation=l*3.5*rad;break;
      }
      this.emit(asset,x,y,sx,sy,rotation,tint,alpha);
    }
    return this.output;
  }
}
export async function loadEffects(): Promise<EffectsRenderer> {
  const response=await fetch('/content/manifest.json');if(!response.ok)throw new Error(`Effect manifest HTTP ${response.status}`);
  const manifest=await response.json();
  return new EffectsRenderer([...manifest.core.graphics.sparks,...manifest.core.graphics.weapons]);
}
