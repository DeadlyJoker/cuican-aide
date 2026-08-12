import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";

test("canonical JSON preserves prototype-like own keys", () => {
  const input = Object.fromEntries([
    ["z", 1],
    ["__proto__", { safe: true }],
  ]);

  assert.equal(canonicalJson(input), '{"__proto__":{"safe":true},"z":1}');
});

test("canonical JSON rejects malformed Unicode values and keys", () => {
  for (const input of ["\ud800", Object.fromEntries([["\udc00", true]])]) {
    assert.throws(
      () => canonicalJson(input),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "command_non_json_value",
    );
  }
});
