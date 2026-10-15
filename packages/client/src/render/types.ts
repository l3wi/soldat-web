export interface ImageAsset {
  width: number;
  height: number;
  scale: number;
  frames: { object: string; delayMs: number; delayTicks: number }[];
  sourcePath?: string;
}
export interface Point {
  x: number;
  y: number;
}
export interface Vertex extends Point {
  u: number;
  v: number;
  color: number[];
}
export interface Quad {
  asset: ImageAsset;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  pivotX: number;
  pivotY: number;
  rotation: number;
  color: number[];
  frame?: number;
  mapPivot?: boolean;
}
export interface Polygon {
  vertices: Vertex[];
  polytype: number;
}
export interface Resolution {
  asset: ImageAsset | null;
}
export interface Prop {
  active: boolean;
  style: number;
  width: number;
  height: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  color: number[];
  level: number;
}
export interface MapData {
  name: string;
  polygons: Polygon[];
  terrain: Resolution;
  edge: Resolution;
  props: Prop[];
  scenery: Resolution[];
  backgroundTop: number[];
  backgroundBottom: number[];
  spawnpoints: { active: boolean; x: number; y: number; team: number }[];
  missing?: { kind: string; requested: string; active: boolean; fallback: string | null }[];
}
export interface Camera {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}
export interface DrawRun {
  key: string;
  vertices: Vertex[];
  repeat: boolean;
}
export interface Geometry {
  runs: DrawRun[];
}
