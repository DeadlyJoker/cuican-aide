import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createCreativeProject,
  appendProjectBriefRevision,
  createConceptAsset,
  createExtensionConfiguration,
  createExtensionRunBinding,
  createProjectGenerationLink,
  createOperationResultLink,
  createCurrentConceptSelection,
  parseOperationResultImage,
  parseOperationResultLink,
  parseCurrentConceptSelection,
  assertConceptSelectionResult,
  extensionCanonicalJson,
  captureProjectGenerationSelectionPublications,
} from "./index.ts";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const actor = {
    tenantId: "tenant",
    spaceId: "space",
    principalId: "owner",
    actorId: "audit",
  },
  at = "2026-10-04T00:00:00.000Z";
const image = {
  filename: "image.png",
  url: "https://supplier.example/view/image.png",
  resultIndex: 0,
  providerReferenceJson: '{"asset":"opaque-ref"}',
};
function fixture() {
  const project = createCreativeProject({
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      projectId: "project",
    },
    actor,
    title: "短剧",
    at,
  });
  const brief = appendProjectBriefRevision(
    { project, actor, expectedProjectRevision: 1, text: "创作要求", at },
    digester,
  );
  const concept = createConceptAsset(
    {
      project: brief.project,
      actor,
      expectedProjectRevision: 2,
      brief: brief.brief,
      assetId: "asset",
      name: "概念",
      prompt: "原始输入",
      at,
    },
    digester,
  );
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: "example.provider",
      revision: 1,
      pluginVersion: "1.0.0",
      manifestDigest: digester.sha256("manifest"),
      implementationDigest: digester.sha256("implementation"),
      parameters: { serviceUrl: "https://supplier.example/" },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: at,
    },
    digester,
  );
  const binding = createExtensionRunBinding(
    {
      schemaVersion: "crewon.extension-run-binding.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: configuration.pluginId,
      runId: "original-run",
      threadId: "original-thread",
      actorId: actor.actorId,
      configurationRevision: 1,
      configurationDigest: configuration.contentDigest,
      target: {
        executionAuthority: "crewonKernel",
        agentVersionId: "agent",
        agentVersionContentDigest: digester.sha256("agent"),
        materializationDigest: digester.sha256("materialization"),
        authorityId: "authority",
        runtimeGeneration: "runtime",
        policySnapshotId: "policy",
        workspaceBindingId: null,
      },
      inputDigest: digester.sha256(
        extensionCanonicalJson({ prompt: concept.assetRevision.prompt }),
      ),
      source: null,
    },
    digester,
  );
  const generationLink = createProjectGenerationLink(
    {
      actor,
      reference: {
        projectId: "project",
        assetId: "asset",
        assetRevision: 1,
        expectedProjectRevision: 3,
        expectedAssetMetadataRevision: 1,
      },
      ...concept,
      brief: brief.brief,
      binding,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: "paid-generation",
        requestDigest: digester.sha256("paid-request"),
      },
      at,
    },
    digester,
  );
  const input = {
    actor,
    generationLink,
    configuration,
    packageDigest: digester.sha256("historical-package"),
    operation: {
      operationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      operationRevision: 3,
      operationDigest: digester.sha256("actual-operation"),
      rawResultDigest: digester.sha256("actual-result"),
      observedAt: at,
    },
    image,
  };
  const resultLink = createOperationResultLink(input, digester);
  return { input, resultLink };
}
test("operation result retains the immutable original source, exact operation revision and opaque verified image", () => {
  const { input, resultLink } = fixture();
  assert.equal(resultLink.schemaVersion, "crewon.operation-result-link.v1");
  assert.equal(
    resultLink.generationLinkDigest,
    input.generationLink.contentDigest,
  );
  assert.equal(resultLink.sourceRunId, "original-run");
  assert.equal(resultLink.operationRevision, 3);
  assert.equal(resultLink.packageDigest, input.packageDigest);
  assert.deepEqual(resultLink.reference, {
    projectId: "project",
    assetId: "asset",
    assetRevision: 1,
  });
  assert.deepEqual(parseOperationResultLink(resultLink, digester), resultLink);
  assert.ok(Object.isFrozen(resultLink.image));
  const mutable = structuredClone(input);
  const frozen = createOperationResultLink(mutable, digester);
  mutable.image.url = "https://other.example/";
  assert.equal(frozen.image.url, image.url);
  assert.throws(
    () =>
      createOperationResultLink(
        { ...input, actor: { ...actor, principalId: "other" } },
        digester,
      ),
    /source_mismatch/,
  );
  assert.throws(
    () =>
      parseOperationResultLink(
        { ...resultLink, operationRevision: 4 },
        digester,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      parseOperationResultLink(
        { ...resultLink, schemaVersion: "crewon.operation-result-link.v2" },
        digester,
      ),
    /version_unsupported/,
  );
});
test("independent selection CAS orders choices even when the server clock moves backwards", () => {
  const { resultLink } = fixture();
  const first = createCurrentConceptSelection(
    { actor, resultLink, previous: null, expectedSelectionRevision: 0, at },
    digester,
  );
  const second = createCurrentConceptSelection(
    {
      actor,
      resultLink,
      previous: first,
      expectedSelectionRevision: 1,
      at: "2026-10-03T00:00:00.000Z",
    },
    digester,
  );
  assert.equal(second.selectionRevision, 2);
  assert.equal(second.selectedAt, "2026-10-03T00:00:00.000Z");
  assert.deepEqual(parseCurrentConceptSelection(second, digester), second);
  assertConceptSelectionResult(second, resultLink);
  assert.throws(
    () =>
      createCurrentConceptSelection(
        {
          actor,
          resultLink,
          previous: first,
          expectedSelectionRevision: 0,
          at,
        },
        digester,
      ),
    /revision_conflict/,
  );
  assert.throws(
    () =>
      createCurrentConceptSelection(
        {
          actor: { ...actor, principalId: "another" },
          resultLink,
          previous: null,
          expectedSelectionRevision: 0,
          at,
        },
        digester,
      ),
    /owner_mismatch/,
  );
  assert.throws(
    () =>
      parseCurrentConceptSelection(
        { ...first, resultLinkDigest: digester.sha256("other") },
        digester,
      ),
    /invalid/,
  );
});
test("image reference parser is provider generic, HTTPS bounded and rejects empty fragment, caller extras, getters and unsafe opaque references", () => {
  assert.equal(
    parseOperationResultImage({
      ...image,
      filename: "provider/path/" + "x".repeat(1000),
    }).filename.length,
    1014,
  );
  for (const patch of [
    { url: "http://supplier.example/x" },
    { url: "https://user:password@supplier.example/x" },
    { url: image.url + "#" },
    { url: image.url + "#asset" },
    { url: "https://supplier.example/" + "x".repeat(2048) },
    { filename: "x\n.png" },
    { filename: "x".repeat(1025) },
    { resultIndex: 16 },
    { providerReferenceJson: '{"z":1,"a":2}' },
    { providerReferenceJson: "[]" },
    { providerReferenceJson: '"opaque"' },
    {
      providerReferenceJson: extensionCanonicalJson({ raw: "x".repeat(2048) }),
    },
    { extra: true },
  ])
    assert.throws(() => parseOperationResultImage({ ...image, ...patch }));
  let accessed = false;
  const accessor = { ...image };
  Object.defineProperty(accessor, "url", {
    enumerable: true,
    get() {
      accessed = true;
      return image.url;
    },
  });
  assert.throws(() => parseOperationResultImage(accessor));
  assert.equal(accessed, false);
});
test("selection declarations remain detached exact bounded source identities", () => {
  const publication = {
    source: {
      pluginId: "example.business",
      packageDigest: digester.sha256("business"),
      contributionId: "workbench",
    },
  };
  const captured = captureProjectGenerationSelectionPublications([publication]);
  publication.source.pluginId = "example.changed";
  assert.equal(captured[0]?.source.pluginId, "example.business");
  assert.ok(Object.isFrozen(captured));
  assert.throws(
    () =>
      captureProjectGenerationSelectionPublications([captured[0], captured[0]]),
    /duplicate/,
  );
  assert.throws(() => captureProjectGenerationSelectionPublications([]));
  assert.throws(() =>
    captureProjectGenerationSelectionPublications([
      { ...captured[0], extra: true },
    ]),
  );
});
