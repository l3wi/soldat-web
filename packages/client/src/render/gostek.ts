import type { ImageAsset, Quad } from "./types";
import { RENDER_LAYOUT, SPRITE_FLAGS } from "@soldat-web/sim-host";
import type { WorldView } from "../world";

export interface GostekPart {
  index: number;
  symbol: string;
  id: string;
  image: number;
  p1: number;
  p2: number;
  cx: number;
  cy: number;
  visible: boolean;
  flip: boolean;
  team: boolean;
  flex: number;
  color: number;
  alpha: number;
  variants: { image: number; path: string }[];
}
interface Graphic {
  index: number;
  symbol: string;
  asset: ImageAsset | null;
}
interface GostekData {
  parts: GostekPart[];
  graphics: Graphic[];
}
interface PartResources {
  part: GostekPart;
  // Index = team-family * 2 + facing-left. Texture choice never implies flipX.
  variants: (ImageAsset | undefined)[];
}
interface InstanceCache {
  pose: { x: number; y: number }[];
  quads: Quad[];
}

/** Native part transforms driven exclusively by interpolated simulation points. */
export class GostekRenderer {
  readonly assets: ImageAsset[] = [];
  readonly parts: readonly GostekPart[];
  private readonly resources: PartResources[];
  private readonly instances: InstanceCache[] = [];
  private readonly output: Quad[] = [];
  private readonly colors: number[][][];
  private readonly head: GostekPart;
  private readonly dreadFirst: number;
  private readonly dreadLast: number;

  constructor(data: GostekData) {
    // Preserve source painter order, including every mutually exclusive weapon,
    // cosmetic and overlay. Mod center overrides have already been imported.
    if (data.parts.length !== 131) throw new Error("Expected all 131 gostek parts");
    this.parts = data.parts;
    const graphics = new Map<number, ImageAsset>();
    const unique = new Map<string, ImageAsset>();
    for (const graphic of data.graphics)
      if (graphic.asset) graphics.set(graphic.index, graphic.asset);
    const foot = data.graphics.find((g) => g.symbol === "GFX_GOSTEK_STOPA");
    const teamFoot = data.graphics.find(
      (g) => g.symbol === "GFX_GOSTEK_TEAM2_STOPA",
    );
    if (!foot || !teamFoot)
      throw new Error("Missing gostek team-family graphics");
    const teamOffset = teamFoot.index - foot.index;
    this.resources = data.parts.map((source) => {
      const part = { ...source };
      const variants: (ImageAsset | undefined)[] = [];
      let w = 0,
        h = 0;
      for (let team = 0; team < 2; team++)
        for (let flip = 0; flip < 2; flip++) {
          if (part.image === 0) {
            variants.push(undefined);
            continue;
          }
          const index =
            part.image +
            (part.team ? team * teamOffset : 0) +
            (part.flip ? flip : 0);
          const original = graphics.get(index);
          if (!original)
            throw new Error(`Missing gostek graphic ${index} for ${part.id}`);
          // Keep exported object paths relative to the content root. The shared
          // renderer owns decoding and the single straight-alpha -> PMA upload.
          const key = `${original.frames.map((f) => f.object).join("|")}:${original.scale}`;
          let asset = unique.get(key);
          if (!asset) {
            asset = original;
            unique.set(key, asset);
            this.assets.push(asset);
          }
          variants.push(asset);
          w = Math.max(w, Math.abs(asset.width / asset.scale));
          h = Math.max(h, Math.abs(asset.height / asset.scale));
        }
      // GostekGraphics.pas:130–173: constrain against the largest variant.
      // These are the native formulas, including their asymmetric +0.5 terms.
      if (w > 0 && w * Math.abs(part.cx + 0.5) > w + 16)
        part.cx = 0.5 + (Math.sign(part.cx + 0.5) * (w + 16)) / w;
      if (h > 0 && h * Math.abs(part.cy + 0.5) > h + 16)
        part.cy = 0.5 + (Math.sign(part.cy + 0.5) * (h + 16)) / h;
      return { part, variants };
    });
    const head = data.parts.find((p) => p.symbol === "GOSTEK_HEAD");
    const first = data.parts.find((p) => p.symbol === "GOSTEK_HAIR_DREADLOCK1");
    const last = data.parts.find((p) => p.symbol === "GOSTEK_HAIR_DREADLOCK5");
    if (!head || !first || !last)
      throw new Error("Missing gostek head/dreadlock definitions");
    this.head = head;
    this.dreadFirst = first.index;
    this.dreadLast = last.index;
    // Byte RGBA, still straight: the shared shader premultiplies color once.
    // Team-family textures AND shirt colors are independent native mechanisms.
    this.colors = [
      [
        [255, 255, 255, 255],
        [210, 55, 45, 255],
        [65, 70, 55, 255],
        [235, 190, 140, 255],
        [92, 65, 35, 255],
        [255, 255, 255, 255],
        [172, 169, 168, 255],
      ],
      [
        [255, 255, 255, 255],
        [55, 90, 210, 255],
        [50, 60, 80, 255],
        [235, 190, 140, 255],
        [92, 65, 35, 255],
        [255, 255, 255, 255],
        [172, 169, 168, 255],
      ],
    ];
  }

  /** Reuses its result array and quads; consume before the next call. */
  quads(fraction: number, world: WorldView): Quad[] {
    const output = this.output;
    output.length = 0;
    for (let slot = 0; slot < world.sprites.length; slot++) {
      const instance = world.sprites[slot]!;
      if (!instance.active) continue;
      let cache = this.instances[slot];
      if (!cache) {
        cache = { pose: Array.from({ length: RENDER_LAYOUT.skeletonPoints + 1 }, () => ({ x: 0, y: 0 })), quads: [] };
        this.instances[slot] = cache;
      }
      const pose = cache.pose;
      for (let p = 1; p <= RENDER_LAYOUT.skeletonPoints; p++) {
        const i = (p - 1) * 2, point = pose[p]!;
        point.x = instance.previous[i]! + (instance.current[i]! - instance.previous[i]!) * fraction;
        point.y = instance.previous[i + 1]! + (instance.current[i + 1]! - instance.previous[i + 1]!) * fraction;
      }
      const direction = instance.direction;
      const team = instance.team === 2 || instance.team === 4 ? 1 : 0;
      const colors = this.colors[team]!;
      const dead = (instance.flags & SPRITE_FLAGS.dead) !== 0;
      const blood = instance.health > 90 ? 0 : Math.max(0, Math.min(255, 200 - Math.round(instance.health)));
      const h1 = pose[this.head.p1],
        h2 = pose[this.head.p2];
      const headRotation = Math.atan2(h2.y - h1.y, h2.x - h1.x) - Math.PI / 2;
      const headCos = Math.cos(headRotation),
        headSin = Math.sin(headRotation);
      let count = 0;
      for (const { part, variants } of this.resources) {
        // Phase-1 exposes movement skeletons, not combat/cosmetic loadout.
        // Use the native base table, never the spike's invented AK74 loadout.
        let visible = part.visible || (part.alpha === 1 && blood > 0);
        if (dead && (part.symbol === "GOSTEK_HEAD" || part.symbol === "GOSTEK_HEAD_DMG")) visible = false;
        if (part.symbol === "GOSTEK_HEAD_DEAD" || part.symbol === "GOSTEK_HEAD_DEAD_DMG") visible = dead;
        if (!visible || part.image === 0) continue;
        const asset = variants[team * 2 + Number(direction !== 1)];
        if (!asset) continue; // Zero-image entries are intentionally absent.
        const p1 = pose[part.p1],
          p2 = pose[part.p2];
        const width = asset.width / asset.scale,
          height = asset.height / asset.scale;
        let x = p1.x,
          y = p1.y;
        let cx = part.cx,
          cy = part.cy;
        let sx = 1,
          sy = 1;
        if (direction !== 1) {
          if (part.flip) cy = 1 - part.cy;
          else sy = -1;
        }
        if (part.index >= this.dreadFirst && part.index <= this.dreadLast) {
          // Native offsets are in already-scaled image/world units, rotated by
          // the head matrix before resetting the dreadlock's own normalized pivot.
          const ox = -cy * height * direction,
            oy = cx * width;
          x += headCos * ox - headSin * oy;
          y += headSin * ox + headCos * oy;
          cx = 0;
          cy = 0.5;
          sx = 0.75 + (0.25 / 5) * (part.index - this.dreadFirst);
        } else if (part.flex > 0) {
          sx = Math.min(1.5, Math.hypot(p2.x - p1.x, p2.y - p1.y) / part.flex);
        }
        let quad = cache.quads[count++];
        if (!quad) {
          quad = {
            asset,
            x: 0,
            y: 0,
            width,
            height,
            scaleX: 1,
            scaleY: 1,
            pivotX: 0,
            pivotY: 0,
            rotation: 0,
            color: [255, 255, 255, 255],
          };
          cache.quads[count - 1] = quad;
        }
        quad.asset = asset;
        quad.x = x;
        quad.y = y + 1;
        quad.width = width;
        quad.height = height;
        quad.scaleX = sx;
        quad.scaleY = sy;
        quad.pivotX = cx;
        quad.pivotY = cy;
        quad.rotation = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const color = colors[part.color];
        quad.color[0] = color[0];
        quad.color[1] = color[1];
        quad.color[2] = color[2];
        quad.color[3] = part.alpha === 1 ? blood : part.alpha === 2 ? 191 : 255;
        output.push(quad);
      }
    }
    return output;
  }
}

export async function loadGostek(base = "/content/"): Promise<GostekRenderer> {
  const root = base.endsWith("/") ? base : `${base}/`;
  const response = await fetch(`${root}gostek.json`);
  if (!response.ok) throw new Error(`Loading gostek.json: HTTP ${response.status}`);
  return new GostekRenderer(await response.json() as GostekData);
}
