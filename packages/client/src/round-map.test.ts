import assert from "node:assert/strict";
import test from "node:test";
import { roundMapDisposition } from "./round-map";

test("queued A to B to A epoch handoff discards B before its first render", () => {
  let pending: string | undefined;
  const rendered = "Arena";
  for (const requested of ["Bunker", "Arena"]) {
    const action = roundMapDisposition(rendered, pending, requested);
    if (action === "discard") pending = undefined;
    else if (action === "prepare") pending = requested;
  }
  assert.equal(pending, undefined);
  assert.equal(roundMapDisposition(rendered, "Bunker", "Bunker"), "retain");
  assert.equal(roundMapDisposition(rendered, "Bunker", "Bridge"), "prepare");
  assert.equal(roundMapDisposition(rendered, undefined, "Arena"), "discard");
});
