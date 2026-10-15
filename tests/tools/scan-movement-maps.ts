import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parsePms } from '../../packages/content/src/readers.ts';
import type { PmsMap } from '../../packages/content/src/readers.ts';

export const basePin = '5b6e5bef23f5c0d58fb1d4d887b9b94ebcf799b4';
export const upstreamPin = 'bf43a43bdd7a069e02c906768807f66e621b2888';
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export type StockMap = { name: string; path: string; sha256: string; map: PmsMap };
export type Surface = { map: StockMap; polygon: number; edge: number; polytype: number; x: number; y: number; width: number; slope: number; vertices: number[][]; normals: number[][] };

export async function scanMaps(): Promise<StockMap[]> {
  const directory = 'reference/base/shared/maps';
  const files = (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.pms')).sort();
  return Promise.all(files.map(async file => {
    const path = `${directory}/${file}`, bytes = await readFile(path);
    return { name: file.slice(0, -4), path, sha256: sha256(bytes), map: parsePms(bytes) };
  }));
}

export function pointInTriangle(x: number, y: number, vertices: {x: number; y: number}[]): boolean {
  const signs = vertices.map((a, i) => { const b = vertices[(i + 1) % 3]!; return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x); });
  return signs.every(n => n >= 0) || signs.every(n => n <= 0);
}

export function surfaces(maps: StockMap[], requireClearance = true): Surface[] {
  const result: Surface[] = [];
  for (const map of maps) for (const [index, polygon] of map.map.polygons.entries()) {
    for (let edge = 0; edge < 3; edge++) {
      const a = polygon.vertices[edge]!, b = polygon.vertices[(edge + 1) % 3]!, c = polygon.vertices[(edge + 2) % 3]!;
      const width = Math.abs(b.x - a.x), x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      if (width < 36 || c.y <= a.y + (c.x - a.x) * (b.y - a.y) / (b.x - a.x) || Math.abs((b.y - a.y) / (b.x - a.x)) > 1.5) continue;
      // Head clearance and an unobstructed vertical approach; use original raw geometry.
      if (requireClearance && map.map.polygons.some((other, i) => i !== index && ![1, 3, 24, 25].includes(other.polytype) && [10, 22, 34].some(d => pointInTriangle(x, y - d, other.vertices)))) continue;
      result.push({ map, polygon: index + 1, edge: edge + 1, polytype: polygon.polytype, x, y, width, slope: (b.y - a.y) / (b.x - a.x), vertices: polygon.vertices.map(v => [v.x, v.y]), normals: polygon.normals.map(n => [n.x, n.y, n.z]) });
    }
  }
  return result.sort((a, b) => b.width - a.width || a.map.name.localeCompare(b.map.name) || a.polygon - b.polygon);
}

if (import.meta.main) {
  const maps = await scanMaps(), edges = surfaces(maps);
  console.log(JSON.stringify({ maps: maps.length, capacities: maps.map(m => ({map: m.name, raw: m.map.startJet, runtime: Math.floor(119*m.map.startJet/100)})), polytypes: Array.from({length: 26}, (_, polytype) => ({ polytype, count: maps.reduce((n,m) => n + m.map.polygons.filter(p => p.polytype === polytype).length, 0), surface: edges.filter(e => e.polytype === polytype).slice(0,3).map(({map,...e}) => ({map: map.name,...e})) })) }, null, 2));
}
