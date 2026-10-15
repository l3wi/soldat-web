import { ContentError } from './errors.ts';
export type RGBA = [number, number, number, number];
export class BinaryReader {
  p = 0;
  readonly view: DataView;
  constructor(public readonly bytes: Uint8Array, public readonly format: string) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.bytes.length - this.p)
      throw new ContentError('TRUNCATED', `${this.format}: need ${n} bytes`, this.p);
  }
  skip(n: number): void { this.need(n); this.p += n; }
  u8(): number { this.need(1); return this.view.getUint8(this.p++); }
  u16(): number { this.need(2); const v = this.view.getUint16(this.p, true); this.p += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.p, true); this.p += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.p, true); this.p += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.p, true); this.p += 4; return v; }
  f32(): number {
    this.need(4); const v = this.view.getFloat32(this.p, true); this.p += 4;
    if (!Number.isFinite(v)) throw new ContentError('NON_FINITE', this.format, this.p - 4);
    return v;
  }
  str(n: number): string {
    const len = this.u8(); this.need(n);
    if (len > n) throw new ContentError('SHORTSTRING', `${len} exceeds ${n}`, this.p - 1);
    let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(this.bytes[this.p + i]!);
    this.p += n; return s;
  }
  count(max: number): number {
    const v = this.i32();
    if (v < 0 || v > max) throw new ContentError('COUNT', `${v} outside 0..${max}`, this.p - 4);
    return v;
  }
  rgba(): RGBA { const b = this.u8(), g = this.u8(), r = this.u8(), a = this.u8(); return [r, g, b, a]; }
}
