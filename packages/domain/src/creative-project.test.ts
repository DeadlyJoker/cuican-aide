import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreativeProject,
  renameCreativeProject,
  setCreativeProjectState,
  validateConceptAsset,
  validateCreativeProject,
} from "./creative-project.ts";
import {
  CreativeProjectError,
  creativeProjectBriefText,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectPrompt,
  creativeProjectRevision,
  creativeProjectTimestamp,
  creativeProjectTitle,
  validateCreativeProjectActor,
  validateCreativeProjectScope,
} from "./creative-project-validation.ts";

const scope = { tenantId: "tenant", spaceId: "space", projectId: "project" };
const actor = {
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
  principalId: "person",
  actorId: "actor",
};
const at = "2026-10-02T00:00:00.000Z";
const later = "2026-10-02T01:00:00.000Z";
const earlier = "2026-10-01T23:00:00.000Z";
const createInput = { scope, actor, title: "短剧", at };
const project = createCreativeProject(createInput);

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof CreativeProjectError && error.code === code;
}

test("project creation derives the owner from principal and detaches every input", () => {
  const mutable = structuredClone(createInput);
  const created = createCreativeProject(mutable);
  mutable.scope.projectId = "changed";
  mutable.actor.principalId = "another";
  mutable.actor.actorId = "new-actor";
  assert.equal(created.projectId, "project");
  assert.equal(created.ownerPrincipalId, "person");
  assert.equal(created.createdByActorId, "actor");
  assert.equal(created.revision, 1);
  assert.equal(created.latestBriefRevision, 0);
  assert.equal(created.state, "active");
  assert.equal(created.kind, "short-drama");
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(validateCreativeProjectScope(scope)));
  assert.ok(Object.isFrozen(validateCreativeProjectActor(actor)));
  assert.notEqual(validateCreativeProject(created), created);
  assert.throws(
    () =>
      createCreativeProject({
        ...createInput,
        actor: { ...actor, spaceId: "other" },
      }),
    hasCode("creative_project_scope_mismatch"),
  );
  const injectedOwner = { ...createInput, ownerPrincipalId: "another" };
  assert.throws(
    () => createCreativeProject(injectedOwner),
    hasCode("creative_project_fields_invalid"),
  );
});

test("metadata changes use owner principal and CAS while wall-clock changes remain audit data", () => {
  const rename = {
    project,
    actor: { ...actor, actorId: "second-actor" },
    expectedProjectRevision: 1,
    title: "新标题",
    at: earlier,
  };
  const renamed = renameCreativeProject(rename);
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.updatedByActorId, "second-actor");
  assert.equal(renamed.updatedAt, earlier);
  assert.equal(renamed.createdAt, at);
  assert.equal(project.title, "短剧");
  assert.throws(
    () =>
      renameCreativeProject({
        ...rename,
        actor: { ...actor, principalId: "stranger" },
      }),
    hasCode("creative_project_owner_mismatch"),
  );
  assert.throws(
    () =>
      renameCreativeProject({
        ...rename,
        actor: { ...actor, tenantId: "other" },
      }),
    hasCode("creative_project_scope_mismatch"),
  );
  assert.throws(
    () => renameCreativeProject({ ...rename, expectedProjectRevision: 2 }),
    hasCode("creative_project_revision_conflict"),
  );
  const archived = setCreativeProjectState({
    project: renamed,
    actor,
    expectedProjectRevision: 2,
    state: "archived",
    at: later,
  });
  const renamedArchived = renameCreativeProject({
    ...rename,
    project: archived,
    expectedProjectRevision: 3,
    title: "归档后改名",
  });
  const restored = setCreativeProjectState({
    project: renamedArchived,
    actor,
    expectedProjectRevision: 4,
    state: "active",
    at: earlier,
  });
  assert.equal(restored.revision, 5);
  assert.equal(restored.state, "active");
  assert.equal(restored.latestBriefRevision, 0);
});

test("same-value metadata commands retain revision and audit only after validating all input", () => {
  const rename = {
    project,
    actor,
    expectedProjectRevision: 1,
    title: project.title,
    at: later,
  };
  assert.deepEqual(renameCreativeProject(rename), project);
  assert.deepEqual(
    setCreativeProjectState({
      project,
      actor,
      expectedProjectRevision: 1,
      state: "active",
      at: later,
    }),
    project,
  );
  assert.throws(
    () => renameCreativeProject({ ...rename, at: "2026-10-02" }),
    hasCode("creative_project_timestamp_invalid"),
  );
  const extra = { ...rename, ignored: true };
  assert.throws(
    () => renameCreativeProject(extra),
    hasCode("creative_project_fields_invalid"),
  );
  assert.throws(
    () =>
      renameCreativeProject({
        ...rename,
        actor: { ...actor, principalId: "other" },
      }),
    hasCode("creative_project_owner_mismatch"),
  );
  assert.throws(
    () =>
      setCreativeProjectState({
        project,
        actor,
        expectedProjectRevision: 2,
        state: "active",
        at,
      }),
    hasCode("creative_project_revision_conflict"),
  );
});

test("text limits distinguish title scalars, prompt UTF-16 units and brief UTF-8 bytes", () => {
  assert.equal(creativeProjectTitle("😀".repeat(160)), "😀".repeat(160));
  assert.throws(
    () => creativeProjectTitle("😀".repeat(161)),
    hasCode("creative_project_text_limit"),
  );
  assert.equal(creativeProjectPrompt("😀".repeat(1_000)).length, 2_000);
  assert.throws(
    () => creativeProjectPrompt("😀".repeat(1_001)),
    hasCode("creative_project_text_limit"),
  );
  const brief = `${"汉".repeat(2_730)}ab`;
  assert.equal(
    new TextEncoder().encode(creativeProjectBriefText(brief)).length,
    8_192,
  );
  assert.throws(
    () => creativeProjectBriefText(`${brief}c`),
    hasCode("creative_project_text_limit"),
  );
  assert.equal(creativeProjectBriefText("  保留\n需求  "), "  保留\n需求  ");
  assert.equal(creativeProjectPrompt("  保留提示  "), "  保留提示  ");
  assert.equal(creativeProjectOpaqueId("人".repeat(128)).length, 128);
  assert.throws(
    () => creativeProjectOpaqueId("人".repeat(129)),
    hasCode("creative_project_identity_invalid"),
  );
  for (const value of ["", "  ", "bad\u0000text"])
    assert.throws(
      () => creativeProjectBriefText(value),
      hasCode("creative_project_text_invalid"),
    );
  assert.throws(
    () => creativeProjectTitle(" leading "),
    hasCode("creative_project_text_invalid"),
  );
  for (const parse of [
    creativeProjectTitle,
    creativeProjectPrompt,
    creativeProjectBriefText,
    creativeProjectOpaqueId,
  ])
    assert.throws(
      () => parse("bad\ud800"),
      hasCode("creative_project_unicode_invalid"),
    );
});

test("metadata parsing rejects unknown fields, versions, accessors and malformed JSON without invoking user code", () => {
  let accessed = false;
  const accessor = Object.defineProperty({ ...project }, "title", {
    enumerable: true,
    get() {
      accessed = true;
      return "secret";
    },
  });
  assert.throws(
    () => validateCreativeProject(accessor),
    hasCode("creative_project_json_invalid"),
  );
  assert.equal(accessed, false);
  const nested = {
    ...createInput,
    actor: Object.defineProperty({ ...actor }, "principalId", {
      enumerable: true,
      get() {
        accessed = true;
        return "person";
      },
    }),
  };
  assert.throws(
    () => createCreativeProject(nested),
    hasCode("creative_project_json_invalid"),
  );
  assert.equal(accessed, false);
  assert.throws(
    () => validateCreativeProject({ ...project, schemaVersion: "future" }),
    hasCode("creative_project_schema_unsupported"),
  );
  assert.throws(
    () => validateCreativeProject({ ...project, kind: "video" }),
    hasCode("creative_project_kind_invalid"),
  );
  assert.throws(
    () => validateCreativeProject({ ...project, extra: true }),
    hasCode("creative_project_fields_invalid"),
  );
  assert.throws(
    () => validateCreativeProject({ ...project, title: "\udfff" }),
    hasCode("creative_project_json_invalid"),
  );
  assert.throws(
    () => validateCreativeProject(Object.assign(Object.create({}), project)),
    hasCode("creative_project_json_invalid"),
  );
  assert.throws(
    () => validateCreativeProject({ ...project, [Symbol("hidden")]: true }),
    hasCode("creative_project_json_invalid"),
  );
  const cycle: Record<string, unknown> = { ...project };
  cycle.extra = cycle;
  assert.throws(
    () => validateCreativeProject(cycle),
    hasCode("creative_project_json_invalid"),
  );
  assert.throws(
    () => validateCreativeProject({ ...project, title: "x".repeat(65_537) }),
    hasCode("creative_project_json_limit"),
  );
  const hidden = Object.defineProperty({ ...project }, "hidden", {
    value: true,
  });
  assert.throws(
    () => validateCreativeProject(hidden),
    hasCode("creative_project_json_limit"),
  );
});

test("metadata revision invariants and integer overflow are fail-closed", () => {
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])
    assert.throws(
      () => validateCreativeProject({ ...project, revision }),
      (error) => error instanceof CreativeProjectError,
    );
  assert.equal(creativeProjectRevision(0, { minimum: 0 }), 0);
  assert.throws(
    () => creativeProjectRevision(0),
    hasCode("creative_project_revision_invalid"),
  );
  assert.throws(
    () => validateCreativeProject({ ...project, latestBriefRevision: 1 }),
    hasCode("creative_project_revision_invariant_invalid"),
  );
  const asset = {
    schemaVersion: "crewon.concept-asset.v0",
    ...scope,
    assetId: "asset",
    name: "概念图",
    revision: 1,
    latestAssetRevision: 2,
    createdByActorId: actor.actorId,
    createdAt: at,
    updatedByActorId: actor.actorId,
    updatedAt: earlier,
  };
  assert.throws(
    () => validateConceptAsset(asset),
    hasCode("creative_project_revision_invariant_invalid"),
  );
  assert.equal(
    validateConceptAsset({ ...asset, revision: 3 }).latestAssetRevision,
    2,
  );
  const exhausted = { ...project, revision: Number.MAX_SAFE_INTEGER };
  assert.throws(
    () =>
      renameCreativeProject({
        project: exhausted,
        actor,
        expectedProjectRevision: exhausted.revision,
        title: "new",
        at,
      }),
    hasCode("creative_project_revision_exhausted"),
  );
  assert.deepEqual(
    renameCreativeProject({
      project: exhausted,
      actor,
      expectedProjectRevision: exhausted.revision,
      title: exhausted.title,
      at: later,
    }),
    exhausted,
  );
  assert.throws(
    () => creativeProjectTimestamp("2026-02-30T00:00:00.000Z"),
    hasCode("creative_project_timestamp_invalid"),
  );
  assert.throws(
    () => creativeProjectDigest(`sha256:${"A".repeat(64)}`),
    hasCode("creative_project_digest_invalid"),
  );
});
