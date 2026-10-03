import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  appendProjectBriefRevision,
  createConceptAsset,
  createCreativeProject,
  createExtensionRunBinding,
  createProjectGenerationLink,
  extensionCanonicalJson,
  parsePluginTaskAdmission,
  parsePluginTaskAdmissionPin,
  parsePluginQueryTaskAdmission,
  parseProjectQueryPublication,
  createProjectQueryLink,
  parseProjectQueryLink,
  parseProjectQueryReference,
  assertProjectQueryReplay,
} from "./index.ts";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const actor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "person",
  actorId: "audit-actor",
};
const at = "2026-10-03T00:00:00.000Z";
function generationFixture() {
  const created = createCreativeProject({
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      projectId: "project",
    },
    actor,
    title: "短剧",
    at,
  });
  const saved = appendProjectBriefRevision(
    {
      project: created,
      actor,
      expectedProjectRevision: 1,
      text: "  一版创作需求\n",
      at,
    },
    digester,
  );
  const concept = createConceptAsset(
    {
      project: saved.project,
      actor,
      expectedProjectRevision: 2,
      brief: saved.brief,
      assetId: "opaque-asset",
      name: "概念",
      prompt: "  原文画面\n",
      at,
    },
    digester,
  );
  const reference = {
    projectId: "project",
    assetId: "opaque-asset",
    assetRevision: 1,
    expectedProjectRevision: 3,
    expectedAssetMetadataRevision: 1,
  };
  const binding = createExtensionRunBinding(
    {
      schemaVersion: "crewon.extension-run-binding.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: "example.image",
      runId: "run-original",
      threadId: "thread-original",
      actorId: actor.actorId,
      configurationRevision: 1,
      configurationDigest: digester.sha256("configuration"),
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
  const receipt = {
    actorId: actor.actorId,
    idempotencyKey: "plugin-task:original",
    requestDigest: digester.sha256("original-admission-command"),
  };
  const input = {
    actor,
    reference,
    project: concept.project,
    asset: concept.asset,
    assetRevision: concept.assetRevision,
    brief: saved.brief,
    binding,
    receipt,
    at,
  };
  return { input, link: createProjectGenerationLink(input, digester) };
}

function fixture() {
  const generation = generationFixture();
  const executionPin = parsePluginTaskAdmissionPin({
    ...actor,
    profileId: "profile",
    pluginId: "example.image",
    publisherId: "example",
    version: "2.0.0",
    packageDigest: digester.sha256("packageB"),
    selectionRevision: 4,
    contributionId: "studio",
    action: "image.query",
    authorityEpoch: "current-query",
  });
  const sourcePin = parsePluginTaskAdmissionPin({
    ...executionPin,
    pluginId: "example.business",
    version: "5.0.0",
    packageDigest: digester.sha256("business"),
    contributionId: "workbench",
    action: "crewon.project-generation-queries.v1.queryConceptGeneration",
  });
  const publication = parseProjectQueryPublication({
    source: {
      pluginId: sourcePin.pluginId,
      packageDigest: sourcePin.packageDigest,
      contributionId: sourcePin.contributionId,
    },
    target: {
      pluginId: executionPin.pluginId,
      packageDigest: executionPin.packageDigest,
      contributionId: executionPin.contributionId,
      action: executionPin.action,
    },
  });
  const operationId = "00000000-0000-0000-0000-000000000001";
  const sourceAdmission = parsePluginTaskAdmission({
    schemaVersion: "crewon.plugin-task-admission.v1",
    ...executionPin,
    version: "1.0.0",
    packageDigest: digester.sha256("packageA"),
    selectionRevision: 2,
    action: "image.generate",
    runId: generation.link.binding.runId,
    threadId: generation.link.binding.threadId,
    extensionBindingDigest: generation.link.binding.bindingDigest,
    ...generation.link.receipt,
  });
  const binding = createExtensionRunBinding(
    {
      ...generation.link.binding,
      runId: "query-run",
      threadId: "query-thread",
      inputDigest: digester.sha256(
        extensionCanonicalJson({ kind: "query", operationId }),
      ),
      source: {
        runId: generation.link.binding.runId,
        bindingDigest: generation.link.binding.bindingDigest,
        operationId,
      },
    },
    digester,
  );
  const receipt = {
    actorId: actor.actorId,
    idempotencyKey: "query-key",
    requestDigest: digester.sha256("query-request"),
  };
  const queryAdmission = parsePluginQueryTaskAdmission({
    schemaVersion: "crewon.plugin-query-task-admission.v1",
    ...executionPin,
    runId: binding.runId,
    threadId: binding.threadId,
    extensionBindingDigest: binding.bindingDigest,
    ...receipt,
    source: sourceAdmission,
    operationId,
  });
  const reference = {
    projectId: generation.link.projectId,
    assetId: generation.link.reference.assetId,
    assetRevision: generation.link.reference.assetRevision,
  };
  const input = {
    actor,
    reference,
    generationLink: generation.link,
    queryAdmission,
    binding,
    receipt,
    publication,
    sourcePin,
    executionPin,
    at,
  };
  const link = createProjectQueryLink(input, digester);
  const replay = {
    link,
    reference,
    generationLinkDigest: generation.link.contentDigest,
    actor,
    binding,
    receipt,
    publication,
    sourcePin,
    executionPin,
  };
  return { input, link, replay };
}

test("query preserves historical generation A and current query B as separate immutable identities", () => {
  const f = fixture();
  assert.deepEqual(parseProjectQueryLink(f.link, digester), f.link);
  assert.equal(f.link.sourceRunId, f.input.generationLink.binding.runId);
  assert.equal(f.link.binding.runId, "query-run");
  assert.equal(f.link.executionPin.version, "2.0.0");
  assert.equal(f.input.queryAdmission.source.version, "1.0.0");
  assert.equal(
    f.link.generationLinkDigest,
    f.input.generationLink.contentDigest,
  );
  assert.deepEqual(Object.keys(f.link.reference).sort(), [
    "assetId",
    "assetRevision",
    "projectId",
  ]);
  assertProjectQueryReplay(f.replay, digester);
});
test("query factory captures fields without rewriting original immutable generation link", () => {
  const f = fixture(),
    input = {
      ...structuredClone(f.input),
      sourcePin: { ...f.input.sourcePin },
      binding: { ...f.input.binding, target: { ...f.input.binding.target } },
    },
    original = structuredClone(input.generationLink);
  const link = createProjectQueryLink(input, digester);
  input.reference.assetRevision = 8;
  input.sourcePin.authorityEpoch = "changed";
  input.binding.target.agentVersionId = "changed";
  assert.equal(link.reference.assetRevision, 1);
  assert.equal(link.sourcePin.authorityEpoch, "current-query");
  assert.equal(link.binding.target.agentVersionId, "agent");
  assert.deepEqual(input.generationLink, original);
  for (const value of [
    link,
    link.reference,
    link.sourcePin,
    link.executionPin,
    link.binding,
    link.publication,
  ])
    assert.ok(Object.isFrozen(value));
});
test("source3 rejects generation CAS, getters, inherited records and invalid revisions", () => {
  const f = fixture();
  let reads = 0;
  for (const value of [
    { ...f.input.reference, expectedProjectRevision: 3 },
    { ...f.input.reference, assetRevision: 0 },
    Object.assign(Object.create(f.input.reference), {}),
    Object.defineProperty({ ...f.input.reference }, "assetId", {
      enumerable: true,
      get() {
        reads++;
        return "asset";
      },
    }),
  ])
    assert.throws(() => parseProjectQueryReference(value));
  assert.equal(reads, 0);
});
test("wrong owner, historical source, paid receipt and execution pin fail factory", () => {
  const f = fixture();
  for (const patch of [
    { actor: { ...actor, principalId: "foreign" } },
    { actor: { ...actor, actorId: "foreign-session-actor" } },
    { reference: { ...f.input.reference, assetRevision: 2 } },
    {
      queryAdmission: {
        ...f.input.queryAdmission,
        source: { ...f.input.queryAdmission.source, idempotencyKey: "foreign" },
      },
    },
    { executionPin: { ...f.input.executionPin, selectionRevision: 8 } },
    { sourcePin: { ...f.input.sourcePin, action: "image.generate" } },
  ])
    assert.throws(() =>
      createProjectQueryLink({ ...f.input, ...patch }, digester),
    );
});
test("persisted schema, binding, operation and digest corruption fail closed", () => {
  const f = fixture();
  for (const patch of [
    { schemaVersion: "crewon.project-query-link.v2" },
    { sourceRunId: "foreign" },
    { operationId: "not-uuid" },
    { ownerPrincipalId: "foreign" },
    { contentDigest: digester.sha256("foreign") },
    { extra: true },
  ])
    assert.throws(() =>
      parseProjectQueryLink({ ...f.link, ...patch }, digester),
    );
});
test("replay pins exact source, query binding, receipt, publication and current authorities", () => {
  const f = fixture();
  for (const patch of [
    { reference: { ...f.input.reference, assetRevision: 2 } },
    { generationLinkDigest: digester.sha256("foreign") },
    { actor: { ...actor, principalId: "foreign" } },
    { actor: { ...actor, actorId: "foreign-session-actor" } },
    { receipt: { ...f.input.receipt, idempotencyKey: "foreign" } },
    { sourcePin: { ...f.input.sourcePin, authorityEpoch: "changed" } },
    { executionPin: { ...f.input.executionPin, selectionRevision: 9 } },
  ])
    assert.throws(() =>
      assertProjectQueryReplay({ ...f.replay, ...patch }, digester),
    );
});
