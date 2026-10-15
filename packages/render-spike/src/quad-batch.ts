import type { DrawRun, Geometry, Quad, Vertex } from "./types";
import type { Regions } from "./geometry";
const cornersX = [0, 1, 1, 1, 0, 0],
  cornersY = [0, 0, 1, 1, 1, 0];
/** Stable CPU geometry: only a changed peak quad/run count allocates. The
 * simulation/pose inputs remain immutable; painter order is never sorted. */
export class QuadBatch {
  private vertices: Vertex[][] = [];
  private runs: DrawRun[] = [];
  readonly geometry: Geometry = { runs: [] };
  update(quads: Quad[], regions: Regions): Geometry {
    let runCount = 0,
      current: DrawRun | undefined;
    for (let i = 0; i < quads.length; i++) {
      const q = quads[i]!,
        frame = q.asset.frames[q.frame ?? 0] ?? q.asset.frames[0]!,
        region = regions.get(frame.object);
      if (!region) throw Error(`Missing uploaded quad frame ${frame.object}`);
      if (!current || current.key !== region.key) {
        current = this.runs[runCount];
        if (!current) {
          current = { key: region.key, repeat: false, vertices: [] };
          this.runs[runCount] = current;
        }
        current.key = region.key;
        current.vertices.length = 0;
        this.geometry.runs[runCount++] = current;
      }
      let vertices = this.vertices[i];
      if (!vertices) {
        vertices = Array.from({ length: 6 }, () => ({
          x: 0,
          y: 0,
          u: 0,
          v: 0,
          color: q.color,
        }));
        this.vertices[i] = vertices;
      }
      const c = Math.cos(q.rotation),
        s = Math.sin(q.rotation),
        a = c * q.scaleX,
        b = s * q.scaleX,
        d = -s * q.scaleY,
        e = c * q.scaleY;
      const ox = q.mapPivot
        ? q.x + q.pivotY * s - c * q.pivotX + q.pivotX
        : q.x - q.pivotX * q.width * a - q.pivotY * q.height * d;
      const oy = q.mapPivot
        ? q.y - q.pivotX * s - c * q.pivotY + q.pivotY
        : q.y - q.pivotX * q.width * b - q.pivotY * q.height * e;
      for (let j = 0; j < 6; j++) {
        const v = vertices[j]!,
          x = cornersX[j]! * q.width,
          y = cornersY[j]! * q.height;
        v.x = ox + x * a + y * d;
        v.y = oy + x * b + y * e;
        v.u = cornersX[j] ? region.u1 : region.u0;
        v.v = cornersY[j] ? region.v1 : region.v0;
        v.color = q.color;
        current.vertices.push(v);
      }
    }
    this.geometry.runs.length = runCount;
    return this.geometry;
  }
}
