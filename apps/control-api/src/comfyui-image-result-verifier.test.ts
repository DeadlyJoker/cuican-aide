import assert from "node:assert/strict";
import test from "node:test";
import type { VerifyProjectGenerationImageInput } from "@crewon/application";
import {
  createComfyUiProjectGenerationImageResultVerifier,
  decodeComfyUiImages,
} from "./comfyui-image-result-verifier.ts";
import {
  generationImage,
  generationProjectionFixture,
  generationResultBaseUrl,
} from "./project-generation-read-projection.test-support.ts";

const identity = {
  pluginVersion: "1.0.0",
  manifestDigest: `sha256:${"a".repeat(64)}`,
  implementationDigest: `sha256:${"b".repeat(64)}`,
};

/** Pure decoder inputs only; this fixture is not evidence of SQL, paid admission or current authorization. */
function fixture(): VerifyProjectGenerationImageInput {
  const value = generationProjectionFixture();
  const binding = {
    ...value.task.binding,
    tenantId: "tenant-1",
    spaceId: "space-1",
    runId: "original-run",
    configurationDigest: `sha256:${"c".repeat(64)}`,
    bindingDigest: `sha256:${"d".repeat(64)}`,
  };
  return {
    generationLink: {
      ...value.link,
      tenantId: "tenant-1",
      spaceId: "space-1",
      binding,
    },
    configuration: {
      ...value.task.configuration,
      tenantId: "tenant-1",
      spaceId: "space-1",
      pluginId: binding.pluginId,
      revision: 1,
      ...identity,
      contentDigest: binding.configurationDigest,
    },
    operation: {
      ...value.task.operations[0]!,
      tenantId: "tenant-1",
      bindingDigest: binding.bindingDigest,
      resultJson: JSON.stringify({
        images: [
          generationImage("first.png"),
          generationImage("chosen.png", "scene/雨夜"),
        ],
      }),
    },
    resultIndex: 1,
  } as VerifyProjectGenerationImageInput;
}

test("pure Comfy adapter selects the original raw position and retains the complete canonical provider reference", () => {
  const verifier = createComfyUiProjectGenerationImageResultVerifier({
    identities: [identity],
  });
  const result = verifier.verifyImage(fixture());
  assert.deepEqual(result, {
    filename: "chosen.png",
    url: generationImage("chosen.png", "scene/雨夜").url,
    resultIndex: 1,
    providerReferenceJson:
      '{"filename":"chosen.png","subfolder":"scene/雨夜","type":"output"}',
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(
    decodeComfyUiImages({
      baseUrl: generationResultBaseUrl,
      resultJson: fixture().operation.resultJson,
    }).map((image) => image.resultIndex),
    [0, 1],
  );
});

test("provider identity is captured before use and no current package or configuration can replace the original identity", () => {
  const configured = { identities: [{ ...identity }] };
  const verifier =
    createComfyUiProjectGenerationImageResultVerifier(configured);
  configured.identities[0]!.pluginVersion = "2.0.0";
  assert.equal(verifier.verifyImage(fixture()).filename, "chosen.png");
  for (const change of [
    { pluginVersion: "2.0.0" },
    { manifestDigest: `sha256:${"e".repeat(64)}` },
    { implementationDigest: `sha256:${"f".repeat(64)}` },
    { contentDigest: `sha256:${"e".repeat(64)}` },
    { revision: 2 },
    { pluginId: "other.provider" },
  ]) {
    const original = fixture();
    assert.throws(
      () =>
        verifier.verifyImage({
          ...original,
          configuration: { ...original.configuration, ...change },
        }),
      { code: "project_generation_selection_result_unavailable" },
    );
  }
});

test("foreign generation or operation identity and non-successful observations cannot become selected images", () => {
  const verifier = createComfyUiProjectGenerationImageResultVerifier({
    identities: [identity],
  });
  for (const change of [
    { tenantId: "other-tenant" },
    { runId: "other-run" },
    { bindingDigest: `sha256:${"e".repeat(64)}` },
    { status: "unknownOutcome" as const },
  ]) {
    const original = fixture();
    assert.throws(
      () =>
        verifier.verifyImage({
          ...original,
          operation: { ...original.operation, ...change },
        }),
      { code: "project_generation_selection_result_unavailable" },
    );
  }
  const original = fixture();
  assert.throws(
    () =>
      verifier.verifyImage({
        ...original,
        generationLink: {
          ...original.generationLink,
          binding: {
            ...original.generationLink.binding,
            source: {
              runId: "query-parent",
              operationId: original.operation.operationId,
              bindingDigest: original.generationLink.binding.bindingDigest,
            },
          },
        },
      }),
    { code: "project_generation_selection_result_unavailable" },
  );
});

test("exact raw index, whole provider result and original frozen base URL remain strict", () => {
  const verifier = createComfyUiProjectGenerationImageResultVerifier({
    identities: [identity],
  });
  for (const resultIndex of [-1, 2, 16, 0.5])
    assert.throws(() => verifier.verifyImage({ ...fixture(), resultIndex }), {
      code: "project_generation_selection_result_unavailable",
    });
  for (const image of [
    { ...generationImage(), url: "https://foreign.example.test/view" },
    generationImage("../escape.png"),
    generationImage("ok.png", "../private"),
    { ...generationImage(), type: "temp" },
    { ...generationImage(), extra: "unreviewed" },
  ]) {
    const original = fixture();
    assert.throws(
      () =>
        verifier.verifyImage({
          ...original,
          resultIndex: 0,
          operation: {
            ...original.operation,
            resultJson: JSON.stringify({ images: [generationImage(), image] }),
          },
        }),
      { code: "extension_result_invalid" },
    );
  }
  assert.throws(
    () =>
      decodeComfyUiImages({
        baseUrl: generationResultBaseUrl,
        resultJson: JSON.stringify({
          images: Array.from({ length: 17 }, () => generationImage()),
        }),
      }),
    { code: "extension_result_invalid" },
  );
});

test("reviewed provider registry rejects getters, sparse arrays, duplicate identities and unknown fields", () => {
  let reads = 0;
  assert.throws(() =>
    createComfyUiProjectGenerationImageResultVerifier({
      get identities() {
        reads++;
        return [identity];
      },
    }),
  );
  assert.equal(reads, 0);
  for (const identities of [
    [],
    new Array(1),
    [identity, identity],
    [{ ...identity, extra: true }],
    [{ ...identity, pluginVersion: "01.0.0" }],
  ])
    assert.throws(() =>
      createComfyUiProjectGenerationImageResultVerifier({
        identities,
      } as Parameters<
        typeof createComfyUiProjectGenerationImageResultVerifier
      >[0]),
    );
});
