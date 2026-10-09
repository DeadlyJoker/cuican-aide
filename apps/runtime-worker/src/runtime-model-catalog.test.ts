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
  assert.match(
    modelVariantAgentVersionId(
      "local-desktop-current-planner",
      "gpt-5.6-sol",
    ) ?? "",
    /^local-desktop-current-planner:model-[a-f0-9]{24}$/u,
  );
  assert.equal(modelVariantAgentVersionId("a".repeat(481), "model"), null);
});

test("authoritative catalogs never reinsert defaults and filter non-agent models without consuming the bound", async () => {
  const { advertisedRuntimeModelCatalog } = await import(
    "./runtime-model-catalog.ts"
  );
  assert.deepEqual(
    advertisedRuntimeModelCatalog(
      JSON.stringify(["gpt-image-2", "gpt-5.6-sol"]),
    ),
    ["gpt-5.6-sol"],
  );
  assert.deepEqual(advertisedRuntimeModelCatalog("[]"), []);
  assert.equal(
    advertisedRuntimeModelCatalog(
      JSON.stringify([
        "gpt-image-2",
        ...Array.from({ length: 30 }, (_, i) => `model-${i}`),
      ]),
    ).length,
    30,
  );
  for (const malformed of [
    "not-json",
    "{}",
    JSON.stringify(["m", "m"]),
    JSON.stringify([""]),
    JSON.stringify([null]),
    JSON.stringify(new Array(101).fill("m")),
  ])
    assert.throws(
      () => advertisedRuntimeModelCatalog(malformed),
      /runtime_model_catalog_invalid/,
    );
});

test("a valid declared catalog never restores an unavailable default model", () => {
  for (const catalog of [[], ["gpt-5.6-sol"], ["gpt-image-2", "gpt-5.6-sol"]])
    assert.throws(
      () => runtimeModelCatalog(JSON.stringify(catalog), "gpt-5.5"),
      /runtime_model_catalog_default_unavailable/,
    );
  assert.deepEqual(
    runtimeModelCatalog(
      JSON.stringify(["gpt-5.6-sol", "gpt-5.6-luna"]),
      "gpt-5.6-sol",
    ),
    ["gpt-5.6-sol", "gpt-5.6-luna"],
  );
  assert.deepEqual(runtimeModelCatalog(undefined, "legacy-explicit-model"), [
    "legacy-explicit-model",
  ]);
});

test("retains every model in a valid gateway directory through the final variant", () => {
  const models = Array.from({ length: 100 }, (_, index) => `model-${index}`);
  assert.deepEqual(
    runtimeModelCatalog(JSON.stringify(models), models[0]),
    models,
  );
});
