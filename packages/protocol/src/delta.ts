import { LIMITS, MAX_STATE_BYTES, ProtocolError } from "./messages.ts";

const EMPTY = new Uint8Array(0);
const LITERAL = 0x80000000;
const MIN_ZERO_RUN = 8;

/** Walk zero/literal spans without materializing an XOR buffer. */
function spans(state: Uint8Array, baseline: Uint8Array, emit: (start: number, end: number, literal: boolean) => void): void {
  let position = 0, literalStart = 0;
  while (position < state.length) {
    if ((state[position]! ^ (baseline[position] ?? 0)) !== 0) { position++; continue; }
    const zeroStart = position;
    while (position < state.length && (state[position]! ^ (baseline[position] ?? 0)) === 0) position++;
    if (position - zeroStart < MIN_ZERO_RUN) continue;
    if (literalStart < zeroStart) emit(literalStart, zeroStart, true);
    emit(zeroStart, position, false);
    literalStart = position;
  }
  if (literalStart < position) emit(literalStart, position, true);
}
/** Baseline bytes beyond its end are zero; output length is independent of baseline length. */
export function encodeDelta(state: Uint8Array, baseline: Uint8Array = EMPTY): Uint8Array {
  if (state.length > MAX_STATE_BYTES || baseline.length > MAX_STATE_BYTES) throw new ProtocolError("OVERSIZED", "State exceeds delta limit");
  let encodedSize = 5;
  spans(state, baseline, (start, end, literal) => { encodedSize += 4 + (literal ? end - start : 0); });
  const rle = encodedSize < state.length + 5;
  const result = new Uint8Array(rle ? encodedSize : state.length + 5);
  const view = new DataView(result.buffer);
  view.setUint8(0, rle ? 1 : 0); view.setUint32(1, state.length, true);
  if (!rle) {
    for (let i = 0; i < state.length; i++) result[i + 5] = state[i]! ^ (baseline[i] ?? 0);
  } else {
    let offset = 5;
    spans(state, baseline, (start, end, literal) => {
      view.setUint32(offset, (literal ? LITERAL : 0) + end - start, true); offset += 4;
      if (literal) for (let i = start; i < end; i++) result[offset++] = state[i]! ^ (baseline[i] ?? 0);
    });
  }
  return result;
}
/** Validate framing without allocating or requiring baseline bytes. Returns decoded byte length. */
export function validateDelta(delta: Uint8Array): number {
  try {
    if (delta.length > LIMITS.delta) throw new ProtocolError("OVERSIZED", "Delta exceeds limit");
    if (delta.length < 5) throw new ProtocolError("DELTA", "Truncated delta header");
    const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
    const mode = view.getUint8(0), length = view.getUint32(1, true);
    if (length > MAX_STATE_BYTES) throw new ProtocolError("OVERSIZED", "Decoded state exceeds limit");
    if (mode !== 0 && mode !== 1) throw new ProtocolError("DELTA", "Unknown delta mode");
    if (mode === 0 && delta.length !== length + 5) throw new ProtocolError("DELTA", "Raw XOR length mismatch");
    if (mode === 1) {
      let position = 0, offset = 5;
      while (offset < delta.length) {
        if (delta.length - offset < 4) throw new ProtocolError("DELTA", "Truncated run", offset);
        const token = view.getUint32(offset, true), count = token & 0x7fffffff; offset += 4;
        if (count === 0 || count > length - position) throw new ProtocolError("DELTA", "Invalid run length", offset - 4);
        position += count;
        if (token >= LITERAL) {
          if (count > delta.length - offset) throw new ProtocolError("DELTA", "Truncated literal", offset);
          offset += count;
        }
      }
      if (position !== length) throw new ProtocolError("DELTA", "Runs do not cover output");
    }
    return length;
  } catch (cause) {
    if (cause instanceof ProtocolError) throw cause;
    throw new ProtocolError("DELTA", "Malformed delta", 0, { cause });
  }
}

/** Reject malformed runs before allocating output. A missing acknowledged baseline is a caller error. */
export function decodeDelta(delta: Uint8Array, baseline: Uint8Array = EMPTY): Uint8Array {
  try {
    if (baseline.length > MAX_STATE_BYTES) throw new ProtocolError("OVERSIZED", "Baseline exceeds limit");
    const length = validateDelta(delta);
    const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength), mode = view.getUint8(0);
    const output = new Uint8Array(length);
    output.set(baseline.subarray(0, length));
    if (mode === 0) {
      for (let i = 0; i < length; i++) output[i] = output[i]! ^ delta[i + 5]!;
    } else {
      let position = 0, offset = 5;
      while (offset < delta.length) {
        const token = view.getUint32(offset, true), count = token & 0x7fffffff; offset += 4;
        if (token >= LITERAL) for (let i = 0; i < count; i++) { output[position + i] = output[position + i]! ^ delta[offset++]!; }
        position += count;
      }
    }
    return output;
  } catch (cause) {
    if (cause instanceof ProtocolError) throw cause;
    throw new ProtocolError("DELTA", "Malformed delta", 0, { cause });
  }
}
