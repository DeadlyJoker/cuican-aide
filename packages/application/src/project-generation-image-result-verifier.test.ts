import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import { projectConceptSelectionFixture } from "./project-concept-selection.test-support.ts";
import {
  captureProjectGenerationImageResultVerifier,
  verifyProjectGenerationImage,
  type ProjectGenerationImageResultVerifier,
} from "./project-generation-image-result-verifier.ts";

test("provider adapter owns result decoding and its captured receiver without Comfy assumptions", async () => {
  const f = await projectConceptSelectionFixture();
  const provider = {
    expected: "folder/provider-name.png",
    verifyImage() {
      return {
        filename: this.expected,
        resultIndex: 1,
        url: "https://provider.test/result/2",
        providerReferenceJson: '{"asset":"provider-2"}',
      };
    },
  };
  const captured = captureProjectGenerationImageResultVerifier(provider);
  provider.verifyImage = () => {
    throw new Error("replaced callback must not run");
  };
  const image = verifyProjectGenerationImage(captured, {
    generationLink: f.original.link,
    configuration: f.original.task.configuration,
    operation: f.state.operation!,
    resultIndex: 1,
  });
  assert.equal(image.filename, "folder/provider-name.png");
  assert.equal(Object.isFrozen(image), true);
});

test("saved binding and exact succeeded result are verified before provider callback", async () => {
  const f = await projectConceptSelectionFixture();
  let calls = 0;
  const verifier = {
    verifyImage() {
      calls++;
      throw new Error("must not invoke");
    },
  };
  const input = {
    generationLink: f.original.link,
    configuration: f.original.task.configuration,
    operation: f.state.operation!,
    resultIndex: 1,
  };
  for (const patch of [
    { resultIndex: 16 },
    { operation: { ...input.operation, status: "running" as const } },
    { operation: { ...input.operation, resultJson: "x".repeat(16_385) } },
    { operation: { ...input.operation, bindingDigest: "different-binding" } },
    {
      configuration: {
        ...input.configuration,
        revision: input.configuration.revision + 1,
      },
    },
    { configuration: { ...input.configuration, pluginId: "other.provider" } },
  ])
    assert.throws(
      () => verifyProjectGenerationImage(verifier, { ...input, ...patch }),
      ApplicationError,
    );
  assert.equal(calls, 0);
});

test("getter callback and async or thenable result cannot become pure verifier authority", async () => {
  const f = await projectConceptSelectionFixture();
  let reads = 0;
  const getter = Object.defineProperty({}, "verifyImage", {
    get() {
      reads++;
      throw new Error("unread");
    },
  });
  assert.throws(
    () =>
      captureProjectGenerationImageResultVerifier(
        getter as ProjectGenerationImageResultVerifier,
      ),
    ApplicationError,
  );
  for (const result of [
    Promise.resolve({}),
    Promise.reject(new Error("async provider rejected")),
    Object.defineProperty({}, "then", {
      get() {
        reads++;
        throw new Error("unread then");
      },
    }),
    Object.defineProperty({}, "url", {
      enumerable: true,
      get() {
        reads++;
        throw new Error("unread url");
      },
    }),
  ]) {
    const verifier = {
      verifyImage: () => result,
    } as unknown as ProjectGenerationImageResultVerifier;
    assert.throws(
      () =>
        verifyProjectGenerationImage(verifier, {
          generationLink: f.original.link,
          configuration: f.original.task.configuration,
          operation: f.state.operation!,
          resultIndex: 1,
        }),
      ApplicationError,
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 0);
});

test("generic image remains exact HTTPS bounded canonical provider data", async () => {
  const f = await projectConceptSelectionFixture();
  const image = {
    filename: "image.png",
    resultIndex: 1,
    url: "https://provider.test/image",
    providerReferenceJson: '{"reference":"2"}',
  };
  const invalid = [
    { resultIndex: 0 },
    { url: "http://provider.test/image" },
    { url: "https://user:pass@provider.test/image" },
    { url: "https://provider.test/image#" },
    { url: "https://provider.test/" + "界".repeat(700) },
    { filename: "a\n.png" },
    { filename: "a".repeat(1025) },
    { providerReferenceJson: '{ "reference": "2" }' },
    { providerReferenceJson: '"string"' },
    { providerReferenceJson: "[]" },
    { providerReferenceJson: '{"value":"' + "界".repeat(700) + '"}' },
    { extra: "unexpected" },
  ];
  for (const patch of invalid) {
    assert.throws(
      () =>
        verifyProjectGenerationImage(
          { verifyImage: () => ({ ...image, ...patch }) },
          {
            generationLink: f.original.link,
            configuration: f.original.task.configuration,
            operation: f.state.operation!,
            resultIndex: 1,
          },
        ),
      ApplicationError,
    );
  }
});
