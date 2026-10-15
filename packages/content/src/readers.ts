import { BinaryReader, type RGBA } from "./binary.ts";
import { ContentError } from "./errors.ts";

export interface PmsVector {
  x: number;
  y: number;
  z: number;
}

export interface PmsVertex extends PmsVector {
  rhw: number;
  color: RGBA;
  u: number;
  v: number;
}

export interface PmsPolygon {
  vertices: [PmsVertex, PmsVertex, PmsVertex];
  normals: [PmsVector, PmsVector, PmsVector];
  polytype: number;
}

export interface PmsProp {
  active: boolean;
  style: number;
  width: number;
  height: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  color: RGBA;
  level: number;
}

export interface PmsWaypoint {
  active: boolean;
  id: number;
  x: number;
  y: number;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jetpack: boolean;
  pathNum: number;
  action: number;
  reserved: number[];
  connectionCount: number;
  /** Used connections, retaining the file's one-based waypoint indices. */
  connections: number[];
  /** All twenty serialized slots, including unused values. */
  connectionSlots: number[];
}

export interface PmsMap {
  version: number;
  description: string;
  texture: string;
  backgroundTop: RGBA;
  backgroundBottom: RGBA;
  startJet: number;
  grenades: number;
  medikits: number;
  weather: number;
  steps: number;
  randomId: number;
  polygons: PmsPolygon[];
  sectors: { division: number; radius: number; cells: number[][] };
  props: PmsProp[];
  scenery: { name: string; date: number }[];
  colliders: { active: boolean; x: number; y: number; radius: number }[];
  spawnpoints: { active: boolean; x: number; y: number; team: number }[];
  waypoints: PmsWaypoint[];
  trailingBytes: number[];
}

function vector(r: BinaryReader): PmsVector {
  return { x: r.f32(), y: r.f32(), z: r.f32() };
}

function vertex(r: BinaryReader): PmsVertex {
  return {
    x: r.f32(), y: r.f32(), z: r.f32(), rhw: r.f32(),
    color: r.rgba(), u: r.f32(), v: r.f32(),
  };
}

/** PMS v11 disk values, before simulation scaling or normal normalization.
 * Shortstrings use the audit's byte-preserving Latin-1 policy. Sector cells are
 * serialized X-major, then Y; sector and scenery references remain one-based.
 */
export function parsePms(bytes: Uint8Array): PmsMap {
  const r = new BinaryReader(bytes, "PMS");
  const version = r.i32();
  if (version !== 11) {
    throw new ContentError("PMS_VERSION", `Unsupported PMS version ${version}; expected 11`, 0);
  }
  const description = r.str(38);
  const texture = r.str(24);
  const backgroundTop = r.rgba();
  const backgroundBottom = r.rgba();
  const startJet = r.i32();
  const grenades = r.u8();
  const medikits = r.u8();
  const weather = r.u8();
  const steps = r.u8();
  const randomId = r.i32();

  const polygonCount = r.count(5000);
  r.need(polygonCount * 121);
  const polygons: PmsPolygon[] = [];
  for (let i = 0; i < polygonCount; i++) {
    polygons.push({
      vertices: [vertex(r), vertex(r), vertex(r)],
      // Magnitudes carry bounce strength; never normalize these vectors here.
      normals: [vector(r), vector(r), vector(r)],
      polytype: r.u8(),
    });
  }

  const division = r.i32();
  const radius = r.count(25);
  const cellCount = (2 * radius + 1) ** 2;
  r.need(cellCount * 2);
  const cells: number[][] = [];
  for (let i = 0; i < cellCount; i++) {
    const countOffset = r.p;
    const count = r.u16();
    if (count > 5000) {
      throw new ContentError("PMS_COUNT", `Sector polygon count ${count} exceeds 5000`, countOffset);
    }
    r.need(count * 2);
    const cell: number[] = [];
    for (let j = 0; j < count; j++) {
      const offset = r.p;
      const index = r.u16();
      if (index < 1 || index > polygonCount) {
        throw new ContentError("PMS_INDEX", `Sector polygon index ${index} outside 1..${polygonCount}`, offset);
      }
      cell.push(index);
    }
    cells.push(cell);
  }

  const propCount = r.count(500);
  r.need(propCount * 44);
  const props: PmsProp[] = [];
  const propsOffset = r.p;
  for (let i = 0; i < propCount; i++) {
    const active = r.u8() !== 0;
    r.skip(1);
    const style = r.u16();
    const width = r.i32();
    const height = r.i32();
    const x = r.f32();
    const y = r.f32();
    const rotation = r.f32();
    const scaleX = r.f32();
    const scaleY = r.f32();
    const alpha = r.u8();
    r.skip(3);
    const color = r.rgba();
    const level = r.u8();
    r.skip(3);
    props.push({ active, style, width, height, x, y, rotation, scaleX, scaleY, alpha, color, level });
  }

  const sceneryCount = r.count(500);
  r.need(sceneryCount * 55);
  const scenery: PmsMap["scenery"] = [];
  for (let i = 0; i < sceneryCount; i++) {
    scenery.push({ name: r.str(50), date: r.i32() });
  }
  for (let i = 0; i < props.length; i++) {
    const prop = props[i]!;
    // Inactive/non-rendering props can retain stale editor indices, as in the
    // original IsPropActive predicate. Only referenced scenery must exist.
    if (prop.active && prop.level <= 2 && (prop.style < 1 || prop.style > sceneryCount)) {
      throw new ContentError("PMS_INDEX", `Prop scenery index ${prop.style} outside 1..${sceneryCount}`, propsOffset + i * 44 + 2);
    }
  }

  const colliderCount = r.count(128);
  r.need(colliderCount * 16);
  const colliders: PmsMap["colliders"] = [];
  for (let i = 0; i < colliderCount; i++) {
    const active = r.u8() !== 0;
    r.skip(3);
    colliders.push({ active, x: r.f32(), y: r.f32(), radius: r.f32() });
  }

  const spawnpointCount = r.count(255);
  r.need(spawnpointCount * 16);
  const spawnpoints: PmsMap["spawnpoints"] = [];
  for (let i = 0; i < spawnpointCount; i++) {
    const active = r.u8() !== 0;
    r.skip(3);
    spawnpoints.push({ active, x: r.i32(), y: r.i32(), team: r.i32() });
  }

  const waypointCount = r.count(5000);
  r.need(waypointCount * 112);
  const waypoints: PmsWaypoint[] = [];
  for (let i = 0; i < waypointCount; i++) {
    const active = r.u8() !== 0;
    r.skip(3);
    const id = r.i32();
    const x = r.i32();
    const y = r.i32();
    const left = r.u8() !== 0;
    const right = r.u8() !== 0;
    const up = r.u8() !== 0;
    const down = r.u8() !== 0;
    const jetpack = r.u8() !== 0;
    const pathNum = r.u8();
    const action = r.u8();
    const reserved = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
    const connectionCount = r.count(20);
    const connectionSlots: number[] = [];
    const connections: number[] = [];
    for (let j = 0; j < 20; j++) {
      const offset = r.p;
      const index = r.i32();
      connectionSlots.push(index);
      if (j < connectionCount) {
        if (index < 1 || index > waypointCount) {
          throw new ContentError("PMS_INDEX", `Waypoint connection ${index} outside 1..${waypointCount}`, offset);
        }
        connections.push(index);
      }
    }
    waypoints.push({
      active, id, x, y, left, right, up, down, jetpack, pathNum, action,
      reserved, connectionCount, connections, connectionSlots,
    });
  }

  return {
    version, description, texture, backgroundTop, backgroundBottom, startJet,
    grenades, medikits, weather, steps, randomId, polygons,
    sectors: { division, radius, cells }, props, scenery, colliders, spawnpoints,
    waypoints, trailingBytes: Array.from(bytes.subarray(r.p)),
  };
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^\d+$/;

function finiteDecimal(value: string, format: string, location: string): number {
  if (!DECIMAL.test(value)) {
    throw new ContentError(`${format}_NUMBER`, `${format}: invalid dot-decimal number ${JSON.stringify(value)} at ${location}`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new ContentError(`${format}_NUMBER`, `${format}: nonfinite number at ${location}`);
  }
  return result;
}

function textLines(bytes: Uint8Array, format: string): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContentError(`${format}_TEXT`, `${format}: invalid UTF-8 text`);
  }
  return text.split(/\r\n|\n|\r/);
}

class PointLines {
  p = 0;
  readonly lines: string[];

  constructor(bytes: Uint8Array, readonly format: string) {
    this.lines = textLines(bytes, format);
  }

  next(): string {
    const value = this.lines[this.p++];
    if (value === undefined) {
      throw new ContentError(`${this.format}_TRUNCATED`, `${this.format}: unexpected end at line ${this.p}`);
    }
    return value.trim();
  }

  number(): number {
    return finiteDecimal(this.next(), this.format, `line ${this.p}`);
  }

  finish(): void {
    while (this.p < this.lines.length) {
      if (this.next() !== "") {
        throw new ContentError(`${this.format}_TRAILING`, `${this.format}: content after ENDFILE at line ${this.p}`);
      }
    }
  }
}

export interface PoaPoint extends PmsVector {
  index: number;
}

export interface PoaAnimation {
  frames: PoaPoint[][];
}

/** Unprojected animation coordinates; no playback or skeleton scaling implied. */
export function parsePoa(bytes: Uint8Array): PoaAnimation {
  const r = new PointLines(bytes, "POA");
  const frames: PoaPoint[][] = [];
  let frame: PoaPoint[] = [];
  let indices = new Set<number>();
  while (true) {
    const line = r.next();
    if (line === "NEXTFRAME" || line === "ENDFILE") {
      if (frame.length === 0) {
        throw new ContentError("POA_FRAME", `POA: empty frame at line ${r.p}`);
      }
      frames.push(frame);
      if (line === "ENDFILE") {
        r.finish();
        return { frames };
      }
      if (frames.length === 40) {
        throw new ContentError("POA_COUNT", "POA: more than 40 frames");
      }
      frame = [];
      indices = new Set<number>();
      continue;
    }
    if (!INTEGER.test(line)) {
      throw new ContentError("POA_INDEX", `POA: invalid point index ${JSON.stringify(line)} at line ${r.p}`);
    }
    const index = Number(line);
    if (index < 1 || index > 20 || indices.has(index)) {
      throw new ContentError("POA_INDEX", `POA: point index ${index} out of range or duplicated at line ${r.p}`);
    }
    indices.add(index);
    frame.push({ index, x: r.number(), y: r.number(), z: r.number() });
  }
}

export interface PoSkeleton {
  points: { name: string; x: number; y: number; z: number }[];
  /** One-based endpoints refer to point file order, not point names. */
  constraints: [number, number][];
}

export function parsePo(bytes: Uint8Array): PoSkeleton {
  const r = new PointLines(bytes, "PO");
  const points: PoSkeleton["points"] = [];
  while (true) {
    const name = r.next();
    if (name === "CONSTRAINTS") break;
    if (name === "" || name === "ENDFILE") {
      throw new ContentError("PO_POINT", `PO: missing point name or CONSTRAINTS at line ${r.p}`);
    }
    points.push({ name, x: r.number(), y: r.number(), z: r.number() });
  }
  const constraints: PoSkeleton["constraints"] = [];
  while (true) {
    const first = r.next();
    if (first === "ENDFILE") {
      r.finish();
      return { points, constraints };
    }
    const second = r.next();
    const endpoints: [number, number] = [0, 0];
    for (const [slot, text] of [first, second].entries()) {
      if (!/^P\d+$/.test(text)) {
        throw new ContentError("PO_INDEX", `PO: invalid constraint endpoint ${JSON.stringify(text)} at line ${r.p - 1 + slot}`);
      }
      const index = Number(text.slice(1));
      if (!Number.isSafeInteger(index) || index < 1 || index > points.length) {
        throw new ContentError("PO_INDEX", `PO: constraint endpoint ${index} outside 1..${points.length}`);
      }
      endpoints[slot] = index;
    }
    constraints.push(endpoints);
  }
}

export type IniData = Record<string, Record<string, string>>;
export type WeaponsIni = Record<string, Record<string, string | number>>;

/** Case-insensitive sections/keys, last assignment wins; values stay strings.
 * Comments occupy whole lines. Semicolons, hashes and equals in values are data.
 * Null-prototype records allow arbitrary content keys without prototype mutation.
 */
export function parseIni(bytes: Uint8Array): IniData {
  const result = Object.create(null) as IniData;
  let section: Record<string, string> | undefined;
  const lines = textLines(bytes, "INI");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const match = /^\[([^\[\]]+)\]\s*(?:[;#].*)?$/.exec(line);
      const name = match?.[1]?.trim().toLowerCase();
      if (!name) throw new ContentError("INI_SECTION", `INI: malformed section at line ${i + 1}`);
      section = result[name] ?? (result[name] = Object.create(null) as Record<string, string>);
      continue;
    }
    const equal = line.indexOf("=");
    const key = line.slice(0, equal).trim().toLowerCase();
    if (equal < 1 || key === "") {
      throw new ContentError("INI_KEY", `INI: malformed assignment at line ${i + 1}`);
    }
    if (section === undefined) {
      section = result[""] ?? (result[""] = Object.create(null) as Record<string, string>);
    }
    section[key] = line.slice(equal + 1).trim();
  }
  return result;
}

export function parseModIni(bytes: Uint8Array): IniData {
  return parseIni(bytes);
}

const WEAPON_NUMBERS: Record<string, true> = {
  damage: true, fireinterval: true, ammo: true, reloadtime: true, speed: true,
  bulletstyle: true, startuptime: true, bink: true, movementacc: true,
  bulletspread: true, recoil: true, push: true, inheritedvelocity: true,
  modifierlegs: true, modifierchest: true, modifierhead: true, nocollision: true,
};

/** Metadata stays textual, while recognized weapon numbers require a complete,
 * finite dot-decimal token (never parseFloat-style partial or locale parsing).
 * Unknown keys retain text unless their entire value is numeric.
 */
export function parseWeaponsIni(bytes: Uint8Array): WeaponsIni {
  const parsed = parseIni(bytes);
  const result = Object.create(null) as WeaponsIni;
  for (const [name, entries] of Object.entries(parsed)) {
    const section = Object.create(null) as Record<string, string | number>;
    for (const [key, value] of Object.entries(entries)) {
      section[key] = name !== "info" && (Object.hasOwn(WEAPON_NUMBERS, key) || DECIMAL.test(value))
        ? finiteDecimal(value, "WEAPONS_INI", `[${name}] ${key}`)
        : value;
    }
    result[name] = section;
  }
  return result;
}
