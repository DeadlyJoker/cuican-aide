import assert from "node:assert/strict";
import test from "node:test";
import { verifiedExtensionTaskImages } from "./extension-task-result-projection.ts";
import {
  generationImage,
  generationProjectionFixture,
} from "./project-generation-read-projection.test-support.ts";

// Projection-only inputs; no provider response or current execution authority is simulated.
for (const pluginId of ["crewon.comfyui-krea2", "crewon.short-drama"])
  test(`task projection preserves ${pluginId} image positions and verified URLs`, () => {
    const { task } = generationProjectionFixture();
    const value = { ...task, binding: { ...task.binding, pluginId } };
    assert.deepEqual(verifiedExtensionTaskImages(value, task.operations[0]!), [
      {
        url: generationImage("first.png").url,
        filename: "first.png",
        resultIndex: 0,
      },
      {
        url: generationImage("second.png").url,
        filename: "second.png",
        resultIndex: 1,
      },
    ]);
    for (const status of [
      "submitting",
      "submitted",
      "queued",
      "running",
      "failed",
      "unknownOutcome",
    ] as const)
      assert.deepEqual(
        verifiedExtensionTaskImages(value, { ...task.operations[0]!, status }),
        [],
      );
    for (const baseUrl of [
      "http://comfy.example.test:8443/",
      "https://foreign.example.test/",
      "https://secret@comfy.example.test:8443/",
    ])
      assert.throws(
        () =>
          verifiedExtensionTaskImages(
            {
              ...value,
              configuration: {
                ...value.configuration,
                parameters: { ...value.configuration.parameters, baseUrl },
              },
            },
            task.operations[0]!,
          ),
        { code: "extension_result_invalid" },
      );
  });

test("task projection cannot interpret results for arbitrary plugin identities", () => {
  const { task } = generationProjectionFixture();
  for (const pluginId of ["other.provider", "CREWON.SHORT-DRAMA", ""])
    assert.deepEqual(
      verifiedExtensionTaskImages(
        { ...task, binding: { ...task.binding, pluginId } },
        task.operations[0]!,
      ),
      [],
    );
});
