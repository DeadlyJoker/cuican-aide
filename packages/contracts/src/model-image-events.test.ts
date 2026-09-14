import assert from "node:assert/strict";
import test from "node:test";
import { parseCanonicalAgentEvent } from "./agent-events.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseModelImageGeneratedData,
  parseModelImageProgressData,
} from "./model-image-events.ts";

const data = {
  itemId: "ig-1",
  artifactRef: "artifact-001",
  mimeType: "image/png",
  byteLength: 3_550_000,
};

test("accepts bounded image references in canonical event envelopes", () => {
  assert.deepEqual(parseModelImageGeneratedData(data), data);
  for (const stage of ["in_progress", "generating", "completed"])
    assert.deepEqual(parseModelImageProgressData({ itemId: "ig-1", stage }), {
      itemId: "ig-1",
      stage,
    });
  const event = {
    schemaVersion: "crewon.agent-event.v0",
    runId: "run-1",
    segmentId: "segment-1",
    sequence: 1,
    type: "model.image.generated",
    data,
  };
  assert.deepEqual(parseCanonicalAgentEvent(event), event);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 512);
});

test("fails closed on unknown image fields, binary payloads, URLs, paths and invalid sizes", () => {
  for (const invalid of [
    { ...data, base64: "aGVsbG8=" },
    { ...data, byteLength: 0 },
    { ...data, byteLength: 1.5 },
    { ...data, byteLength: 8 * 1024 * 1024 + 1 },
    { ...data, artifactRef: "https://example.com/image.png" },
    { ...data, artifactRef: "data:png" },
    { ...data, artifactRef: "/tmp/image.png" },
    { ...data, mimeType: "image/svg+xml" },
    { ...data, itemId: "x".repeat(513) },
  ])
    assert.throws(
      () => parseModelImageGeneratedData(invalid),
      (error) =>
        error instanceof ContractValidationError &&
        error.code === "model_image_metadata_invalid",
    );
  assert.throws(() =>
    parseModelImageProgressData({ itemId: "ig-1", stage: "pending" }),
  );
  assert.equal(
    parseModelImageGeneratedData({ ...data, byteLength: 8 * 1024 * 1024 })
      .byteLength,
    8 * 1024 * 1024,
  );
});
