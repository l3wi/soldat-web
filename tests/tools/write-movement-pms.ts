// Test-only PMS v11 writer. Production content parser remains read-only.
import { parsePms } from '../../packages/content/src/readers.ts';
export type Triangle = { type: number; vertices: [number, number][]; bounce?: number };

export function writeMovementPms(triangles: Triangle[], startJet: number): Uint8Array {
  const chunks: Buffer[] = [];
  const i32 = (value: number) => { const b = Buffer.alloc(4); b.writeInt32LE(value); chunks.push(b); };
  const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); chunks.push(b); };
  const f32 = (value: number) => { const b = Buffer.alloc(4); b.writeFloatLE(value); chunks.push(b); };
  const string = (value: string, maximum: number) => { const b = Buffer.alloc(maximum + 1); b[0] = value.length; b.write(value, 1, 'latin1'); chunks.push(b); };
  i32(11); string('Movement test geometry', 38); string('default.bmp', 24);
  chunks.push(Buffer.from([0,0,0,255,0,0,0,255])); i32(startJet);
  chunks.push(Buffer.alloc(4)); i32(1001); i32(triangles.length);
  for (const triangle of triangles) {
    for (const [x,y] of triangle.vertices) {
      f32(x); f32(y); f32(1); f32(1); chunks.push(Buffer.from([255,255,255,255])); f32(0); f32(0);
    }
    for (let edge = 0; edge < 3; edge++) {
      const [ax,ay] = triangle.vertices[edge]!, [bx,by] = triangle.vertices[(edge+1)%3]!;
      const dx = bx-ax, dy = by-ay, length = Math.hypot(dx,dy), strength = triangle.bounce ?? 1;
      f32(-dy/length*strength); f32(dx/length*strength); f32(1);
    }
    chunks.push(Buffer.from([triangle.type]));
  }
  // Original sector indices -25..25. Listing all triangles preserves source order;
  // the original point tests still decide contact, not this coarse broadphase.
  i32(100); i32(25);
  for (let cell=0; cell<51*51; cell++) { u16(triangles.length); for(let p=1;p<=triangles.length;p++) u16(p); }
  i32(0); i32(0); i32(0); i32(1);
  chunks.push(Buffer.from([1,0,0,0])); i32(0); i32(-32); i32(0); i32(0);
  const bytes = Buffer.concat(chunks);
  parsePms(bytes);
  return bytes;
}

export function platform(type: number, y=0): Triangle[] {
  return [
    {type, vertices:[[-1600,y],[1600,y],[1600,y+300]]},
    {type, vertices:[[-1600,y],[1600,y+300],[-1600,y+300]]},
  ];
}
