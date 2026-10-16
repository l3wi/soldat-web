import { useEffect, useRef, useState } from 'react';
import { contentUrl, loadRenderMap } from './content';
import { sessionImage } from './session-cache';
import { quadVertices } from './render/geometry';
import { propQuad } from './render/map';
import type { MapData, Vertex } from './render/types';

interface PreviewTexture {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}
interface PreviewTriangle {
  vertices: readonly Vertex[];
  texture: string | null;
  repeat: boolean;
}
interface PreviewScene {
  map: MapData;
  triangles: PreviewTriangle[];
  textures: Map<string, PreviewTexture>;
  bounds: { left: number; top: number; right: number; bottom: number };
}

/** Static first-frame presentation of the same JSON/prop transforms as gameplay. */
async function loadPreview(mapName: string, signal: AbortSignal): Promise<PreviewScene> {
  const map = await loadRenderMap(mapName, signal);
  signal.throwIfAborted();
  const triangles: PreviewTriangle[] = [];
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const add = (vertices: readonly Vertex[], texture: string | null, repeat: boolean) => {
    triangles.push({ vertices, texture, repeat });
    for (const vertex of vertices) {
      bounds.left = Math.min(bounds.left, vertex.x);
      bounds.right = Math.max(bounds.right, vertex.x);
      bounds.top = Math.min(bounds.top, vertex.y);
      bounds.bottom = Math.max(bounds.bottom, vertex.y);
    }
  };
  const terrain = map.terrain.asset?.frames[0]?.object ?? null;
  // Retain native background terrain -> scenery 0/1 -> foreground terrain -> scenery 2 order.
  for (let layer = 0; layer < 2; layer++) {
    for (const polygon of map.polygons) {
      if ((polygon.polytype === 24 || polygon.polytype === 25) !== (layer === 0)) continue;
      if (polygon.vertices.length === 3) add(polygon.vertices, terrain, true);
    }
    for (const level of layer === 0 ? [0, 1] : [2]) {
      for (const prop of map.props) {
        if (prop.level !== level) continue;
        const quad = propQuad(map, prop);
        if (!quad) continue;
        const vertices = quadVertices(quad, { key: '', u0: 0, v0: 0, u1: 1, v1: 1 });
        const texture = quad.asset.frames[0]?.object ?? null;
        add(vertices.slice(0, 3), texture, false);
        add(vertices.slice(3, 6), texture, false);
      }
    }
  }
  if (!Number.isFinite(bounds.left)) throw new Error(`No render geometry for ${mapName}`);
  const textures = new Map<string, PreviewTexture>();
  const objects = new Set(triangles.flatMap(triangle => triangle.texture ? [triangle.texture] : []));
  await Promise.all(Array.from(objects, async object => {
    const image = await sessionImage(contentUrl(object), signal);
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D map textures unavailable');
    context.drawImage(image, 0, 0);
    textures.set(object, { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data });
    canvas.width = canvas.height = 0;
  }));
  return { map, triangles, textures, bounds };
}

/** Rasterize source UVs and interpolated vertex RGBA without allocating a GL context. */
function paintPreview(canvas: HTMLCanvasElement, scene: PreviewScene): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D map preview unavailable');
  const width = canvas.width;
  const height = canvas.height;
  const bounds = scene.bounds;
  const scale = Math.max(width / Math.max(1, bounds.right - bounds.left), height / Math.max(1, bounds.bottom - bounds.top));
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const offsetX = width / 2 - centerX * scale;
  const offsetY = height / 2 - centerY * scale;
  const output = context.createImageData(width, height);
  const pixels = output.data;
  for (let y = 0; y < height; y++) {
    const t = height <= 1 ? 0 : y / (height - 1);
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = scene.map.backgroundTop[channel]! * (1 - t) + scene.map.backgroundBottom[channel]! * t;
      pixels[offset + 3] = 255;
    }
  }
  for (const triangle of scene.triangles) {
    const [a, b, c] = triangle.vertices as readonly [Vertex, Vertex, Vertex];
    const ax = a.x * scale + offsetX, ay = a.y * scale + offsetY;
    const bx = b.x * scale + offsetX, by = b.y * scale + offsetY;
    const cx = c.x * scale + offsetX, cy = c.y * scale + offsetY;
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < 1e-8) continue;
    const left = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const right = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const top = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const bottom = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    const texture = triangle.texture ? scene.textures.get(triangle.texture) : undefined;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const wa = ((by - cy) * (x + .5 - cx) + (cx - bx) * (y + .5 - cy)) / denominator;
        const wb = ((cy - ay) * (x + .5 - cx) + (ax - cx) * (y + .5 - cy)) / denominator;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        let sample = 0;
        if (texture) {
          let u = a.u * wa + b.u * wb + c.u * wc;
          let v = a.v * wa + b.v * wb + c.v * wc;
          if (triangle.repeat) { u -= Math.floor(u); v -= Math.floor(v); }
          const tx = Math.max(0, Math.min(texture.width - 1, Math.floor(u * texture.width)));
          const ty = Math.max(0, Math.min(texture.height - 1, Math.floor(v * texture.height)));
          sample = (ty * texture.width + tx) * 4;
        }
        const alpha = ((a.color[3] ?? 255) * wa + (b.color[3] ?? 255) * wb + (c.color[3] ?? 255) * wc) / 255 * (texture ? texture.pixels[sample + 3]! / 255 : 1);
        if (alpha === 0) continue;
        const destination = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const tint = (a.color[channel] ?? 255) * wa + (b.color[channel] ?? 255) * wb + (c.color[channel] ?? 255) * wc;
          const color = tint * (texture ? texture.pixels[sample + channel]! / 255 : 1);
          pixels[destination + channel] = color * alpha + pixels[destination + channel]! * (1 - alpha);
        }
      }
    }
  }
  context.putImageData(output, 0, 0);
}

export function MapPreview({ map }: { map: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const abort = new AbortController();
    let scene: PreviewScene | undefined;
    let frame = 0;
    setError('');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!scene || abort.signal.aborted) return;
        const size = canvas.getBoundingClientRect();
        if (size.width <= 0 || size.height <= 0) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(size.width * ratio));
        canvas.height = Math.max(1, Math.round(size.height * ratio));
        try { paintPreview(canvas, scene); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    loadPreview(map, abort.signal).then(loaded => {
      if (abort.signal.aborted) return;
      scene = loaded;
      schedule();
    }).catch(cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      abort.abort();
      observer.disconnect();
      cancelAnimationFrame(frame);
      scene = undefined;
      canvas.width = canvas.height = 0;
    };
  }, [map]);
  return <div className="map-preview">
    <canvas ref={canvasRef} role="img" aria-label={`${map} map preview`} />
    {error && <span className="map-preview-error" role="status" style={{ position: 'absolute', inset: 8 }}>{error}</span>}
  </div>;
}
