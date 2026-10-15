import type {
  Geometry,
  ImageAsset,
  MapData,
  Point,
  Polygon,
  Prop,
  Quad,
} from "./types";
import type { Regions } from "./geometry";
import { appendRun, quadGeometry, quadVertices } from "./geometry";
const excluded = new Set([1, 2, 3, 11, 24, 25]);
const background = (p: Polygon) => p.polytype === 24 || p.polytype === 25;
// Pascal Round uses ties-to-even, unlike JS Math.round (including negative ties).
function roundEven(x: number) {
  const n = Math.floor(x),
    f = x - n;
  return f === 0.5 ? (n % 2 === 0 ? n : n + 1) : Math.round(x);
}
function inside(p: Point, poly: Polygon) {
  const [a, b, c] = poly.vertices;
  const x = p.x - a!.x,
    y = p.y - a!.y;
  const ab = (b!.x - a!.x) * y - (b!.y - a!.y) * x > 0,
    ac = (c!.x - a!.x) * y - (c!.y - a!.y) * x > 0;
  return (
    ac !== ab &&
    (c!.x - b!.x) * (p.y - b!.y) - (c!.y - b!.y) * (p.x - b!.x) > 0 === ab
  );
}
export interface Sectors {
  division: number;
  radius: number;
  cells: number[][];
}
export async function loadSectors(
  name: string,
  polygonCount: number,
): Promise<Sectors> {
  const response = await fetch(
    `/content/sim/maps/${encodeURIComponent(name)}.pms`,
  );
  if (!response.ok) throw Error(`PMS ${name}: ${response.status}`);
  const view = new DataView(await response.arrayBuffer());
  let p = 92 + 121 * polygonCount;
  const division = view.getInt32(p, true),
    radius = view.getInt32(p + 4, true);
  p += 8;
  const cells = [];
  for (let i = 0; i < (2 * radius + 1) ** 2; i++) {
    const n = view.getUint16(p, true);
    p += 2;
    const cell = [];
    for (let j = 0; j < n; j++) {
      cell.push(view.getUint16(p, true));
      p += 2;
    }
    cells.push(cell);
  }
  return { division, radius, cells };
}
function collides(p: Point, except: number, map: MapData, sectors: Sectors) {
  const { division, radius, cells } = sectors,
    x = roundEven(p.x / division),
    y = roundEven(p.y / division);
  if (x <= -radius || x >= radius || y <= -radius || y >= radius) return false;
  return cells[(x + radius) * (2 * radius + 1) + y + radius]!.some(
    (id) =>
      id !== except &&
      !excluded.has(map.polygons[id - 1]!.polytype) &&
      inside(p, map.polygons[id - 1]!),
  );
}
export interface MapGeometry {
  background: Geometry;
  edges: [Geometry, Geometry];
  polys: [Geometry, Geometry];
  props: [Geometry, Geometry, Geometry];
  animated: Prop[];
  gradientSpan: number;
  edgeCount: number;
}
export function propQuad(map: MapData, p: Prop, time = 0): Quad | null {
  const asset = map.scenery[p.style - 1]?.asset;
  if (!p.active || !asset || p.level < 0 || p.level > 2) return null;
  let frame = 0;
  if (asset.frames.length > 1) {
    const duration = asset.frames.reduce((sum, f) => sum + f.delayTicks, 0);
    let tick = (time * 100) % duration;
    for (let i = 0; i < asset.frames.length; i++) {
      tick -= asset.frames[i]!.delayTicks;
      if (tick < 0) {
        frame = i;
        break;
      }
    }
  }
  return {
    asset,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    scaleX: p.scaleX,
    scaleY: p.scaleY,
    pivotX: 0,
    pivotY: 1,
    rotation: -p.rotation,
    color: [...p.color.slice(0, 3), p.alpha],
    frame,
    mapPivot: true,
  };
}
export function buildMap(
  map: MapData,
  sectors: Sectors,
  regions: Regions,
): MapGeometry {
  const result: MapGeometry = {
    background: { runs: [] },
    edges: [{ runs: [] }, { runs: [] }],
    polys: [{ runs: [] }, { runs: [] }],
    props: [{ runs: [] }, { runs: [] }, { runs: [] }],
    animated: [],
    gradientSpan: 25 * Math.max(sectors.division, Math.ceil((0.5 * 480) / 25)),
    edgeCount: 0,
  };
  const d = result.gradientSpan,
    top = [...map.backgroundTop.slice(0, 3), 255],
    bottom = [...map.backgroundBottom.slice(0, 3), 255];
  appendRun(result.background, "white", [
    { x: 0, y: -d, u: 0, v: 0, color: top },
    { x: 1, y: -d, u: 0, v: 0, color: top },
    { x: 1, y: d, u: 0, v: 0, color: bottom },
    { x: 1, y: d, u: 0, v: 0, color: bottom },
    { x: 0, y: d, u: 0, v: 0, color: bottom },
    { x: 0, y: -d, u: 0, v: 0, color: top },
  ]);
  for (let i = 0; i < map.polygons.length; i++) {
    const poly = map.polygons[i]!,
      level = background(poly) ? 0 : 1;
    appendRun(result.polys[level], "terrain", poly.vertices, true);
    for (let k = 0, j = 2; k < 3; j = k++) {
      const a = poly.vertices[k]!,
        b = poly.vertices[j]!;
      if (
        Math.min(a.color[3]!, b.color[3]!) <= 128 ||
        collides(
          { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 },
          i + 1,
          map,
          sectors,
        )
      )
        continue;
      const asset = map.edge.asset!;
      const vertices = quadVertices(
        {
          asset,
          x: a.x,
          y: a.y,
          width: asset.width,
          height: asset.height,
          scaleX: Math.hypot(b.x - a.x, b.y - a.y) / 90,
          scaleY: 1,
          pivotX: 0,
          pivotY: 0.5,
          mapPivot: true,
          rotation: Math.atan2(b.y - a.y, b.x - a.x),
          color: [...a.color.slice(0, 3), Math.trunc(a.color[3]! * 0.75)],
        },
        regions.get("edge")!,
      );
      const end = [...b.color.slice(0, 3), Math.trunc(b.color[3]! * 0.75)];
      vertices[1]!.color = vertices[2]!.color = vertices[3]!.color = end;
      appendRun(result.edges[level], "edge", vertices);
      result.edgeCount++;
    }
  }
  // Keep animated props in the ordered list: their geometry is rebuilt in the
  // same painter positions, not appended after all static props.
  for (let level = 0; level < 3; level++) {
    const quads = map.props
      .filter((p) => p.level === level)
      .map((p) => propQuad(map, p))
      .filter((q): q is Quad => q !== null);
    result.props[level] = quadGeometry(quads, regions);
  }
  return result;
}
export function animatedProps(
  map: MapData,
  time: number,
  regions: Regions,
  level: number,
): Geometry {
  return quadGeometry(
    map.props
      .filter((p) => p.level === level)
      .map((p) => propQuad(map, p, time))
      .filter((q): q is Quad => q !== null),
    regions,
  );
}
export function syntheticMap(terrain: ImageAsset, edge: ImageAsset): MapData {
  return {
    name: "synthetic",
    terrain: { asset: terrain },
    edge: { asset: edge },
    polygons: [
      {
        polytype: 0,
        vertices: [
          { x: -240, y: -180, u: -26.75, v: -27.25, color: [255, 0, 0, 255] },
          { x: 240, y: -180, u: 27.25, v: -27.25, color: [0, 255, 0, 0] },
          { x: 0, y: 180, u: 0.25, v: 28.75, color: [0, 0, 255, 128] },
        ],
      },
    ],
    props: [],
    scenery: [],
    spawnpoints: [],
    backgroundTop: [32, 32, 32, 255],
    backgroundBottom: [32, 32, 32, 255],
  };
}
