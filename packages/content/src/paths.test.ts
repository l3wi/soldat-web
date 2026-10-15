import { describe, expect, test } from 'bun:test';
import { FileIndex, imageScale } from './paths.ts';
import { ContentError } from './errors.ts';
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
