import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonValue } from "./canonical-json.ts";

test("canonical JSON uses deterministic code-unit ordering and own prototype-like keys", () => {
  const value = Object.create(null) as Record<string, unknown>;
  value.z = 1;
  value.__proto__ = { safe: true };
  value.a = 2;
  assert.equal(
    canonicalJsonValue(value),
    '{"__proto__":{"safe":true},"a":2,"z":1}',
  );
});

test("canonical JSON rejects malformed Unicode, undefined, cycles, and excessive depth", () => {
  assert.throws(() => canonicalJsonValue("\ud800"), TypeError);
  assert.throws(() => canonicalJsonValue({ value: undefined }), TypeError);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJsonValue(cycle), TypeError);
  let deep: unknown = null;
  for (let index = 0; index < 34; index += 1) deep = [deep];
  assert.throws(() => canonicalJsonValue(deep), TypeError);
});
