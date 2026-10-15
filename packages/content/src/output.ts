import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v) + '\n';
}
export async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  await walk(root);
  return files.sort();
}
export interface Provenance {
  sourceRepo: string; sourceCommit: string; sourcePath: string; sourceSha256: string;
  licenseId: string; credit: string; transformations: string[];
}
export class ObjectWriter {
  readonly objects: Record<string, { sha256: string; bytes: number; provenance: Provenance[] }> = {};
  constructor(readonly root: string) {}
  async put(bytes: Uint8Array, ext: string, provenance: Provenance): Promise<string> {
    const hash = sha256(bytes), object = `objects/${hash}.${ext}`;
    const current = this.objects[object];
    if (current) {
      if (!current.provenance.some(p => stableJson(p) === stableJson(provenance))) current.provenance.push(provenance);
    } else {
      this.objects[object] = { sha256: hash, bytes: bytes.length, provenance: [provenance] };
      await this.file(object, bytes);
    }
    return object;
  }
  async file(path: string, bytes: Uint8Array | string): Promise<void> {
    const target = join(this.root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  async json(path: string, value: unknown): Promise<void> { await this.file(path, stableJson(value)); }
}
/** Tree identity hashes sorted relative-path TAB file-sha256 LF records. */
export async function hashDirectory(root: string): Promise<{ sha256: string; files: number; bytes: number }> {
  const paths = await walkFiles(root); let records = '', bytes = 0;
  for (const path of paths) { const data = await readFile(join(root, path)); bytes += data.length; records += `${path}\t${sha256(data)}\n`; }
  return { sha256: sha256(records), files: paths.length, bytes };
}
