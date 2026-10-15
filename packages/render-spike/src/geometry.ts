import type { DrawRun, Geometry, Quad, Vertex } from "./types";
export interface Region {
  key: string;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}
export type Regions = Map<string, Region>;
export function appendRun(
  geometry: Geometry,
  key: string,
  vertices: Vertex[],
  repeat = false,
) {
  let run = geometry.runs.at(-1);
  if (!run || run.key !== key || run.repeat !== repeat) {
    run = { key, vertices: [], repeat };
    geometry.runs.push(run);
  }
  run.vertices.push(...vertices);
}
export function quadVertices(q: Quad, region: Region): Vertex[] {
  const c = Math.cos(q.rotation),
    s = Math.sin(q.rotation);
  const a = c * q.scaleX,
    b = s * q.scaleX,
    d = -s * q.scaleY,
    e = c * q.scaleY;
  // GfxSpriteVertices -> GfxMat3Transform uses an absolute rotation center.
  // Gostek DrawGostekSprite instead scales a normalized image origin.
  const ox = q.mapPivot
    ? q.x + q.pivotY * s - c * q.pivotX + q.pivotX
    : q.x - q.pivotX * q.width * a - q.pivotY * q.height * d;
  const oy = q.mapPivot
    ? q.y - q.pivotX * s - c * q.pivotY + q.pivotY
    : q.y - q.pivotX * q.width * b - q.pivotY * q.height * e;
  const corners = [
    [0, 0, region.u0, region.v0],
    [q.width, 0, region.u1, region.v0],
    [q.width, q.height, region.u1, region.v1],
    [0, q.height, region.u0, region.v1],
  ];
  const v = corners.map(([x, y, u, v]) => ({
    x: ox + x! * a + y! * d,
    y: oy + x! * b + y! * e,
    u: u!,
    v: v!,
    color: q.color,
  }));
  return [v[0]!, v[1]!, v[2]!, v[2]!, v[3]!, v[0]!];
}
export function quadGeometry(quads: Quad[], regions: Regions): Geometry {
  const geometry: Geometry = { runs: [] };
  for (const q of quads) {
    const frame = q.asset.frames[q.frame ?? 0] ?? q.asset.frames[0]!;
    const region = regions.get(frame.object);
    if (region) appendRun(geometry, region.key, quadVertices(q, region));
  }
  return geometry;
}
export function packVertices(runs: DrawRun[]): ArrayBuffer {
  const count = runs.reduce((n, r) => n + r.vertices.length, 0);
  const data = new ArrayBuffer(count * 20),
    view = new DataView(data);
  let offset = 0;
  for (const run of runs)
    for (const v of run.vertices) {
      view.setFloat32(offset, v.x, true);
      view.setFloat32(offset + 4, v.y, true);
      view.setFloat32(offset + 8, v.u, true);
      view.setFloat32(offset + 12, v.v, true);
      for (let i = 0; i < 4; i++)
        view.setUint8(offset + 16 + i, v.color[i] ?? 255);
      offset += 20;
    }
  return data;
}
