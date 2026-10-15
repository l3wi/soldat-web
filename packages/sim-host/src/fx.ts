export const FX_LAYOUT = {
  headerBytes: 32, sparkBytes: 64, capacity: 558, totalBytes: 35744,
  header: { version: 0, tick: 4, count: 8, capacity: 12, stride: 16, bytes: 20, weather: 24 },
  spark: { slot: 0, style: 4, owner: 8, life: 12, posX: 16, posY: 20, oldPosX: 24, oldPosY: 28,
    lifePrev: 32, scaleX: 36, scaleY: 40, rotation: 44, tint: 48, alpha: 52, offsetX: 56, offsetY: 60 },
} as const;
export interface FxSpark {
  slot: number; style: number; owner: number; life: number; lifePrev: number;
  posX: number; posY: number; oldPosX: number; oldPosY: number;
  scaleX: number; scaleY: number; rotation: number; tint: number; alpha: number; offsetX: number; offsetY: number;
}
export interface FxView { tick: number; count: number; weather: number; spark(index: number): FxSpark }
/** Borrowed view: refresh after any simulation call or memory growth. */
export function readFxView(memory: WebAssembly.Memory, ptr: number): FxView | number {
  if (ptr <= 0) return ptr;
  const header = new DataView(memory.buffer,ptr,FX_LAYOUT.headerBytes);
  const h = FX_LAYOUT.header;
  const count = header.getUint32(h.count,true);
  if (header.getUint32(h.version,true)!==0x00010003 || count>FX_LAYOUT.capacity ||
    header.getUint32(h.capacity,true)!==FX_LAYOUT.capacity || header.getUint32(h.stride,true)!==FX_LAYOUT.sparkBytes ||
    header.getUint32(h.bytes,true)!==FX_LAYOUT.totalBytes) throw new Error("Unsupported FX layout");
  return { tick: header.getUint32(h.tick,true), count, weather: header.getUint32(h.weather,true),
    spark(index) {
      if (!Number.isInteger(index) || index<0 || index>=count) throw new RangeError("FX index out of bounds");
      const v=new DataView(memory.buffer,ptr+FX_LAYOUT.headerBytes+index*FX_LAYOUT.sparkBytes,FX_LAYOUT.sparkBytes);
      return { slot:v.getUint32(0,true),style:v.getUint32(4,true),owner:v.getUint32(8,true),life:v.getUint32(12,true),
        posX:v.getFloat32(16,true),posY:v.getFloat32(20,true),oldPosX:v.getFloat32(24,true),oldPosY:v.getFloat32(28,true),
        lifePrev:v.getUint32(32,true),scaleX:v.getFloat32(36,true),scaleY:v.getFloat32(40,true),rotation:v.getFloat32(44,true),
        tint:v.getUint32(48,true),alpha:v.getUint32(52,true),offsetX:v.getFloat32(56,true),offsetY:v.getFloat32(60,true) };
    },
  };
}
