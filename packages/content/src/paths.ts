import { ContentError } from './errors.ts';
export function canonicalPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/.test(normalized) || normalized.split('/').some(p => p === '..' || p === '.' || p === '') || normalized.includes('\0'))
    throw new ContentError('PATH', `Unsafe virtual path: ${path}`);
  return normalized;
}
export interface Resolution { requested: string; id: string; path: string | null; pngOverride: boolean; caseOnly: boolean }
export class FileIndex {
  private readonly files = new Map<string, string>();
  constructor(paths: Iterable<string>) {
    for (const path of paths) {
      const key = canonicalPath(path), previous = this.files.get(key);
      if (previous !== undefined) throw new ContentError('CASE_COLLISION', `${previous} and ${path}`);
      this.files.set(key, path);
    }
  }
  get(path: string): string | null { return this.files.get(canonicalPath(path)) ?? null; }
  resolveImage(requested: string): Resolution {
    const id = canonicalPath(requested), png = id.replace(/\.[^/.]+$/, '') + '.png';
    const path = this.files.get(png) ?? this.files.get(id) ?? null;
    return { requested, id, path, pngOverride: path !== null && canonicalPath(path) === png && id !== png,
      caseOnly: path !== null && canonicalPath(path) === id && path !== requested.replaceAll('\\', '/') };
  }
}
export function imageScale(path: string, sections: Record<string, Record<string, string>>): number {
  const normalized = canonicalPath(path), scale = sections.scale ?? {};
  const value = scale[normalized] ?? scale[normalized.slice(0, normalized.lastIndexOf('/'))] ?? scale.defaultscale;
  return value !== undefined && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)) ? Number(value) : 1;
}
