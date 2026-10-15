#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const [command, leftPath, rightPath] = process.argv.slice(2);
if (!['summary', 'diff'].includes(command) || !leftPath || (command === 'diff' && !rightPath)) {
  console.error('Usage: node tools/oracle/trace.mjs summary TRACE | diff EXPECTED ACTUAL');
  process.exit(2);
}
async function* rows(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line);
}
function difference(a, b, path = '$') {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return { path, expected: a, actual: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, expected: a, actual: b };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // Decimal values are descriptive; the bit pattern is authoritative.
    if (key === 'decimal' && 'bits' in a && 'bits' in b) continue;
    const found = difference(a[key], b[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}
if (command === 'diff') {
  const left = rows(leftPath), right = rows(rightPath);
  let line = 0;
  for (;;) {
    const [a, b] = await Promise.all([left.next(), right.next()]);
    line++;
    if (a.done && b.done) { console.log(`Identical state: ${line - 1} records`); break; }
    const found = difference(a.value, b.value);
    if (a.done !== b.done || found) {
      console.error(JSON.stringify({ line, tick: a.value?.tick ?? b.value?.tick, stage: a.value?.stage ?? b.value?.stage, ...(found ?? { path: '$', expected: a.value, actual: b.value }) }));
      process.exitCode = 1;
      break;
    }
  }
} else {
  let header, states = 0, tickStates = 0, minFuel = Infinity, maxFuel = -Infinity;
  let firstEmptyTick = null, last, firstGroundedAfterEmpty = null;
  for await (const row of rows(leftPath)) {
    if (row.type === 'header') { header = row; continue; }
    states++;
    if (row.stage !== 'tick') continue;
    tickStates++;
    for (const sprite of row.sprites) {
      minFuel = Math.min(minFuel, sprite.jetsCount);
      maxFuel = Math.max(maxFuel, sprite.jetsCount);
      if (sprite.jetsCount === 0 && firstEmptyTick === null) firstEmptyTick = row.tick;
      if (firstEmptyTick !== null && row.tick > firstEmptyTick && sprite.onGround && firstGroundedAfterEmpty === null) firstGroundedAfterEmpty = row.tick;
    }
    last = row;
  }
  console.log(JSON.stringify({ header, states, ticks: tickStates, minFuel, maxFuel, firstEmptyTick, firstGroundedAfterEmpty, final: last?.sprites.map(s => ({ id: s.id, pos: s.particle.pos, onGround: s.onGround, jetsCount: s.jetsCount, dead: s.dead })) }, null, 2));
}
