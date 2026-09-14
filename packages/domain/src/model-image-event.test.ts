import assert from "node:assert/strict";
import test from "node:test";
import { validModelImageEventData } from "./model-image-event.ts";

const image = {
  segmentId: "segment-1",
  segmentSequence: 2,
  itemId: "image-1",
  artifactRef: "artifact-1",
  mimeType: "image/png",
  byteLength: 3_550_000,
} as const;

test("stored image metadata is bounded and cannot contain inline image bytes", () => {
  assert.equal(validModelImageEventData("model.image.generated", image), true);
  assert.equal(
    validModelImageEventData("model.image.generated", {
      ...image,
      byteLength: 8 * 1024 * 1024 + 1,
    }),
    false,
  );
  assert.equal(
    validModelImageEventData("model.image.generated", {
      ...image,
      artifactRef: "file:/private/image.png",
    }),
    false,
  );
  const withBytes = { ...image, result: "aGVsbG8=" };
  assert.equal(
    validModelImageEventData("model.image.generated", withBytes),
    false,
  );
});

test("stored image progress accepts only its own metadata shape", () => {
  const progress = {
    segmentId: "segment-1",
    segmentSequence: 1,
    itemId: "image-1",
    stage: "generating",
  } as const;
  assert.equal(
    validModelImageEventData("model.image.progress", progress),
    true,
  );
  assert.equal(
    validModelImageEventData("model.image.generated", progress),
    false,
  );
  assert.equal(validModelImageEventData("model.image.progress", image), false);
});
