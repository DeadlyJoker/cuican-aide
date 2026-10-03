import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  appendConceptAssetRevision,
  appendProjectBriefRevision,
  createConceptAsset,
  createCreativeProject,
  createExtensionRunBinding,
  createProjectGenerationLink,
  extensionCanonicalJson,
  assertProjectGenerationReplay,
  parseProjectGenerationLink,
  parseProjectGenerationReference,
  setCreativeProjectState,
  validateProjectGenerationSource,
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
function fixture() {
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
const fails = (code: string) => (error: unknown) =>
  error instanceof Error && error.message === code;

test("generation freezes the saved input and complete original execution identity without changing source records", () => {
  const { input, link } = fixture();
  assert.equal(link.reference.assetId, "opaque-asset");
  assert.equal(link.ownerPrincipalId, "person");
  assert.equal(link.assetContentDigest, input.assetRevision.contentDigest);
  assert.equal(link.briefContentDigest, input.brief.contentDigest);
  assert.notEqual(link.assetContentDigest, link.binding.inputDigest);
  assert.equal(input.project.revision, 3);
  assert.equal(input.asset.revision, 1);
  assert.deepEqual(parseProjectGenerationLink(link, digester), link);
  const copied = structuredClone(input);
  const mutable = {
    ...copied,
    binding: { ...copied.binding, target: { ...copied.binding.target } },
  };
  const saved = createProjectGenerationLink(mutable, digester);
  mutable.reference.assetRevision = 7;
  mutable.binding.target.authorityId = "changed";
  mutable.receipt.idempotencyKey = "changed";
  assert.equal(saved.reference.assetRevision, 1);
  assert.equal(saved.binding.target.authorityId, "authority");
  for (const value of [
    saved,
    saved.reference,
    saved.binding,
    saved.binding.target,
    saved.receipt,
  ])
    assert.ok(Object.isFrozen(value));
});

test("historical input requires its exact saved brief and current independent metadata CAS", () => {
  const { input } = fixture();
  const saved = appendProjectBriefRevision(
    {
      project: input.project,
      actor,
      expectedProjectRevision: 3,
      text: "新需求",
      at,
    },
    digester,
  );
  const changed = appendConceptAssetRevision(
    {
      project: saved.project,
      actor,
      expectedProjectRevision: 4,
      expectedAssetMetadataRevision: 1,
      asset: input.asset,
      brief: saved.brief,
      prompt: "新画面",
      at,
    },
    digester,
  );
  const historical = {
    ...input,
    project: changed.project,
    asset: changed.asset,
    reference: {
      ...input.reference,
      expectedProjectRevision: 5,
      expectedAssetMetadataRevision: 2,
    },
  };
  const link = createProjectGenerationLink(historical, digester);
  assert.equal(link.reference.assetRevision, 1);
  assert.equal(link.reference.expectedAssetMetadataRevision, 2);
  assert.equal(link.briefRevision, 1);
  assert.throws(
    () =>
      createProjectGenerationLink(
        { ...historical, brief: saved.brief },
        digester,
      ),
    fails("creative_project_brief_reference_invalid"),
  );
  assert.throws(
    () =>
      createProjectGenerationLink(
        {
          ...historical,
          reference: {
            ...historical.reference,
            expectedAssetMetadataRevision: 1,
          },
        },
        digester,
      ),
    fails("creative_project_asset_revision_conflict"),
  );
});

test("new admission rejects stale CAS, archived projects and mismatched confirmed task content", () => {
  const { input } = fixture();
  assert.throws(
    () =>
      createProjectGenerationLink(
        {
          ...input,
          reference: { ...input.reference, expectedProjectRevision: 2 },
        },
        digester,
      ),
    fails("creative_project_revision_conflict"),
  );
  const archived = setCreativeProjectState({
    project: input.project,
    actor,
    expectedProjectRevision: 3,
    state: "archived",
    at,
  });
  assert.throws(
    () =>
      createProjectGenerationLink(
        {
          ...input,
          project: archived,
          reference: { ...input.reference, expectedProjectRevision: 4 },
        },
        digester,
      ),
    fails("creative_project_archived"),
  );
  const binding = createExtensionRunBinding(
    {
      ...input.binding,
      inputDigest: digester.sha256(
        extensionCanonicalJson({ prompt: "未确认草稿" }),
      ),
    },
    digester,
  );
  assert.throws(
    () => createProjectGenerationLink({ ...input, binding }, digester),
    fails("creative_project_generation_input_mismatch"),
  );
});

test("owner, scope, actor and query binding cannot be substituted", () => {
  const { input } = fixture();
  assert.throws(
    () =>
      createProjectGenerationLink(
        { ...input, actor: { ...actor, principalId: "another" } },
        digester,
      ),
    fails("creative_project_owner_mismatch"),
  );
  assert.throws(
    () =>
      createProjectGenerationLink(
        { ...input, asset: { ...input.asset, spaceId: "another" } },
        digester,
      ),
    fails("creative_project_scope_mismatch"),
  );
  for (const patch of [
    { actorId: "another" },
    {
      source: {
        runId: "source-run",
        operationId: "operation",
        bindingDigest: digester.sha256("source"),
      },
    },
  ]) {
    const binding = createExtensionRunBinding(
      { ...input.binding, ...patch },
      digester,
    );
    assert.throws(
      () => createProjectGenerationLink({ ...input, binding }, digester),
      fails("creative_project_generation_binding_invalid"),
    );
  }
  assert.throws(
    () =>
      createProjectGenerationLink(
        { ...input, receipt: { ...input.receipt, actorId: "another" } },
        digester,
      ),
    fails("creative_project_generation_binding_invalid"),
  );
});

test("bounded exact reference parsing never invokes accessors and preserves the original CAS", () => {
  const { input } = fixture();
  const mutable = structuredClone(input.reference);
  const captured = parseProjectGenerationReference(mutable);
  mutable.assetId = "replaced";
  assert.equal(captured.assetId, "opaque-asset");
  for (const bad of [
    { ...input.reference, principalId: "injected" },
    { ...input.reference, assetRevision: 0 },
    { ...input.reference, assetId: "x".repeat(129) },
    {
      ...input.reference,
      expectedProjectRevision: Number.MAX_SAFE_INTEGER + 1,
    },
  ])
    assert.throws(() => parseProjectGenerationReference(bad));
  let reads = 0;
  const accessor = { ...input.reference };
  Object.defineProperty(accessor, "assetId", {
    enumerable: true,
    get() {
      reads++;
      return "injected";
    },
  });
  assert.throws(
    () => parseProjectGenerationReference(accessor),
    fails("creative_project_json_invalid"),
  );
  assert.equal(reads, 0);
});

test("link integrity rejects changed digests, identities and unsupported persisted schemas", () => {
  const { link } = fixture();
  for (const patch of [
    { briefContentDigest: digester.sha256("different") },
    { createdAt: "2026-10-03T01:00:00.000Z" },
    { ownerPrincipalId: "another" },
  ])
    assert.throws(
      () => parseProjectGenerationLink({ ...link, ...patch }, digester),
      fails("creative_project_digest_mismatch"),
    );
  assert.throws(
    () =>
      parseProjectGenerationLink(
        { ...link, schemaVersion: "crewon.project-generation-link.v99" },
        digester,
      ),
    fails("creative_project_generation_schema_unsupported"),
  );
  assert.throws(
    () =>
      parseProjectGenerationLink(
        { ...link, reference: { ...link.reference, projectId: "another" } },
        digester,
      ),
    fails("creative_project_scope_mismatch"),
  );
  assert.throws(
    () =>
      parseProjectGenerationLink(
        {
          ...link,
          binding: { ...link.binding, inputDigest: digester.sha256("tamper") },
        },
        digester,
      ),
    fails("extension_run_binding_digest_mismatch"),
  );
});

test("replay uses the original Run and frozen reference without requiring current mutable metadata", () => {
  const { input, link } = fixture();
  const replay = {
    link,
    reference: input.reference,
    actor,
    binding: input.binding,
    receipt: input.receipt,
  };
  assertProjectGenerationReplay(replay, digester);
  const differentRun = createExtensionRunBinding(
    { ...input.binding, runId: "newly-prepared-run" },
    digester,
  );
  assert.throws(
    () =>
      assertProjectGenerationReplay(
        { ...replay, binding: differentRun },
        digester,
      ),
    fails("creative_project_generation_replay_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectGenerationReplay(
        {
          ...replay,
          reference: { ...input.reference, expectedProjectRevision: 4 },
        },
        digester,
      ),
    fails("creative_project_generation_replay_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectGenerationReplay(
        { ...replay, receipt: { ...input.receipt, idempotencyKey: "new-key" } },
        digester,
      ),
    fails("creative_project_generation_replay_mismatch"),
  );
  assert.throws(
    () =>
      assertProjectGenerationReplay(
        { ...replay, actor: { ...actor, principalId: "another" } },
        digester,
      ),
    fails("creative_project_owner_mismatch"),
  );
});

test("source validation keeps immutable revision hashes and rejects absent or alien source identities", () => {
  const { input } = fixture();
  const source = {
    actor,
    reference: input.reference,
    project: input.project,
    asset: input.asset,
    assetRevision: input.assetRevision,
    brief: input.brief,
  };
  assert.equal(
    validateProjectGenerationSource(source, digester).assetRevision.prompt,
    "  原文画面\n",
  );
  assert.throws(
    () =>
      validateProjectGenerationSource(
        { ...source, reference: { ...source.reference, assetRevision: 2 } },
        digester,
      ),
    fails("creative_project_generation_source_invalid"),
  );
  assert.throws(
    () =>
      validateProjectGenerationSource(
        {
          ...source,
          assetRevision: { ...source.assetRevision, prompt: "篡改" },
        },
        digester,
      ),
    fails("creative_project_digest_mismatch"),
  );
});
