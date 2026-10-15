import assert from "node:assert/strict";
import test from "node:test";
import { RENDER_LAYOUT, SIM_ABI_VERSION, SimHost, type SimExports } from "@soldat-web/sim-host";
import { SimWorldView } from "./world";

test("borrowed render publication refreshes after non-tick WASM memory growth", () => {
  const memory = new WebAssembly.Memory({ initial: 2 }), pointer = 4;
  const data = new DataView(memory.buffer, pointer), h = RENDER_LAYOUT.header;
  for (const [offset, value] of [[h.version, SIM_ABI_VERSION], [h.slots, RENDER_LAYOUT.slots], [h.spriteStride, RENDER_LAYOUT.spriteBytes], [h.bulletsOffset, RENDER_LAYOUT.bulletsOffset], [h.thingsOffset, RENDER_LAYOUT.thingsOffset], [h.totalBytes, RENDER_LAYOUT.totalBytes]]) data.setUint32(offset!, value!, true);
  data.setUint32(RENDER_LAYOUT.bulletsOffset + 4, RENDER_LAYOUT.bulletBytes, true);
  data.setUint32(RENDER_LAYOUT.thingsOffset + 4, RENDER_LAYOUT.thingBytes, true);
  const host = new SimHost({ memory, sim_render_view: () => pointer } as SimExports, () => "");
  const world = new SimWorldView(host), before = world.renderView;
  memory.grow(1); // Save/hash/diagnostic allocations can grow between ticks.
  const after = world.renderView;
  assert.notEqual(after, before);
  assert.equal(after.bytes.buffer, memory.buffer);
  assert.equal(after.bytes.byteLength, RENDER_LAYOUT.totalBytes);
  assert.equal(after.bulletCount, 0); assert.equal(after.thingCount, 0);
  assert.equal(world.ceaseFireTime, 0);
});
