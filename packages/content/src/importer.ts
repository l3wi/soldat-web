import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { ContentError } from './errors.ts';
import { FileIndex, canonicalPath, imageScale } from './paths.ts';
import { parsePms, parsePoa, parsePo, parseModIni, parseWeaponsIni, type IniData } from './readers.ts';
import { importImage, encodePng, convertWav, readZip } from './media.ts';
import { parseGraphics, parseGostek } from './gostek.ts';
import { ObjectWriter, sha256, stableJson, walkFiles, type Provenance } from './output.ts';

interface ImageAsset {
  sourcePath: string; sourceSha256: string; format: string; width: number; height: number;
  scale: number; keyed: boolean; alphaMode: 'straight'; frames: { object: string; delayMs: number; delayTicks: number }[];
}
export async function importContent(options: { base: string; out: string; source?: string; pins?: string }) {
  const pins = JSON.parse(await readFile(options.pins ?? 'pins.json', 'utf8'));
  const files = await walkFiles(options.base), writer = new ObjectWriter(options.out);
  const inventory: Record<string, { count: number; bytes: number }> = {};
  const virtual = new Map<string, string>();
  // Match create_smod.py: first file wins, shared -> client -> server; each tree rejects case collisions.
  for (const tree of ['shared', 'client', 'server']) {
    const paths = files.filter(p => p.startsWith(tree + '/')).map(p => p.slice(tree.length + 1));
    new FileIndex(paths);
    for (const path of paths) if (!virtual.has(canonicalPath(path))) virtual.set(canonicalPath(path), `${tree}/${path}`);
  }
  const index = new FileIndex([...virtual.values()].map(p => p.slice(p.indexOf('/') + 1)));
  const sourceRoot = options.source ?? 'reference/opensoldat';
  const graphicsText = await readFile(join(sourceRoot, 'shared/gfx.inc'), 'utf8');
  const gostekText = await readFile(join(sourceRoot, 'client/GostekGraphics.inc'), 'utf8');
  const mitNotice = await readFile(join(sourceRoot, 'LICENSE.md'), 'utf8');
  const graphics = parseGraphics(graphicsText);
  const sourceFor = (id: string): string => {
    const source = virtual.get(canonicalPath(id));
    if (!source) throw new ContentError('MISSING_SOURCE', id);
    return source;
  };
  const modBytes = await readFile(join(options.base, sourceFor('mod.ini'))), mod = parseModIni(modBytes);
  const customScales: Record<string, IniData> = {};
  for (const path of files.filter(p => /\/custom-interfaces\/[^/]+\/mod\.ini$/i.test(p)))
    customScales[canonicalPath(path.split('/').slice(1, -1).join('/'))] = parseModIni(await readFile(join(options.base, path)));
  const provenance = (source: string, bytes: Uint8Array, transformations: string[], sourceCode = false): Provenance => ({
    sourceRepo: sourceCode ? pins.opensoldat.repo : pins.base.repo,
    sourceCommit: sourceCode ? pins.opensoldat.commit : pins.base.commit,
    sourcePath: source, sourceSha256: sha256(bytes), licenseId: sourceCode ? 'MIT' : source.endsWith('.ttf') ? 'OFL-1.1' : 'CC-BY-4.0',
    credit: sourceCode ? 'Transhuman Design; OpenSoldat contributors' : source.endsWith('.ttf') ? 'Copyright 2011 Jonas Hecksher / Playtype / e-types AS' : 'OpenSoldat base contributors; see notices/base-credits.txt', transformations,
  });
  const images: Record<string, ImageAsset> = {}, audio: Record<string, unknown> = {}, animations: Record<string, unknown> = {}, skeletons: Record<string, unknown> = {};
  const simFiles: Record<string, { path: string; sha256: string; object: string; bytes: number }> = {};
  const maps: Record<string, unknown> = {}, archives: Record<string, unknown> = {};
  const counts = { maps: 0, poa: 0, po: 0, frames: 0, polygons: 0, props: 0, scenery: 0, colliders: 0, spawnpoints: 0, waypoints: 0,
    trailingMaps: 0, trailingBytes: 0, images: 0, png: 0, bmp: 0, gif: 0, npot: 0, decodedRgbaBytes: 0, signatureMismatches: 0,
    wav: 0, pcm: 0, adpcm: 0, pngOverrides: 0, caseOnlyResolutions: 0, declaredDependencies: 0, missingDeclared: 0, missingActive: 0 };
  const graphicKeyByPath = new Map(graphics.map(g => [canonicalPath(index.resolveImage(g.path).path ?? g.path), g.colorKey]));
  for (const source of files) {
    const bytes = await readFile(join(options.base, source)), ext = extname(source).slice(1).toLowerCase() || '(none)';
    const stat = inventory[ext] ??= { count: 0, bytes: 0 }; stat.count++; stat.bytes += bytes.length;
    if (!['png', 'bmp', 'gif', 'wav', 'poa', 'po', 'pms', 'smod'].includes(ext)) continue;
    if (['png', 'bmp', 'gif'].includes(ext)) {
      const id = canonicalPath(source.slice(source.indexOf('/') + 1));
      if (virtual.get(id) !== source) continue;
      const terrain = id.startsWith('textures/') && !id.startsWith('textures/edges/') && !id.startsWith('textures/objects/');
      const decoded = importImage(bytes, { terrain, colorKey: graphicKeyByPath.get(id) });
      const scaleTable = id.startsWith('custom-interfaces/') ? customScales[dirname(id)] ?? {} : mod;
      const asset: ImageAsset = { sourcePath: source, sourceSha256: sha256(bytes), format: decoded.format, width: decoded.width, height: decoded.height,
        scale: imageScale(id.startsWith('custom-interfaces/') ? id.split('/').slice(2).join('/') : id, scaleTable), keyed: decoded.keyed, alphaMode: 'straight', frames: [] };
      for (let frame = 0; frame < decoded.frames.length; frame++) {
        const f = decoded.frames[frame]!;
        const transformations = [`decode-${decoded.format}`, ...(decoded.keyed ? [`exact-color-key:${(graphicKeyByPath.get(id) ?? [0,255,0,255]).join(',')}`] : []), `frame:${frame}`, 'encode-rgba8-png-straight-alpha'];
        asset.frames.push({ object: await writer.put(encodePng(decoded.width, decoded.height, f.rgba), 'png', provenance(source, bytes, transformations)), delayMs: f.delayMs, delayTicks: f.delayTicks });
      }
      images[id] = asset;
      counts.images++; counts[decoded.format]++; counts.signatureMismatches += Number(ext !== decoded.format);
      counts.npot += Number((decoded.width & (decoded.width - 1)) !== 0 || (decoded.height & (decoded.height - 1)) !== 0);
      counts.decodedRgbaBytes += decoded.width * decoded.height * 4;
    } else if (ext === 'wav') {
      const result = convertWav(bytes), id = canonicalPath(source.slice(source.indexOf('/') + 1));
      audio[id] = { object: await writer.put(result.bytes, 'wav', provenance(source, bytes, result.converted ? ['ms-adpcm-to-pcm16', `samples-per-channel:${result.sampleCount}`] : ['pcm-passthrough'])),
        sampleCount: result.sampleCount, sampleRate: result.sampleRate, channels: result.channels, durationSeconds: result.durationSeconds, converted: result.converted };
      counts.wav++; counts[result.converted ? 'adpcm' : 'pcm']++;
    } else if (ext === 'poa' || ext === 'po' || ext === 'pms') {
      const id = source.slice(source.indexOf('/') + 1), object = await writer.put(bytes, ext, provenance(source, bytes, []));
      simFiles[canonicalPath(id)] = { path: `sim/${id}`, sha256: sha256(bytes), object, bytes: bytes.length };
      await writer.file(`sim/${id}`, bytes);
      if (ext === 'poa') { const parsed = parsePoa(bytes); animations[canonicalPath(id)] = parsed; counts.poa++; counts.frames += parsed.frames.length; }
      if (ext === 'po') { skeletons[canonicalPath(id)] = parsePo(bytes); counts.po++; }
      if (ext === 'pms') counts.maps++;
    } else {
      const entries = readZip(bytes);
      archives[source] = { sourceSha256: sha256(bytes), entries: [...entries].map(([path, data]) => ({ path, bytes: data.length, sha256: sha256(data) })), mountPolicy: 'preserve entry paths; no implicit root stripping' };
    }
  }
  for (const id of ['mod.ini', 'configs/weapons.ini']) {
    const source = sourceFor(id), bytes = await readFile(join(options.base, source));
    simFiles[id] = { path: `sim/${id}`, sha256: sha256(bytes), object: await writer.put(bytes, 'ini', provenance(source, bytes, [])), bytes: bytes.length };
    await writer.file(`sim/${id}`, bytes);
  }
  const simHash = sha256(Object.keys(simFiles).sort().map(id => `${id}\t${simFiles[id]!.sha256}\n`).join(''));
  await writer.json('sim/manifest.json', { schemaVersion: 1, sha256: simHash, files: simFiles });
  const weapons = parseWeaponsIni(await readFile(join(options.base, sourceFor('configs/weapons.ini'))));
  const resolveAsset = (requested: string, fallback?: string) => {
    const resolution = index.resolveImage(requested);
    const chosen = resolution.path ?? (fallback ? index.resolveImage(fallback).path : null);
    return { ...resolution, asset: chosen ? images[canonicalPath(chosen)] ?? null : null, fallback: !resolution.path && chosen ? chosen : null };
  };
  const missingActive: { map: string; requested: string }[] = [];
  for (const source of files.filter(p => p.toLowerCase().endsWith('.pms'))) {
    const raw = await readFile(join(options.base, source)), map = parsePms(raw), name = source.slice(source.lastIndexOf('/') + 1, -4);
    const terrain = resolveAsset(`textures/${map.texture}`, 'textures/default.bmp');
    const edge = resolveAsset(`textures/edges/${map.texture}`, 'textures/edges/default.bmp');
    const used = new Set(map.props.filter(p => p.active && p.level <= 2).map(p => p.style));
    const scenery = map.scenery.map((s, i) => ({ style: i + 1, name: s.name, date: s.date, active: used.has(i + 1), ...resolveAsset(`scenery-gfx/${s.name}`) }));
    const dependencies = [terrain, ...scenery];
    counts.declaredDependencies += dependencies.length;
    for (const dependency of dependencies) { counts.pngOverrides += Number(dependency.pngOverride); counts.caseOnlyResolutions += Number(dependency.caseOnly); counts.missingDeclared += Number(!dependency.path); }
    const missing = [ ...(!terrain.path ? [{ kind: 'terrain', requested: terrain.requested, active: true, fallback: terrain.fallback }] : []),
      ...scenery.filter(s => !s.path).map(s => ({ kind: 'scenery', style: s.style, requested: s.requested, active: s.active, fallback: null })) ];
    for (const d of missing.filter(d => d.active)) missingActive.push({ map: name, requested: d.requested });
    counts.polygons += map.polygons.length; counts.props += map.props.length; counts.scenery += map.scenery.length;
    counts.colliders += map.colliders.length; counts.spawnpoints += map.spawnpoints.length; counts.waypoints += map.waypoints.length;
    counts.trailingMaps += Number(map.trailingBytes.length > 0); counts.trailingBytes += map.trailingBytes.length;
    const render = { schemaVersion: 1, name, mapSha256: sha256(raw), description: map.description, terrain, edge,
      polygons: map.polygons, props: map.props, scenery, colliders: map.colliders, spawnpoints: map.spawnpoints,
      backgroundTop: map.backgroundTop, backgroundBottom: map.backgroundBottom, weather: map.weather, steps: map.steps,
      startJet: map.startJet, botCapable: map.waypoints.length > 0, missing };
    await writer.json(`maps/${name}.json`, render);
    maps[name] = { path: `maps/${name}.json`, mapSha256: sha256(raw), simContentSha256: simHash, terrain, edge, scenery, missing, botCapable: render.botCapable };
  }
  counts.missingActive = missingActive.length;
  const parts = parseGostek(gostekText, graphics, mod.gostek ?? {});
  const gostek = { schemaVersion: 1, licenseId: 'MIT', mitNotice, parts, graphics: graphics.map(g => ({ ...g, ...resolveAsset(g.path) })) };
  const gostekBytes = new TextEncoder().encode(stableJson(gostek));
  const gostekObject = await writer.put(gostekBytes, 'json', provenance('client/GostekGraphics.inc', new TextEncoder().encode(gostekText), ['parse-def-table', 'apply-mod-ini-center-overrides', 'resolve-gfx-table'], true));
  await writer.put(gostekBytes, 'json', provenance('shared/gfx.inc', new TextEncoder().encode(graphicsText), ['resolve-gfx-table'], true));
  await writer.put(gostekBytes, 'json', provenance(sourceFor('mod.ini'), modBytes, ['apply-gostek-center-overrides']));
  await writer.json('gostek.json', gostek); await writer.json('animations.json', animations); await writer.json('skeletons.json', skeletons); await writer.json('weapons.json', weapons);
  const fontBytes = await readFile(join(options.base, 'play-regular.ttf'));
  const font = await writer.put(fontBytes, 'ttf', provenance('play-regular.ttf', fontBytes, []));
  for (const [source, target] of [['LICENSE.txt', 'notices/base-license.txt'], ['Credits.md', 'notices/base-credits.txt']] as const)
    await writer.file(target, await readFile(join(options.base, source)));
  await writer.file('notices/opensoldat-mit.txt', mitNotice);
  await writer.file('notices/play-OFL.txt', await readFile(new URL('../notices/play-OFL.txt', import.meta.url)));
  const core = { gostek: gostekObject, font, animations: 'animations.json', skeletons: 'skeletons.json', weapons: 'weapons.json',
    graphics: Object.fromEntries(['gostek', 'weapons', 'sparks', 'interface', 'objects'].map(group => [group, graphics.filter(g => g.group === group).map(g => ({ ...g, ...resolveAsset(g.path) }))])), sfx: audio };
  const summary = { ...counts, gostekParts: parts.length, graphicDefinitions: graphics.length, looseFiles: files.length, looseBytes: Object.values(inventory).reduce((n, s) => n + s.bytes, 0), inventory,
    classicMapsWithoutMissingActive: Object.entries(maps).filter(([name]) => !['ctf_Aftermath', 'ctf_Amnesia'].includes(name) && !missingActive.some(m => m.map === name)).length, missingActive, archives };
  await writer.json('manifest.json', { schemaVersion: 1, pins: { base: pins.base, opensoldat: pins.opensoldat }, alphaMode: 'straight; premultiply exactly once at GPU upload', simContentSha256: simHash, core, images, maps, objects: writer.objects, summary });
  return { summary, simContentSha256: simHash };
}
