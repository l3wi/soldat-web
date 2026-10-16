import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileIndex, imageScale } from './paths.ts';
import { ContentError } from './errors.ts';
import { importContent } from './importer.ts';
import { sha256 } from './output.ts';
describe('native image path resolution', () => {
  test('PNG wins over the requested BMP and case/backslashes are canonicalized', () => {
    const files = new FileIndex(['scenery-gfx/Banana.bmp', 'scenery-gfx/banana.png', 'scenery-gfx/GRASS.BMP']);
    expect(files.resolveImage('SCENERY-GFX\\BANANA.BMP')).toMatchObject({ path: 'scenery-gfx/banana.png', pngOverride: true });
    expect(files.resolveImage('scenery-gfx/grass.bmp')).toMatchObject({ path: 'scenery-gfx/GRASS.BMP', caseOnly: true });
  });
  test('case collisions and traversal are rejected', () => {
    expect(() => new FileIndex(['a.png', 'A.PNG'])).toThrow(ContentError);
    expect(() => new FileIndex(['../a.png'])).toThrow(ContentError);
  });
  test('scale uses full path then directory then default, with invalid value fallback one', () => {
    const config = { scale: { defaultscale: '4.5', 'gostek-gfx': '3', 'gostek-gfx/head.png': '2' } };
    expect(imageScale('gostek-gfx/head.png', config)).toBe(2);
    expect(imageScale('gostek-gfx/foot.png', config)).toBe(3);
    expect(imageScale('weapons-gfx/gun.png', config)).toBe(4.5);
    expect(imageScale('a.png', { scale: { defaultscale: '4,5' } })).toBe(1);
  });
});

describe('simulation content paths', () => {
  test('all 16 original bot profiles retain raw bytes and provenance in the combined identity', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const base = join(root, 'reference/base'), out = await mkdtemp(join(tmpdir(), 'soldat-content-'));
    try {
      const result = await importContent({ base, out, source: join(root, 'reference/opensoldat'), pins: join(root, 'pins.json') });
      const manifest = JSON.parse(await readFile(join(out, 'sim/manifest.json'), 'utf8'));
      const content = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
      const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
      expect(Object.keys(index).sort()).toEqual(['alphaMode', 'core', 'maps', 'pins', 'schemaVersion', 'simContentSha256', 'simPack']);
      expect(index.core).toEqual(content.core);
      expect(index.simContentSha256).toBe(result.simContentSha256);
      async function checkPack(pack: { path: string; sha256: string; bytes: number }, expectedIds: string[]) {
        const bytes = await readFile(join(out, pack.path)), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(bytes.length).toBe(pack.bytes); expect(sha256(bytes)).toBe(pack.sha256);
        expect(bytes.subarray(0, 4).toString()).toBe('SPK1');
        expect(view.getUint32(4, true)).toBe(expectedIds.length);
        const ids: string[] = [];
        let offset = 8;
        for (let i = 0; i < expectedIds.length; i++) {
          const idLength = view.getUint16(offset, true), length = view.getUint32(offset + 2, true); offset += 6;
          const id = bytes.subarray(offset, offset + idLength).toString('utf8'); offset += idLength;
          const raw = bytes.subarray(offset, offset + length); offset += length;
          ids.push(id);
          expect(length).toBe(manifest.files[id].bytes); expect(sha256(raw)).toBe(manifest.files[id].sha256);
          expect(raw).toEqual(await readFile(join(out, manifest.files[id].path)));
        }
        expect(ids).toEqual(expectedIds); expect(offset).toBe(bytes.length);
      }
      const allIds = Object.keys(manifest.files).sort();
      await checkPack(index.simPack, allIds);
      for (const [name, map] of Object.entries(index.maps) as [string, { path: string; simPack: { path: string; sha256: string; bytes: number } }][]) {
        expect(Object.keys(map).sort()).toEqual(['botCapable', 'mapSha256', 'missing', 'path', 'simContentSha256', 'simPack']);
        await checkPack(map.simPack, allIds.filter(id => !id.startsWith('maps/') || id === `maps/${name.toLowerCase()}.pms`));
        const render = JSON.parse(await readFile(join(out, map.path), 'utf8'));
        expect(render.terrain).toBeDefined(); expect(render.scenery).toBeDefined();
      }
      for (const image of Object.values(content.images) as { frames: { object: string }[] }[])
        for (const frame of image.frames) expect(frame.object.endsWith('.webp')).toBe(true);
      for (const asset of Object.values(index.core.sfx) as { object: string; codec: string; channels: number }[]) {
        expect(asset.object.endsWith('.opus')).toBe(true); expect(asset.codec).toBe('opus'); expect(asset.channels).toBe(1);
      }
      const pins = JSON.parse(await readFile(join(root, 'pins.json'), 'utf8'));
      const profiles = (await readdir(join(base, 'server/configs/bots'))).filter(name => name.toLowerCase().endsWith('.bot')).sort();
      const ids = profiles.map(name => `bots/${name.toLowerCase()}`).sort();
      expect(profiles.length).toBe(16);
      expect(Object.keys(manifest.files).length).toBe(174);
      expect(Object.keys(manifest.files).filter(id => id.startsWith('bots/')).sort()).toEqual(ids);
      expect(Object.keys(manifest.files).some(id => id.startsWith('configs/bots/'))).toBe(false);
      for (const name of profiles) {
        const source = `server/configs/bots/${name}`, id = `bots/${name.toLowerCase()}`;
        const bytes = await readFile(join(base, source)), hash = sha256(bytes);
        const entry = manifest.files[id];
        expect(entry).toEqual({ path: `sim/${id}`, sha256: hash, object: `objects/${hash}.bot`, bytes: bytes.length });
        expect(await readFile(join(out, entry.path))).toEqual(bytes);
        expect(await readFile(join(out, entry.object))).toEqual(bytes);
        expect(content.objects[entry.object]).toEqual({ sha256: hash, bytes: bytes.length, provenance: [{
          sourceRepo: pins.base.repo, sourceCommit: pins.base.commit, sourcePath: source, sourceSha256: hash,
          licenseId: 'CC-BY-4.0', credit: 'OpenSoldat base contributors; see notices/base-credits.txt', transformations: [],
        }] });
      }
      const records = Object.keys(manifest.files).sort().map(id => `${id}\t${manifest.files[id].sha256}\n`);
      const hash = sha256(records.join(''));
      expect(manifest.sha256).toBe(hash);
      expect(result.simContentSha256).toBe(hash);
      expect(content.simContentSha256).toBe(hash);
      for (const map of Object.values(content.maps) as { simContentSha256: string }[]) expect(map.simContentSha256).toBe(hash);
      const withoutBots = Object.keys(manifest.files).filter(id => !id.startsWith('bots/')).sort()
        .map(id => `${id}\t${manifest.files[id].sha256}\n`).join('');
      expect(sha256(withoutBots)).not.toBe(hash);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 600000);
});
