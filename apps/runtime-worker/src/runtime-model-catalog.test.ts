import assert from "node:assert/strict";
import test from "node:test";

import {
  modelVariantAgentVersionId,
  runtimeModelCatalog,
} from "./runtime-model-catalog.ts";

test("keeps the configured model first and admits bounded agent models", () => {
  assert.deepEqual(
    runtimeModelCatalog(
      JSON.stringify([
        "gpt-5.6-sol",
        "gpt-5.5",
        "gpt-image-2",
        "text-embedding-3-large",
        "claude-opus-4-8",
        "gpt-5.6-sol",
      ]),
      "gpt-5.5",
    ),
    ["gpt-5.5", "gpt-5.6-sol", "claude-opus-4-8"],
  );
});

test("fails closed to the configured model for malformed catalogs", () => {
  assert.deepEqual(runtimeModelCatalog("not-json", "gpt-5.5"), ["gpt-5.5"]);
  assert.deepEqual(
    runtimeModelCatalog(
      JSON.stringify(new Array(101).fill("model")),
      "gpt-5.5",
    ),
    ["gpt-5.5"],
  );
});

test("derives stable bounded model variant identities", () => {
  const first = modelVariantAgentVersionId("agent-default", "gpt-5.6-sol");
  assert.equal(
    first,
    modelVariantAgentVersionId("agent-default", "gpt-5.6-sol"),
  );
  assert.match(first ?? "", /^agent-default:model-[a-f0-9]{24}$/u);
  assert.equal(modelVariantAgentVersionId("a".repeat(481), "model"), null);
});
