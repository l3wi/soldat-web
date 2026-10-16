import { contentUrl, type ContentIndex } from './content';
import { sessionFont, sessionImage, sessionJson, type SessionProgress, type SessionProgressCallback } from './session-cache';
import { loadSimulationCode } from './sim-runtime';

export interface ShellProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  label: string;
}

/** Prepare immutable session resources only; no host, game or WebGL context. */
export async function prepareShell(onProgress: (progress: ShellProgress) => void, signal: AbortSignal): Promise<ContentIndex> {
  signal.throwIfAborted();
  const transfers = new Map<string, SessionProgress>();
  let files = 0;
  let totalFiles = 1;
  const publish = (label: string) => {
    if (signal.aborted) return;
    let bytes = 0;
    let totalBytes = 0;
    for (const transfer of transfers.values()) {
      bytes += transfer.bytes;
      totalBytes += Math.max(transfer.bytes, transfer.totalBytes);
    }
    onProgress({ files, totalFiles, bytes, totalBytes, label });
  };
  const observe = (key: string, label: string): SessionProgressCallback => progress => {
    transfers.set(key, progress);
    publish(label);
  };
  publish('Loading content index');
  const index = await sessionJson<ContentIndex>(contentUrl('index.json'), signal, observe('index', 'Loading content index'));
  files++;
  const images = new Set(Object.values(index.core.graphics).flatMap(group => group.flatMap(graphic => graphic.asset?.frames.map(frame => frame.object) ?? [])));
  totalFiles += images.size + 2;
  publish('Preparing original graphics');

  const tasks: { key: string; label: string; load: (progress: SessionProgressCallback) => Promise<unknown> }[] = [
    {
      key: index.core.font,
      label: 'Loading original Play font',
      load: async progress => {
        const font = await sessionFont('Play', contentUrl(index.core.font), signal, progress);
        signal.throwIfAborted();
        document.fonts.add(font);
        document.documentElement.style.setProperty('--soldat-font', '"Play", sans-serif');
        document.documentElement.style.fontFamily = '"Play", sans-serif';
      },
    },
    {
      key: 'sim.wasm',
      label: 'Preparing simulation',
      load: progress => loadSimulationCode(signal, undefined, progress),
    },
    ...Array.from(images, object => ({
      key: object,
      label: 'Loading original graphics',
      load: (progress: SessionProgressCallback) => sessionImage(contentUrl(object), signal, progress),
    })),
  ];
  // Bound concurrent image decode/transfer work without inventing progress ticks.
  let nextTask = 0;
  await Promise.all(Array.from({ length: Math.min(8, tasks.length) }, async () => {
    while (nextTask < tasks.length) {
      signal.throwIfAborted();
      const task = tasks[nextTask++]!;
      await task.load(observe(task.key, task.label));
      signal.throwIfAborted();
      files++;
      publish(task.label);
    }
  }));
  const cursor = index.core.graphics.interface.find(graphic => graphic.symbol === 'GFX_INTERFACE_MENUCURSOR')?.asset;
  if (!cursor) throw new Error('Missing original menu cursor');
  const image = await sessionImage(contentUrl(cursor.frames[0]!.object), signal);
  signal.throwIfAborted();
  // CSS cursors use native logical dimensions, not the source asset's HD scale.
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cursor.width / cursor.scale));
  canvas.height = Math.max(1, Math.round(cursor.height / cursor.scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D menu cursor unavailable');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const cursorValue = `url("${canvas.toDataURL('image/png')}") 0 0, default`;
  document.documentElement.style.setProperty('--soldat-menu-cursor', cursorValue);
  publish('Ready');
  return index;
}
