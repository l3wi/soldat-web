import { ContentError } from './errors.ts';
import type { RGBA } from './binary.ts';
export interface GraphicDefinition { symbol: string; index: number; group: string; path: string; colorKey: RGBA }
export function parseGraphics(source: string): GraphicDefinition[] {
  const ids: Record<string, number> = {};
  for (const m of source.matchAll(/\b(GFX_[A-Z0-9_]+)\s*=\s*(\d+);/g)) ids[m[1]!] = Number(m[2]);
  const result: GraphicDefinition[] = [];
  for (const m of source.matchAll(/\(ID:\s*(GFX_\w+);\s*Group:\s*GFXG_(\w+);\s*Path:\s*'([^']+)';\s*ColorKey:\s*\$([0-9A-F]+)\)/g)) {
    const key = Number.parseInt(m[4]!, 16), index = ids[m[1]!];
    if (index === undefined) throw new ContentError('GFX_ID', m[1]!);
    result.push({ symbol: m[1]!, index, group: m[2]!.toLowerCase(), path: m[3]!, colorKey: [key & 255, (key >>> 8) & 255, (key >>> 16) & 255, key >>> 24] });
  }
  if (!result.length) throw new ContentError('GFX_SOURCE', 'No graphic definitions');
  return result;
}
export function parseGostek(source: string, graphics: GraphicDefinition[], overrides: Record<string, string>) {
  const colors: Record<string, number> = { NONE: 0, MAIN: 1, PANTS: 2, SKIN: 3, HAIR: 4, CYGAR: 5, HEADBLOOD: 6 };
  const alphas: Record<string, number> = { BASE: 0, BLOOD: 1, NADES: 2 };
  const bySymbol = Object.fromEntries(graphics.map(g => [g.symbol, g]));
  const byId = Object.fromEntries(graphics.map(g => [g.index, g]));
  const parts = [];
  for (const m of source.matchAll(/\b(GOSTEK_\w+)\s*=\s*(\d+);\{\$ELSE\}Def\('([^']+)',\s*([^;]+)\);/g)) {
    const args = m[4]!.split(',').map(s => s.trim());
    if (args.length !== 11) throw new ContentError('GOSTEK_SOURCE', `Invalid definition ${m[3]}`);
    const graphic = args[0] === '0' ? null : bySymbol[args[0]!];
    if (graphic === undefined) throw new ContentError('GOSTEK_SOURCE', `Unknown image ${args[0]}`);
    const center = (axis: string, fallback: string) => {
      const value = overrides[`${m[3]}_center${axis}`.toLowerCase()];
      return value !== undefined && value.trim() !== '' && Number.isFinite(Number(value)) && !value.includes(',') ? Number(value) : Number(fallback);
    };
    const flip = args[6] === '1', team = args[7] === '1';
    // Runtime team offset is GFX_GOSTEK_TEAM2_STOPA - GFX_GOSTEK_STOPA = 59.
    const variants = graphic ? [graphic, ...(flip ? [byId[graphic.index + 1]] : []), ...(team ? [byId[graphic.index + 59], ...(flip ? [byId[graphic.index + 60]] : [])] : [])] : [];
    if (variants.some(v => !v)) throw new ContentError('GOSTEK_SOURCE', `Missing variant for ${m[3]}`);
    parts.push({ index: Number(m[2]), symbol: m[1]!, id: m[3]!, image: graphic?.index ?? 0,
      imageSymbol: graphic?.symbol ?? null, imagePath: graphic?.path ?? null, variants: variants.map(v => ({ image: v!.index, path: v!.path })),
      p1: Number(args[1]), p2: Number(args[2]), cx: center('x', args[3]!), cy: center('y', args[4]!),
      visible: args[5] === '1', flip, team, flex: Number(args[8]), color: colors[args[9]!.replace('COLOR_', '')], alpha: alphas[args[10]!.replace('ALPHA_', '')] });
  }
  if (!parts.length) throw new ContentError('GOSTEK_SOURCE', 'No gostek definitions');
  return parts;
}
