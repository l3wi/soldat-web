#!/usr/bin/env node
// FPC bcd728860dcd953cb6f3bbda788eab07b0d16c85, compiler/ogwasm.pas:
// WriteNameSection uses current_module.exefilename without a separate name option.
// Replace only name subsection 0 and its enclosing lengths; retain every symbol
// subsection and every other section verbatim. This is not a general path scrubber.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function normalize(bytes, filename, publicName) {
  const header = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  if (!bytes.subarray(0, 8).equals(header)) throw new Error('Expected a WebAssembly version 1 module');
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let offset = 8;
  let replacement;
  let nameSections = 0;

  function u32(end) {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      if (offset >= end) throw new Error('Truncated unsigned LEB128');
      const byte = bytes[offset++];
      if (index === 4 && (byte & 0xf0) !== 0) throw new Error('Unsigned LEB128 exceeds u32');
      value += (byte & 0x7f) * 2 ** (index * 7);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Invalid unsigned LEB128');
  }

  function name(end) {
    const size = u32(end);
    if (size > end - offset) throw new Error('Name exceeds its containing section');
    const value = utf8.decode(bytes.subarray(offset, offset + size));
    offset += size;
    return value;
  }

  while (offset < bytes.length) {
    const id = bytes[offset++];
    if (id > 13) throw new Error('Unrecognized WebAssembly section ID');
    const sizeStart = offset;
    const size = u32(bytes.length);
    const payloadStart = offset;
    if (size > bytes.length - offset) throw new Error('Section exceeds module length');
    const end = offset + size;
    if (id === 0 && name(end) === 'name') {
      if (++nameSections !== 1) throw new Error('Expected exactly one custom name section');
      let previousId = -1;
      while (offset < end) {
        const start = offset;
        const subsectionId = bytes[offset++];
        if (subsectionId <= previousId) throw new Error('Duplicate or out-of-order name subsection');
        previousId = subsectionId;
        const subsectionSize = u32(end);
        if (subsectionSize > end - offset) throw new Error('Name subsection exceeds section length');
        const subsectionEnd = offset + subsectionSize;
        if (subsectionId === 0) {
          const originalName = name(subsectionEnd);
          if (offset !== subsectionEnd) throw new Error('Trailing bytes in module-name subsection');
          if (originalName !== publicName && resolve(originalName) !== resolve(filename)) {
            throw new Error('Module name does not match the linked output filename');
          }
          replacement = { sizeStart, payloadStart, start, subsectionEnd, end };
        }
        offset = subsectionEnd;
      }
    }
    offset = end;
  }
  if (nameSections !== 1 || !replacement) throw new Error('Missing expected module-name metadata');

  function encodeU32(value) {
    const encoded = [];
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      encoded.push(byte | (value ? 0x80 : 0));
    } while (value);
    return Buffer.from(encoded);
  }

  const publicBytes = Buffer.from(publicName, 'utf8');
  const moduleName = Buffer.concat([encodeU32(publicBytes.length), publicBytes]);
  const { sizeStart, payloadStart, start, subsectionEnd, end } = replacement;
  const payload = Buffer.concat([
    bytes.subarray(payloadStart, start),
    Buffer.from([0]), encodeU32(moduleName.length), moduleName,
    bytes.subarray(subsectionEnd, end),
  ]);
  return Buffer.concat([
    bytes.subarray(0, sizeStart), encodeU32(payload.length), payload, bytes.subarray(end),
  ]);
}

const [filename, publicName, ...extra] = process.argv.slice(2);
if (!filename || !publicName || extra.length || !/^[a-z][a-z0-9-]*\.wasm$/.test(publicName) ||
    basename(filename) !== publicName) {
  console.error('Usage: node sim/build/normalize-wasm-name.mjs WASM PUBLIC_BASENAME.wasm');
  process.exitCode = 2;
} else {
  try {
    const original = await readFile(filename);
    const normalized = normalize(original, filename, publicName);
    if (!normalized.equals(original)) await writeFile(filename, normalized);
  } catch (error) {
    console.error(`WASM module-name normalization failed: ${error.message}`);
    process.exitCode = 1;
  }
}
