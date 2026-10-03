import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CREATIVE_PROJECT_RESPONSE_BYTES } from "@crewon/contracts";
import { projectExtensionTask } from "./extension-task-projection.ts";
import { projectConceptGeneration } from "./project-generation-read-projection.ts";
import {
  generationImage,
  generationProjectionFixture,
} from "./project-generation-read-projection.test-support.ts";

test("saved generation view retains the original operation revision and raw image positions without private binding data", () => {
  assert.deepEqual(projectConceptGeneration(null), { generation: null });
  const value = generationProjectionFixture();
  const response = projectConceptGeneration(value);
  const generation = response.generation!;
  assert.equal(generation.assetRevision, 2);
  assert.equal(generation.briefRevision, 1);
  assert.equal(generation.task.runId, "original-run");
  assert.equal(generation.task.sourceRunId, null);
  assert.equal(generation.task.runStatus, "queued");
  assert.deepEqual(
    generation.task.operations[0]!.images.map((image) => image.resultIndex),
    [0, 1],
  );
  assert.equal(generation.task.operations[0]!.operationRevision, 7);
  for (const field of [
    "providerOperationId",
    "private-provider-job",
    "bindingDigest",
    "resultJson",
    "parameters",
    "principalId",
  ])
    assert.equal(JSON.stringify(response).includes(field), false, field);
  const original = projectExtensionTask(value.task).task;
  assert.equal("operationRevision" in original.operations[0]!, false);
  assert.deepEqual(Object.keys(original.operations[0]!.images[0]!).sort(), [
    "filename",
    "url",
  ]);
});

test("shared Krea result verification refuses foreign URLs, unreviewed fields and unsafe provider filenames", () => {
  for (const image of [
    {
      ...generationImage(),
      url: "https://foreign.example.test/view?filename=concept.png",
    },
    generationImage("../escape.png"),
    generationImage("safe.png", "../private"),
    { ...generationImage(), type: "temp" },
    { ...generationImage(), privateField: "unreviewed" },
  ]) {
    const value = generationProjectionFixture();
    value.task.operations = [
      {
        ...value.task.operations[0]!,
        resultJson: JSON.stringify({ images: [image] }),
      },
    ];
    for (const project of [
      () => projectConceptGeneration(value),
      () => projectExtensionTask(value.task),
    ])
      assert.throws(project, { code: "extension_result_invalid" });
  }
});

test("non-terminal observations never expose images and task query children cannot masquerade as original generation", () => {
  const value = generationProjectionFixture();
  value.task.operations = [
    {
      ...value.task.operations[0]!,
      status: "unknownOutcome",
      resultJson: "provider text is not a result",
    },
  ];
  assert.deepEqual(
    projectConceptGeneration(value).generation!.task.operations[0]!.images,
    [],
  );
  value.task.binding = {
    ...value.task.binding,
    source: {
      runId: "parent",
      operationId: "operation",
      bindingDigest: "sha256:" + "a".repeat(64),
    },
  };
  assert.throws(() => projectConceptGeneration(value), {
    code: "project_generation_link_invalid",
  });
});

test("60KiB whole-response trimming preserves original raw result indices and the old task's 64KiB image budget", () => {
  const value = generationProjectionFixture();
  const images = [
    ...Array.from({ length: 7 }, (_, index) =>
      generationImage(`${index}-${"f".repeat(190)}.png`, "s".repeat(512)),
    ),
    generationImage("tiny.png"),
  ];
  const resultJson = JSON.stringify({ images });
  assert.ok(Buffer.byteLength(resultJson) <= 16_384);
  value.task.operations = Array.from({ length: 16 }, (_, index) => ({
    ...value.task.operations[0]!,
    operationId: `11111111-2222-3333-4444-${String(index).padStart(12, "0")}`,
    revision: index + 1,
    resultJson,
  }));
  const response = projectConceptGeneration(value);
  assert.ok(
    Buffer.byteLength(JSON.stringify(response)) <=
      MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  );
  assert.equal(response.generation!.task.truncated, true);
  const projected = response.generation!.task.operations;
  assert.equal(projected.length, 16);
  assert.ok(
    projected.reduce((count, operation) => count + operation.images.length, 0) <
      16 * images.length,
  );
  for (const operation of projected) {
    let previous = -1;
    for (const image of operation.images) {
      assert.ok(image.resultIndex > previous);
      previous = image.resultIndex;
      assert.equal(image.url, images[image.resultIndex]!.url);
      assert.equal(image.filename, images[image.resultIndex]!.filename);
    }
  }
  assert.ok(
    projected.some((operation) =>
      operation.images.some(
        (image, position) => image.resultIndex !== position,
      ),
    ),
  );
  const original = projectExtensionTask(value.task).task;
  assert.equal(original.truncated, true);
  const oldImageBytes = original.operations
    .flatMap((operation) => operation.images)
    .reduce(
      (bytes, image) => bytes + Buffer.byteLength(JSON.stringify(image)),
      0,
    );
  assert.ok(oldImageBytes <= 64 * 1024);
  assert.ok(oldImageBytes > MAX_CREATIVE_PROJECT_RESPONSE_BYTES);
});
