import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureModelImageObservation,
  modelImageObservationInput,
  validateModelImageObservations,
  ModelImageObservationError,
  MAX_MODEL_IMAGE_BYTES,
  MAX_MODEL_IMAGES_BYTES,
  type ModelImageObservation,
} from "./model-image-observation.ts";

const scope = {
  runId: "review-run",
  segmentId: "review-segment",
  agentVersionId: "reviewer",
};
const png = () =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nxjYAAAAASUVORK5CYII=",
    "base64",
  );
const capture = (evidenceId = "shot07-frame48000", bytes = png()) =>
  captureModelImageObservation({
    scope,
    evidenceId,
    mediaType: "image/png",
    bytes,
    detail: "high",
  });

test("captured pixels are snapshotted, digest-bound and absent from serialized metadata", () => {
  const bytes = png();
  const original = Buffer.from(bytes);
  const image = capture(undefined, bytes);
  bytes.fill(0);
  assert.ok(Object.isFrozen(image));
  const wire = modelImageObservationInput(image, scope);
  assert.equal(wire.role, "user");
  assert.deepEqual(wire.content[1], {
    type: "input_image",
    detail: "high",
    image_url: `data:image/png;base64,${original.toString("base64")}`,
  });
  assert.equal(
    image.contentDigest,
    `sha256:${createHash("sha256").update(original).digest("hex")}`,
  );
  assert.ok(!JSON.stringify(image).includes("base64"));
  assert.ok(!JSON.stringify(image).includes(original.toString("base64")));
  assert.deepEqual(validateModelImageObservations([image], scope), [image]);
});

test("copied, serialized and foreign Run/Segment/agent captures cannot expose pixels", () => {
  const image = capture();
  for (const copy of [
    { ...image },
    structuredClone(image),
    JSON.parse(JSON.stringify(image)),
    new Proxy(image, {}),
  ])
    assert.throws(() => modelImageObservationInput(copy, scope), {
      code: "model_image_scope_invalid",
    });
  for (const key of ["runId", "segmentId", "agentVersionId"] as const)
    assert.throws(
      () =>
        validateModelImageObservations([image], { ...scope, [key]: "foreign" }),
      { code: "model_image_scope_invalid" },
    );
});

test("array accessors, holes, custom iterators and proxies are rejected without callbacks", () => {
  let callbacks = 0;
  const image = capture();
  const accessor: ModelImageObservation[] = [];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      callbacks++;
      return image;
    },
  });
  const iterator = [image];
  Object.defineProperty(iterator, Symbol.iterator, {
    value() {
      callbacks++;
      throw new Error("must-not-run");
    },
  });
  for (const invalid of [
    accessor,
    iterator,
    new Array(1),
    new Proxy([image], {
      get() {
        callbacks++;
        throw new Error("must-not-run");
      },
    }),
  ])
    assert.throws(() => validateModelImageObservations(invalid, scope), {
      code: "model_image_budget_invalid",
    });
  assert.equal(callbacks, 0);
});

test("capture does not invoke byte-array length/valueOf/iterator overrides", () => {
  const bytes = png();
  let callbacks = 0;
  for (const key of ["byteLength", "valueOf", Symbol.iterator])
    Object.defineProperty(bytes, key, {
      get() {
        callbacks++;
        throw new Error("must-not-run");
      },
    });
  const image = capture(undefined, bytes);
  assert.ok(modelImageObservationInput(image, scope));
  assert.equal(callbacks, 0);
});

test("image count, repeated evidence, encoded size, MIME and geometry stay bounded", () => {
  const images = Array.from({ length: 7 }, (_, i) => capture(`frame-${i}`));
  assert.equal(
    validateModelImageObservations(images.slice(0, 6), scope).length,
    6,
  );
  for (const invalid of [images, [images[0]!, images[0]!]])
    assert.throws(() => validateModelImageObservations(invalid, scope), {
      code: "model_image_budget_invalid",
    });
  const large = Buffer.alloc(MAX_MODEL_IMAGE_BYTES + 1);
  assert.throws(() => capture(undefined, large), {
    code: "model_image_input_invalid",
  });
  const geometry = png();
  geometry.writeUInt32BE(1025, 16);
  assert.throws(() => capture(undefined, geometry), {
    code: "model_image_geometry_invalid",
  });
  const pixels = png();
  pixels.writeUInt32BE(513, 16);
  pixels.writeUInt32BE(513, 20);
  assert.throws(() => capture(undefined, pixels), {
    code: "model_image_geometry_invalid",
  });
  assert.throws(
    () =>
      captureModelImageObservation({
        scope,
        evidenceId: "frame",
        mediaType: "image/svg+xml" as never,
        bytes: png(),
        detail: "high",
      }),
    { code: "model_image_input_invalid" },
  );
  assert.throws(
    () =>
      captureModelImageObservation({
        scope,
        evidenceId: "frame",
        mediaType: "image/jpeg",
        bytes: png(),
        detail: "high",
      }),
    { code: "model_image_format_invalid" },
  );
});

test("truncated JPEG marker runs fail with a bounded diagnostic", () => {
  for (let length = 12; length < 80; length++) {
    const bytes = Buffer.alloc(length, 255);
    bytes.writeUInt16BE(0xffd8, 0);
    bytes.writeUInt16BE(0xffd9, length - 2);
    assert.throws(
      () =>
        captureModelImageObservation({
          scope,
          evidenceId: "jpeg",
          mediaType: "image/jpeg",
          bytes,
          detail: "high",
        }),
      ModelImageObservationError,
    );
  }
});

test("the aggregate byte budget rejects five individually bounded image capsules", () => {
  // Named header fixture: this checks the capsule budget, not a full PNG decode.
  const bytes = Buffer.alloc(MAX_MODEL_IMAGE_BYTES);
  const header = png();
  header.copy(bytes, 0, 0, 33);
  header.copy(bytes, bytes.length - 12, header.length - 12);
  const images = Array.from({ length: 5 }, (_, index) =>
    capture(`large-frame-${index}`, bytes),
  );
  assert.equal(4 * MAX_MODEL_IMAGE_BYTES, MAX_MODEL_IMAGES_BYTES);
  assert.equal(
    validateModelImageObservations(images.slice(0, 4), scope).length,
    4,
  );
  assert.throws(() => validateModelImageObservations(images, scope), {
    code: "model_image_budget_invalid",
  });
});

test("JPEG geometry is read from its own SOF marker and remains subject to the pixel bound", () => {
  // Named SOF fixture tests the geometry parser; it is not image-quality evidence.
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 1, 0xff, 0xd9,
  ]);
  const input = {
    scope,
    evidenceId: "jpeg-frame",
    mediaType: "image/jpeg" as const,
    bytes,
    detail: "low" as const,
  };
  const observation = captureModelImageObservation(input);
  assert.equal(observation.detail, "low");
  assert.ok(
    modelImageObservationInput(observation, scope).content[1]!.type ===
      "input_image",
  );
  const huge = Buffer.from(bytes);
  huge.writeUInt16BE(1025, 7);
  assert.throws(() => captureModelImageObservation({ ...input, bytes: huge }), {
    code: "model_image_geometry_invalid",
  });
});
