#!/usr/bin/env python3
"""Write a tiny original test PMS, never modify a shipped map.

Matches the render spike's Synthetic scene exactly: one triangle, NPOT desert
terrain, varying vertex alpha, out-of-range UV, solid RGB32 background.
"""
from pathlib import Path
import struct


def shortstring(text, capacity):
    encoded = text.encode('ascii')
    assert len(encoded) <= capacity
    return bytes([len(encoded)]) + encoded.ljust(capacity, b'\0')


def color(r, g, b, a):
    return bytes((b, g, r, a))


def vertex(x, y, u, v, rgba):
    return struct.pack('<4f', x, y, 0, 1) + color(*rgba) + struct.pack('<2f', u, v)


out = Path('build-out/refclient/data/maps/Synthetic.pms')
out.parent.mkdir(parents=True, exist_ok=True)
blob = struct.pack('<i', 11)
blob += shortstring('Render spike synthetic alpha repeat', 38)
blob += shortstring('mtex_desert.bmp', 24)
blob += color(32, 32, 32, 255) * 2
blob += struct.pack('<i4Bi', 0, 0, 0, 0, 0, 0)
blob += struct.pack('<i', 1)
blob += vertex(-240, -180, -26.75, -27.25, (255, 0, 0, 255))
blob += vertex(240, -180, 27.25, -27.25, (0, 255, 0, 0))
blob += vertex(0, 180, .25, 28.75, (0, 0, 255, 128))
# Three finite unit normals; no simulation/collision is advanced for this map.
blob += struct.pack('<9fB', 0, -1, 0, .8320503, .5547002, 0, -.8320503, .5547002, 0, 0)
# Standard 51x51 sector grid. Empty lists suffice for this render-only fixture.
blob += struct.pack('<ii', 25, 25) + struct.pack('<H', 0) * (51 * 51)
# Props, scenery declarations, colliders, spawnpoints, waypoints.
blob += struct.pack('<5i', 0, 0, 0, 0, 0)
out.write_bytes(blob)
print(out)
