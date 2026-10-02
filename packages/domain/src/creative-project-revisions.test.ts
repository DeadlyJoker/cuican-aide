import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createCreativeProject,
  renameCreativeProject,
  setCreativeProjectState,
} from "./creative-project.ts";
import { CreativeProjectError } from "./creative-project-validation.ts";
import {
  appendConceptAssetRevision,
  appendProjectBriefRevision,
  createConceptAsset,
  parseConceptAssetRevision,
  parseProjectBriefRevision,
} from "./creative-project-revisions.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const scope = { tenantId: "tenant", spaceId: "space", projectId: "project" };
const actor = {
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
  principalId: "person",
  actorId: "actor",
};
const at = "2026-10-02T00:00:00.000Z";
const earlier = "2026-10-01T23:00:00.000Z";
const project = createCreativeProject({ scope, actor, title: "短剧", at });
const firstBrief = appendProjectBriefRevision(
  {
    project,
    actor,
    expectedProjectRevision: 1,
    text: "  首版需求\n质感写实  ",
    at,
  },
  digester,
);
const createInput = {
  project: firstBrief.project,
  actor,
  expectedProjectRevision: 2,
  brief: firstBrief.brief,
  assetId: "asset",
  name: "雨夜概念图",
  prompt: "  雨夜场景，写实质感  ",
  at,
};
const concept = createConceptAsset(createInput, digester);
const appendInput = {
  project: concept.project,
  actor,
  expectedProjectRevision: 3,
  expectedAssetMetadataRevision: 1,
  asset: concept.asset,
  brief: firstBrief.brief,
  prompt: createInput.prompt,
  at,
};

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof CreativeProjectError && error.code === code;
}

test("brief appends preserve old inputs and explicit identical text creates a new immutable revision", () => {
  const mutable = structuredClone({
    project: { ...firstBrief.project },
    actor,
    expectedProjectRevision: 2,
    text: firstBrief.brief.text,
    at: earlier,
  });
  const before = structuredClone(mutable);
  const second = appendProjectBriefRevision(mutable, digester);
  assert.deepEqual(mutable, before);
  mutable.project.title = "new title";
  mutable.text = "changed";
  assert.equal(second.project.revision, 3);
  assert.equal(second.project.latestBriefRevision, 2);
  assert.equal(second.brief.briefRevision, 2);
  assert.equal(second.brief.text, firstBrief.brief.text);
  assert.equal(second.brief.createdAt, earlier);
  assert.notEqual(second.brief.contentDigest, firstBrief.brief.contentDigest);
  assert.equal(firstBrief.project.latestBriefRevision, 1);
  assert.ok(Object.isFrozen(second));
  assert.ok(Object.isFrozen(second.project));
  assert.ok(Object.isFrozen(second.brief));
  assert.deepEqual(
    parseProjectBriefRevision(second.brief, digester),
    second.brief,
  );
});

test("concept versions freeze the exact brief while advancing both metadata CAS and input revisions", () => {
  const mutable = structuredClone({
    ...createInput,
    brief: { ...createInput.brief },
  });
  const created = createConceptAsset(mutable, digester);
  mutable.brief.text = "overwritten";
  mutable.prompt = "overwritten";
  mutable.name = "overwritten";
  assert.equal(created.project.revision, 3);
  assert.equal(created.asset.revision, 1);
  assert.equal(created.asset.latestAssetRevision, 1);
  assert.equal(created.assetRevision.assetRevision, 1);
  assert.equal(
    created.assetRevision.briefRevision,
    firstBrief.brief.briefRevision,
  );
  assert.equal(
    created.assetRevision.briefContentDigest,
    firstBrief.brief.contentDigest,
  );
  assert.equal(created.assetRevision.prompt, createInput.prompt);
  assert.equal(created.asset.name, createInput.name);
  assert.ok(!Object.hasOwn(created.asset, "prompt"));
  assert.ok(!Object.hasOwn(created.asset, "url"));
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.asset));
  assert.ok(Object.isFrozen(created.assetRevision));
  const laterBrief = appendProjectBriefRevision(
    {
      project: created.project,
      actor,
      expectedProjectRevision: 3,
      text: "第二版需求",
      at,
    },
    digester,
  );
  const appended = appendConceptAssetRevision(
    {
      ...appendInput,
      project: laterBrief.project,
      expectedProjectRevision: 4,
      at: earlier,
    },
    digester,
  );
  assert.equal(appended.project.revision, 5);
  assert.equal(appended.asset.revision, 2);
  assert.equal(appended.asset.latestAssetRevision, 2);
  assert.equal(appended.assetRevision.assetRevision, 2);
  assert.equal(appended.assetRevision.briefRevision, 1);
  assert.equal(
    appended.assetRevision.briefContentDigest,
    firstBrief.brief.contentDigest,
  );
  assert.notEqual(
    appended.assetRevision.contentDigest,
    created.assetRevision.contentDigest,
  );
  assert.deepEqual(
    parseConceptAssetRevision(appended.assetRevision, digester),
    appended.assetRevision,
  );
  assert.equal(created.asset.latestAssetRevision, 1);
});

test("archiving blocks new creative input while preserving existing revisions and permitting restore", () => {
  const archived = setCreativeProjectState({
    project: concept.project,
    actor,
    expectedProjectRevision: 3,
    state: "archived",
    at,
  });
  for (const transition of [
    () =>
      appendProjectBriefRevision(
        {
          project: archived,
          actor,
          expectedProjectRevision: 4,
          text: "new",
          at,
        },
        digester,
      ),
    () =>
      createConceptAsset(
        { ...createInput, project: archived, expectedProjectRevision: 4 },
        digester,
      ),
    () =>
      appendConceptAssetRevision(
        { ...appendInput, project: archived, expectedProjectRevision: 4 },
        digester,
      ),
  ])
    assert.throws(transition, hasCode("creative_project_archived"));
  assert.deepEqual(
    parseConceptAssetRevision(concept.assetRevision, digester),
    concept.assetRevision,
  );
  const restored = setCreativeProjectState({
    project: archived,
    actor,
    expectedProjectRevision: 4,
    state: "active",
    at,
  });
  assert.equal(
    appendConceptAssetRevision(
      { ...appendInput, project: restored, expectedProjectRevision: 5 },
      digester,
    ).asset.latestAssetRevision,
    2,
  );
});

test("every creative transition checks principal, tenant/space and required project CAS", () => {
  for (const changedActor of [
    { ...actor, principalId: "other" },
    { ...actor, tenantId: "other" },
    { ...actor, spaceId: "other" },
  ]) {
    const code =
      changedActor.principalId !== actor.principalId
        ? "creative_project_owner_mismatch"
        : "creative_project_scope_mismatch";
    for (const transition of [
      () =>
        appendProjectBriefRevision(
          {
            project,
            actor: changedActor,
            expectedProjectRevision: 1,
            text: "new",
            at,
          },
          digester,
        ),
      () =>
        createConceptAsset({ ...createInput, actor: changedActor }, digester),
      () =>
        appendConceptAssetRevision(
          { ...appendInput, actor: changedActor },
          digester,
        ),
    ])
      assert.throws(transition, hasCode(code));
  }
  assert.throws(
    () =>
      createConceptAsset(
        { ...createInput, expectedProjectRevision: 1 },
        digester,
      ),
    hasCode("creative_project_revision_conflict"),
  );
  assert.throws(
    () =>
      appendConceptAssetRevision(
        { ...appendInput, expectedAssetMetadataRevision: 2 },
        digester,
      ),
    hasCode("creative_project_asset_revision_conflict"),
  );
  const anotherAuditActor = appendConceptAssetRevision(
    { ...appendInput, actor: { ...actor, actorId: "new-audit" } },
    digester,
  );
  assert.equal(anotherAuditActor.assetRevision.createdByActorId, "new-audit");
  assert.equal(anotherAuditActor.project.ownerPrincipalId, actor.principalId);
});

test("concept creation rejects cross-scope, ahead-of-project and forged brief references", () => {
  const foreignProject = createCreativeProject({
    scope: { ...scope, projectId: "other-project" },
    actor,
    title: "其他项目",
    at,
  });
  const foreign = appendProjectBriefRevision(
    {
      project: foreignProject,
      actor,
      expectedProjectRevision: 1,
      text: "foreign",
      at,
    },
    digester,
  );
  assert.throws(
    () =>
      createConceptAsset({ ...createInput, brief: foreign.brief }, digester),
    hasCode("creative_project_scope_mismatch"),
  );
  assert.throws(
    () =>
      appendConceptAssetRevision(
        { ...appendInput, asset: { ...concept.asset, spaceId: "other" } },
        digester,
      ),
    hasCode("creative_project_scope_mismatch"),
  );
  assert.throws(
    () =>
      createConceptAsset(
        { ...createInput, project, expectedProjectRevision: 1 },
        digester,
      ),
    hasCode("creative_project_brief_reference_invalid"),
  );
  assert.throws(
    () =>
      createConceptAsset(
        { ...createInput, brief: { ...firstBrief.brief, text: "changed" } },
        digester,
      ),
    hasCode("creative_project_digest_mismatch"),
  );
});

test("digests authenticate scope, revisions, content and audit without mutable project or asset names", () => {
  for (const patch of [
    { tenantId: "other" },
    { spaceId: "other" },
    { projectId: "other" },
    { briefRevision: 2 },
    { text: "changed" },
    { createdByActorId: "other" },
    { createdAt: earlier },
  ])
    assert.throws(
      () =>
        parseProjectBriefRevision({ ...firstBrief.brief, ...patch }, digester),
      hasCode("creative_project_digest_mismatch"),
    );
  for (const patch of [
    { tenantId: "other" },
    { spaceId: "other" },
    { projectId: "other" },
    { assetId: "other" },
    { assetRevision: 2 },
    { briefRevision: 2 },
    { briefContentDigest: `sha256:${"b".repeat(64)}` },
    { prompt: "changed" },
    { createdByActorId: "other" },
    { createdAt: earlier },
  ])
    assert.throws(
      () =>
        parseConceptAssetRevision(
          { ...concept.assetRevision, ...patch },
          digester,
        ),
      hasCode("creative_project_digest_mismatch"),
    );
  const renamed = renameCreativeProject({
    project: concept.project,
    actor,
    expectedProjectRevision: 3,
    title: "重命名",
    at,
  });
  assert.equal(renamed.latestBriefRevision, firstBrief.brief.briefRevision);
  assert.equal(
    parseProjectBriefRevision(firstBrief.brief, digester).contentDigest,
    firstBrief.brief.contentDigest,
  );
  assert.equal(
    parseConceptAssetRevision(concept.assetRevision, digester).contentDigest,
    concept.assetRevision.contentDigest,
  );
  assert.throws(
    () => parseProjectBriefRevision(firstBrief.brief, { sha256: () => "bad" }),
    hasCode("creative_project_digest_invalid"),
  );
});

test("revision parsing and creative mutations reject unknown data, accessors and unsafe revision increments", () => {
  assert.throws(
    () =>
      parseProjectBriefRevision(
        { ...firstBrief.brief, schemaVersion: "future" },
        digester,
      ),
    hasCode("creative_project_schema_unsupported"),
  );
  assert.throws(
    () =>
      parseConceptAssetRevision(
        {
          ...concept.assetRevision,
          resultUrl: "https://example.invalid/image",
        },
        digester,
      ),
    hasCode("creative_project_fields_invalid"),
  );
  let accessed = false;
  const getter = Object.defineProperty({ ...firstBrief.brief }, "text", {
    enumerable: true,
    get() {
      accessed = true;
      return "secret";
    },
  });
  assert.throws(
    () => parseProjectBriefRevision(getter, digester),
    hasCode("creative_project_json_invalid"),
  );
  assert.equal(accessed, false);
  const unsafeProject = {
    ...concept.project,
    revision: Number.MAX_SAFE_INTEGER,
  };
  assert.throws(
    () =>
      appendProjectBriefRevision(
        {
          project: unsafeProject,
          actor,
          expectedProjectRevision: unsafeProject.revision,
          text: "new",
          at,
        },
        digester,
      ),
    hasCode("creative_project_revision_exhausted"),
  );
  assert.throws(
    () =>
      createConceptAsset(
        {
          ...createInput,
          project: unsafeProject,
          expectedProjectRevision: unsafeProject.revision,
        },
        digester,
      ),
    hasCode("creative_project_revision_exhausted"),
  );
  const unsafeAsset = {
    ...concept.asset,
    revision: Number.MAX_SAFE_INTEGER,
    latestAssetRevision: Number.MAX_SAFE_INTEGER,
  };
  assert.throws(
    () =>
      appendConceptAssetRevision(
        {
          ...appendInput,
          asset: unsafeAsset,
          expectedAssetMetadataRevision: unsafeAsset.revision,
        },
        digester,
      ),
    hasCode("creative_project_revision_exhausted"),
  );
});
