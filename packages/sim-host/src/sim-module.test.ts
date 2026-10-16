import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadSim } from './sim';

test('one compiled module creates independent match memory and hosts', async () => {
  const bytes = await readFile(new URL('../../../build-out/sim/sim.wasm', import.meta.url));
  const module = await WebAssembly.compile(bytes);
  const first = await loadSim(module), second = await loadSim(module);
  try {
    assert.notEqual(first, second);
    assert.notEqual(first.exports.memory, second.exports.memory);
    const length = second.exports.memory.buffer.byteLength;
    first.exports.memory.grow(1);
    assert.equal(second.exports.memory.buffer.byteLength, length);
    assert.equal(first.exports.memory.buffer.byteLength, length + 65536);
  } finally { first.dispose(); second.dispose(); }
});
