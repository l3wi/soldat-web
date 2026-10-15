import type { ImageAsset, Quad } from "./types";
import { facing, PoseLibrary, PoseSampler } from "./pose";
import type { AnimationsData, SkeletonsData } from "./pose";

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
export interface GostekInstance {
  x: number;
  y: number;
  state: string;
  team: number;
  direction?: number;
  /** World/screen-space radians: zero right, pi left, positive downward. */
  aim?: number;
}
interface PartResources {
  part: GostekPart;
  // Index = team-family * 2 + facing-left. Texture choice never implies flipX.
  variants: (ImageAsset | undefined)[];
}
interface InstanceCache {
  sampler: PoseSampler;
  quads: Quad[];
}

/** Full exported part-table renderer; the spike selects one documented loadout. */
export class GostekRenderer {
  readonly assets: ImageAsset[] = [];
  readonly parts: readonly GostekPart[];
  private readonly resources: PartResources[];
  private readonly instances: InstanceCache[] = [];
  private readonly output: Quad[] = [];
  private readonly visibility: Record<string, Uint8Array> = {};
  private readonly colors: number[][][];
  private readonly head: GostekPart;
  private readonly dreadFirst: number;
  private readonly dreadLast: number;

  constructor(
    data: GostekData,
    private readonly poses: PoseLibrary,
  ) {
    // Preserve source painter order, including every mutually exclusive weapon,
    // cosmetic and overlay. Mod center overrides have already been imported.
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
  quads(timeSeconds: number, instances: GostekInstance[]): Quad[] {
    const output = this.output;
    output.length = 0;
    for (let slot = 0; slot < instances.length; slot++) {
      const instance = instances[slot];
      let cache = this.instances[slot];
      if (!cache) {
        cache = { sampler: new PoseSampler(this.poses), quads: [] };
        this.instances[slot] = cache;
      }
      const direction = facing(instance.state, instance.direction);
      const aim = instance.aim ?? (direction === 1 ? 0 : Math.PI);
      const pose = cache.sampler.sample(
        timeSeconds,
        instance.state,
        direction,
        aim,
      );
      const team = instance.team === 2 || instance.team === 4 ? 1 : 0;
      const colors = this.colors[team];
      const dead = instance.state === "dead";
      let visible = this.visibility[instance.state];
      if (!visible) {
        visible = new Uint8Array(this.parts.length);
        for (const part of this.parts) {
          const symbol = part.symbol;
          let show = part.visible;
          // Fixed demonstration loadout: AK74, two frag grenades, silver chain,
          // dreadlocks and cigar; no helmet so the native hair branch is visible.
          if (
            symbol === "GOSTEK_PRIMARY_AK74" ||
            symbol === "GOSTEK_PRIMARY_AK74_CLIP"
          )
            show = !dead;
          if (
            symbol === "GOSTEK_FRAG_GRENADE1" ||
            symbol === "GOSTEK_FRAG_GRENADE2" ||
            symbol.startsWith("GOSTEK_SILVER_") ||
            symbol.startsWith("GOSTEK_HAIR_DREADLOCK") ||
            symbol === "GOSTEK_CIGAR"
          )
            show = true;
          if (instance.state === "jet") {
            if (symbol === "GOSTEK_LEFT_FOOT" || symbol === "GOSTEK_RIGHT_FOOT")
              show = false;
            if (
              symbol === "GOSTEK_LEFT_JETFOOT" ||
              symbol === "GOSTEK_RIGHT_JETFOOT"
            )
              show = true;
          }
          if (dead) {
            if (part.alpha === 1) show = true;
            if (symbol === "GOSTEK_HEAD" || symbol === "GOSTEK_HEAD_DMG")
              show = false;
            if (
              symbol === "GOSTEK_HEAD_DEAD" ||
              symbol === "GOSTEK_HEAD_DEAD_DMG"
            )
              show = true;
          }
          visible[part.index] = Number(show);
        }
        this.visibility[instance.state] = visible;
      }
      const h1 = pose[this.head.p1],
        h2 = pose[this.head.p2];
      const headRotation = Math.atan2(h2.y - h1.y, h2.x - h1.x) - Math.PI / 2;
      const headCos = Math.cos(headRotation),
        headSin = Math.sin(headRotation);
      let count = 0;
      for (const { part, variants } of this.resources) {
        if (!visible[part.index] || part.image === 0) continue;
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
        quad.x = instance.x + x;
        quad.y = instance.y + y + 1;
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
        // Full health except the corpse fixture: blood=200-Round(0), nades=Trunc(.75*255).
        quad.color[3] =
          part.alpha === 1 ? (dead ? 200 : 0) : part.alpha === 2 ? 191 : 255;
        output.push(quad);
      }
    }
    return output;
  }
}

export async function loadGostek(base = "/content/"): Promise<GostekRenderer> {
  const root = base.endsWith("/") ? base : `${base}/`;
  const [gostek, animations, skeletons] = await Promise.all(
    ["gostek.json", "animations.json", "skeletons.json"].map(async (file) => {
      const response = await fetch(`${root}${file}`);
      if (!response.ok)
        throw new Error(`Loading ${file}: HTTP ${response.status}`);
      return response.json();
    }),
  );
  return new GostekRenderer(
    gostek as GostekData,
    new PoseLibrary(animations as AnimationsData, skeletons as SkeletonsData),
  );
}
