import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { ContentError } from "./errors.ts";
import {
  parseIni, parseModIni, parsePms, parsePo, parsePoa, parseWeaponsIni,
  type PmsMap,
} from "./readers.ts";

const base = new URL("../../../reference/base/", import.meta.url);
const mapBytes = new Uint8Array(await readFile(new URL("shared/maps/Aero.pms", base)));
const map = parsePms(mapBytes);
const encoder = new TextEncoder();

// Locate variable-length sections from the parsed real fixture, not assumptions
// about one particular map's number of polygons, sectors or props.
function sectionOffsets(parsed: PmsMap) {
  let p = 92 + parsed.polygons.length * 121;
  const sectors = p;
  p += 8;
  let firstSectorIndex = -1;
  for (const cell of parsed.sectors.cells) {
    if (cell.length > 0 && firstSectorIndex < 0) firstSectorIndex = p + 2;
    p += 2 + cell.length * 2;
  }
  const props = p;
  p += 4 + parsed.props.length * 44;
  const scenery = p;
  p += 4 + parsed.scenery.length * 55;
  const colliders = p;
  p += 4 + parsed.colliders.length * 16;
  const spawnpoints = p;
  p += 4 + parsed.spawnpoints.length * 16;
  const waypoints = p;
  p += 4 + parsed.waypoints.length * 112;
  return { sectors, firstSectorIndex, props, scenery, colliders, spawnpoints, waypoints, end: p };
}

const offsets = sectionOffsets(map);

describe("PMS v11", () => {
  test("reads the real map's complete structured sections", () => {
    expect(map.version).toBe(11);
    expect(typeof map.description).toBe("string");
    expect(typeof map.texture).toBe("string");
    expect(map.polygons.length).toBe(290);
    expect(map.props.length).toBe(145);
    expect(map.waypoints.length).toBe(99);
    expect(map.sectors.radius).toBe(25);
    expect(map.sectors.cells.length).toBe(51 * 51);
    expect(map.polygons[0]!.vertices.length).toBe(3);
    expect(map.polygons[0]!.normals.length).toBe(3);
    expect(map.backgroundTop.length).toBe(4);
    for (const waypoint of map.waypoints) {
      expect(waypoint.connectionSlots.length).toBe(20);
      expect(waypoint.connections.length).toBe(waypoint.connectionCount);
      expect(waypoint.reserved.length).toBe(5);
    }
  });

  test("accepts and preserves the exact reference trailer and appended bytes", () => {
    expect(map.trailingBytes.length).toBe(280);
    expect(map.trailingBytes).toEqual(Array.from(mapBytes.subarray(offsets.end)));
    const extended = new Uint8Array(mapBytes.length + 5);
    extended.set(mapBytes);
    extended.set([0, 255, 13, 10, 128], mapBytes.length);
    expect(parsePms(extended).trailingBytes).toEqual([...map.trailingBytes, 0, 255, 13, 10, 128]);
    expect(parsePms(mapBytes.subarray(0, offsets.end)).trailingBytes).toEqual([]);
  });

  test("reads BGRA as RGBA and retains raw normals, UVs and negative scales", () => {
    const bytes = mapBytes.slice();
    const view = new DataView(bytes.buffer);
    bytes.set([1, 2, 3, 4], 68);
    bytes.set([5, 6, 7, 8], 92 + 16);
    view.setFloat32(92 + 20, -7.25, true);
    view.setFloat32(92 + 24, 9.5, true);
    view.setFloat32(92 + 108, 3, true);
    view.setFloat32(92 + 112, 4, true);
    view.setFloat32(offsets.props + 4 + 24, -2, true);
    const parsed = parsePms(bytes);
    expect(parsed.backgroundTop).toEqual([3, 2, 1, 4]);
    expect(parsed.polygons[0]!.vertices[0].color).toEqual([7, 6, 5, 8]);
    expect(parsed.polygons[0]!.vertices[0].u).toBe(-7.25);
    expect(parsed.polygons[0]!.vertices[0].v).toBe(9.5);
    expect(parsed.polygons[0]!.normals[2].x).toBe(3);
    expect(parsed.polygons[0]!.normals[2].y).toBe(4);
    expect(parsed.props[0]!.scaleX).toBe(-2);
  });

  test("preserves waypoint metadata, unused slots and reserved bytes", () => {
    const bytes = mapBytes.slice();
    const view = new DataView(bytes.buffer);
    const waypoint = offsets.waypoints + 4;
    bytes[waypoint + 21] = 7;
    bytes[waypoint + 22] = 6;
    bytes.set([1, 2, 3, 4, 5], waypoint + 23);
    view.setInt32(waypoint + 28, 1, true);
    view.setInt32(waypoint + 32, map.waypoints.length, true);
    view.setInt32(waypoint + 32 + 19 * 4, -123456, true);
    const parsed = parsePms(bytes).waypoints[0]!;
    expect(parsed.pathNum).toBe(7);
    expect(parsed.action).toBe(6);
    expect(parsed.reserved).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.connections).toEqual([map.waypoints.length]);
    expect(parsed.connectionSlots[19]).toBe(-123456);
  });

  test("uses the Uint8Array view boundaries and does not mutate input", () => {
    const storage = new Uint8Array(mapBytes.length + 11);
    storage.set(mapBytes, 7);
    const before = storage.slice();
    expect(parsePms(storage.subarray(7, 7 + mapBytes.length))).toEqual(map);
    expect(storage).toEqual(before);
    expect(() => parsePms(storage.subarray(7, 10))).toThrow(ContentError);
  });

  test("uses byte-preserving Latin-1 for legacy shortstrings", () => {
    const bytes = mapBytes.slice();
    bytes[4] = 2;
    bytes[5] = 0x80;
    bytes[6] = 0xe9;
    expect(parsePms(bytes).description).toBe("\u0080é");
  });

  test("rejects real fixture truncation with typed errors", () => {
    for (const end of [0, 3, 4, 42, 67, 87, 91, 92, 212, offsets.props + 3, offsets.scenery + 4, offsets.end - 1]) {
      expect(() => parsePms(mapBytes.subarray(0, end))).toThrow(ContentError);
    }
  });

  test("rejects unsupported versions and malformed shortstring lengths", () => {
    const version = mapBytes.slice();
    new DataView(version.buffer).setInt32(0, 10, true);
    expect(() => parsePms(version)).toThrow(ContentError);
    for (const [offset, value] of [[4, 39], [43, 25], [offsets.scenery + 4, 51]]) {
      const bytes = mapBytes.slice();
      bytes[offset!] = value!;
      expect(() => parsePms(bytes)).toThrow(ContentError);
    }
  });

  test("rejects nonfinite float fields rather than silently propagating them", () => {
    for (const offset of [92, 92 + 12, 92 + 20, 92 + 84, offsets.props + 4 + 24, offsets.colliders + 4 + 4]) {
      for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const bytes = mapBytes.slice();
        new DataView(bytes.buffer).setFloat32(offset, invalid, true);
        expect(() => parsePms(bytes)).toThrow(ContentError);
      }
    }
  });

  test("rejects negative and excessive section/connection counts", () => {
    const counts = [
      [88, 5000], [offsets.sectors + 4, 25], [offsets.props, 500],
      [offsets.scenery, 500], [offsets.colliders, 128], [offsets.spawnpoints, 255],
      [offsets.waypoints, 5000], [offsets.waypoints + 4 + 28, 20],
    ];
    for (const [offset, max] of counts) {
      for (const invalid of [-1, max! + 1]) {
        const bytes = mapBytes.slice();
        new DataView(bytes.buffer).setInt32(offset!, invalid, true);
        expect(() => parsePms(bytes)).toThrow(ContentError);
      }
    }
    const sector = mapBytes.slice();
    new DataView(sector.buffer).setUint16(offsets.sectors + 8, 5001, true);
    expect(() => parsePms(sector)).toThrow(ContentError);
  });

  test("rejects invalid polygon, rendering scenery and waypoint references", () => {
    expect(offsets.firstSectorIndex).toBeGreaterThan(0);
    for (const invalid of [0, map.polygons.length + 1]) {
      const bytes = mapBytes.slice();
      new DataView(bytes.buffer).setUint16(offsets.firstSectorIndex, invalid, true);
      expect(() => parsePms(bytes)).toThrow(ContentError);
    }
    for (const invalid of [0, map.scenery.length + 1]) {
      const bytes = mapBytes.slice();
      bytes[offsets.props + 4] = 1;
      bytes[offsets.props + 4 + 40] = 0;
      new DataView(bytes.buffer).setUint16(offsets.props + 4 + 2, invalid, true);
      expect(() => parsePms(bytes)).toThrow(ContentError);
    }
    for (const invalid of [0, -1, map.waypoints.length + 1]) {
      const bytes = mapBytes.slice();
      const view = new DataView(bytes.buffer);
      view.setInt32(offsets.waypoints + 4 + 28, 1, true);
      view.setInt32(offsets.waypoints + 4 + 32, invalid, true);
      expect(() => parsePms(bytes)).toThrow(ContentError);
    }
  });
});

describe("POA and PO", () => {
  test("preserves unprojected coordinates and one-based point indices", () => {
    expect(parsePoa(encoder.encode("1\r\n1.25\r\n-2\r\n3e-2\r\nNEXTFRAME\r\n20\r\n0\r\n1\r\n2\r\nENDFILE\r\n"))).toEqual({
      frames: [[{ index: 1, x: 1.25, y: -2, z: 0.03 }], [{ index: 20, x: 0, y: 1, z: 2 }]],
    });
    expect(parsePo(encoder.encode("P2\n1\n2\n3\nP1\n-4\n5\n6\nCONSTRAINTS\nP1\nP2\nENDFILE"))).toEqual({
      points: [{ name: "P2", x: 1, y: 2, z: 3 }, { name: "P1", x: -4, y: 5, z: 6 }],
      constraints: [[1, 2]],
    });
  });

  test("accepts forty frames and rejects a forty-first", () => {
    const frame = "1\n0\n0\n0\n";
    expect(parsePoa(encoder.encode(Array(40).fill(frame).join("NEXTFRAME\n") + "ENDFILE")).frames.length).toBe(40);
    expect(() => parsePoa(encoder.encode(Array(41).fill(frame).join("NEXTFRAME\n") + "ENDFILE"))).toThrow(ContentError);
  });

  test("rejects duplicate/out-of-range indices, empty frames and truncation", () => {
    for (const text of [
      "0\n0\n0\n0\nENDFILE", "21\n0\n0\n0\nENDFILE",
      "1\n0\n0\n0\n1\n1\n2\n3\nENDFILE", "ENDFILE",
      "NEXTFRAME\nENDFILE", "1\n0\n0\n0\nNEXTFRAME\nENDFILE",
      "1\n0\n0", "1\n0\n0\n0", "1\n0\n0\n0\nENDFILE\njunk",
    ]) {
      expect(() => parsePoa(encoder.encode(text))).toThrow(ContentError);
    }
    for (const text of [
      "P1\n0\n0", "P1\n0\n0\n0\nENDFILE",
      "P1\n0\n0\n0\nCONSTRAINTS\nP1", "P1\n0\n0\n0\nCONSTRAINTS\nP0\nP1\nENDFILE",
      "P1\n0\n0\n0\nCONSTRAINTS\nP1\nP2\nENDFILE",
      "P1\n0\n0\n0\nCONSTRAINTS\n1\nP1\nENDFILE",
    ]) {
      expect(() => parsePo(encoder.encode(text))).toThrow(ContentError);
    }
  });

  test("numeric tokens must be complete finite dot-decimal numbers", () => {
    for (const value of ["", "NaN", "Infinity", "1e999", "1,5", "0x10", "1tail", "--1"]) {
      expect(() => parsePoa(encoder.encode(`1\n${value}\n0\n0\nENDFILE`))).toThrow(ContentError);
      expect(() => parsePo(encoder.encode(`P1\n${value}\n0\n0\nCONSTRAINTS\nENDFILE`))).toThrow(ContentError);
    }
  });
});

describe("INI content", () => {
  test("normalizes names, preserves string values and merges repeated sections", () => {
    const bytes = encoder.encode("\ufeff; comment\r\n[ScAlE]\r\nDefaultScale = 4.5\r\n[scale]\r\nPath=A=B;#C\r\nDEFAULTSCALE=2\r\n[GOSTEK]\r\nHead_CenterX=.5\r\n");
    const result = parseIni(bytes);
    expect(result["scale"]).toEqual({ defaultscale: "2", path: "A=B;#C" });
    expect(result["gostek"]).toEqual({ head_centerx: ".5" });
    expect(parseModIni(bytes)).toEqual(result);
    expect(parseIni(encoder.encode("Root=7\nEmpty=\n"))[""]).toEqual({ root: "7", empty: "" });
  });

  test("content keys cannot mutate object prototypes", () => {
    const result = parseIni(encoder.encode("[__proto__]\n__proto__=safe\nconstructor=also safe\n"));
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(result["__proto__"]!)).toBeNull();
    expect(result["__proto__"]!["__proto__"]).toBe("safe");
    expect(result["__proto__"]!["constructor"]).toBe("also safe");
  });

  test("rejects malformed syntax and invalid text with ContentError", () => {
    for (const text of ["[missing", "[]=x", "[a]\n=value", "[a]\nnot an assignment"]) {
      expect(() => parseIni(encoder.encode(text))).toThrow(ContentError);
    }
    expect(() => parseIni(new Uint8Array([0xff]))).toThrow(ContentError);
  });

  test("weapon metadata remains string-valued while numeric fields are numbers", async () => {
    const result = parseWeaponsIni(new Uint8Array(await readFile(new URL("server/configs/weapons.ini", base))));
    expect(result["info"]!["name"]).toBe("Default mod");
    expect(result["info"]!["version"]).toBe("1.7.1");
    expect(result["desert eagles"]!["damage"]).toBe(1.81);
    expect(result["desert eagles"]!["fireinterval"]).toBe(24);
    const custom = parseWeaponsIni(encoder.encode("[Info]\nName=123\nVersion=2\n[Weapon]\nDamage=.25\nBink=-4\nSpeed=1e1\nLabel=text\nExtra=5\n"));
    expect(custom["info"]).toEqual({ name: "123", version: "2" });
    expect(custom["weapon"]).toEqual({ damage: 0.25, bink: -4, speed: 10, label: "text", extra: 5 });
  });

  test("rejects malformed known weapon numbers without locale-dependent coercion", () => {
    for (const value of ["", "1,81", "1.2text", "NaN", "Infinity", "0x10", "1e999"]) {
      expect(() => parseWeaponsIni(encoder.encode(`[Info]\nName=mod\nVersion=1\n[Desert Eagles]\nDamage=${value}`))).toThrow(ContentError);
    }
  });
});

test("parses all 99 maps, 51 animations and 6 skeletons in the reference corpus", async () => {
  const groups = [
    { directory: "shared/maps/", extension: ".pms", expected: 99, parse: parsePms },
    { directory: "shared/anims/", extension: ".poa", expected: 51, parse: parsePoa },
    { directory: "shared/objects/", extension: ".po", expected: 6, parse: parsePo },
  ];
  for (const group of groups) {
    const directory = new URL(group.directory, base);
    const files = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(group.extension));
    expect(files.length).toBe(group.expected);
    for (const file of files) {
      const bytes = new Uint8Array(await readFile(new URL(file, directory)));
      expect(group.parse(bytes)).toBeDefined();
    }
  }
});
