import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseProviderCheckpoint,
  providerCheckpointJsonSchema,
} from "./provider-checkpoint.ts";

const checkpoint = {
  schemaVersion: "crewon.provider-checkpoint.v0",
  adapterName: "direct-responses",
  adapterVersion: "1",
  modelId: "provider-model",
  opaquePayload: { responseId: "resp-1" },
} as const;

test("accepts one bounded SDK-free provider checkpoint shape", () => {
  assert.equal(
    providerCheckpointJsonSchema.properties.schemaVersion.const,
    "crewon.provider-checkpoint.v0",
  );
  assert.deepEqual(parseProviderCheckpoint(checkpoint), checkpoint);
});

test("rejects unknown fields, non-JSON payloads and oversized checkpoints", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const candidate of [
    { ...checkpoint, sdkSession: "hidden" },
    { ...checkpoint, opaquePayload: cyclic },
    { ...checkpoint, opaquePayload: { responseId: Number.NaN } },
  ]) {
    assert.throws(
      () => parseProviderCheckpoint(candidate),
      (error: unknown) => error instanceof ContractValidationError,
    );
  }
  assert.throws(
    () => parseProviderCheckpoint(checkpoint, 16),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.code === "provider_checkpoint_too_large",
  );
});
