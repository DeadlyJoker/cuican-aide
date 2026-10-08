import assert from "node:assert/strict";
import test from "node:test";
import { extensionToolName } from "./extension-manifest.ts";
import { PROJECT_FOUNDATION_TOOL_OPERATION_IDS } from "@crewon/contracts/project-foundation-tools";
import {
  assertProjectFoundationRunFoundation,
  assertProjectFoundationToolRequest,
  createProjectFoundationRunAdmission,
  parseProjectFoundationRunAdmission,
  PROJECT_FOUNDATION_RUN_OPERATIONS,
} from "./project-foundation-run-admission.ts";
import {
  foundationRunAdmissionFixture as fixture,
  foundationRunDigester as d,
  foundationRunProposal,
} from "./project-foundation-run-admission.test-support.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  createProjectStageRunAdmission,
  projectStageOperations,
} from "./project-stage-run-admission.ts";

test("all eight Foundation operations fit the unchanged published extension operation/name boundary", () => {
  assert.deepEqual(
    PROJECT_FOUNDATION_RUN_OPERATIONS,
    PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  );
  for (const operation of PROJECT_FOUNDATION_RUN_OPERATIONS) {
    assert.ok(operation.length <= 24);
    assert.equal(
      extensionToolName("crewon.short-drama", operation),
      `crewon_short_drama__${operation}`,
    );
  }
});

test("Foundation facts attach to the exact original discussion without changing stage or Run input", () => {
  for (const origin of ["creative", "novel"] as const) {
    const f = fixture(origin);
    const originals = JSON.stringify({
      binding: f.binding,
      stage: f.stageAdmission,
      extension: f.extensionBinding,
    });
    const scope = createProjectFoundationRunAdmission(f, d);
    assert.deepEqual(parseProjectFoundationRunAdmission(scope, d), scope);
    assert.equal(
      scope.projectStageAdmissionDigest,
      f.stageAdmission.contentDigest,
    );
    assert.equal(scope.taskInputDigest, f.stageAdmission.taskInputDigest);
    assert.equal(
      scope.parametersDigest,
      d.sha256(extensionCanonicalJson(f.foundation.parameters)),
    );
    assert.equal(scope.workspaceId, "actual-workspace");
    assert.equal(
      JSON.stringify({
        binding: f.binding,
        stage: f.stageAdmission,
        extension: f.extensionBinding,
      }),
      originals,
    );
    assert.deepEqual(projectStageOperations({ kind: "discussion" }), [
      "project_context_read",
      "project_read",
      "outline_read",
      "script_read",
      "content_read",
      "text_history",
    ]);
    assert.ok(Object.isFrozen(scope));
    assert.ok(Object.isFrozen(scope.source ?? scope.actor));
    assert.deepEqual(
      scope.allowedOperations,
      PROJECT_FOUNDATION_RUN_OPERATIONS,
    );
  }
});
test("Foundation creation rejects foreign owner/project/install/Run links and every non-discussion stage", () => {
  const f = fixture();
  for (const patch of [
    { actor: { ...f.actor, principalId: "foreign" } },
    { foundation: { ...f.foundation, projectId: "foreign" } },
    { foundation: { ...f.foundation, tenantId: "foreign" } },
    { foundation: { ...f.foundation, ownerPrincipalId: "foreign" } },
    { admission: { ...f.admission, actorId: "foreign" } },
    { admission: { ...f.admission, runId: "foreign" } },
    { admission: { ...f.admission, threadId: "foreign" } },
    { admission: { ...f.admission, selectionRevision: 3 } },
    { admission: { ...f.admission, action: "image.generate" } },
  ])
    assert.throws(() =>
      createProjectFoundationRunAdmission({ ...f, ...patch } as typeof f, d),
    );
  const stageAdmission = createProjectStageRunAdmission(
    {
      actor: f.actor,
      binding: f.binding,
      admission: f.admission,
      extensionBinding: f.extensionBinding,
      stage: { kind: "brief", briefRevision: 1 },
      sources: {
        brief: { briefRevision: 1, contentDigest: d.sha256("brief") },
        outline: null,
      },
      at: f.at,
    },
    d,
  );
  assert.throws(() =>
    createProjectFoundationRunAdmission({ ...f, stageAdmission }, d),
  );
});
test("exact independent admission schema, operation set and digest cannot be widened", () => {
  const scope = createProjectFoundationRunAdmission(fixture(), d);
  for (const patch of [
    { schemaVersion: "crewon.project-stage-run-admission.v1" },
    { extra: true },
    { projectStageAdmissionDigest: d.sha256("replacement") },
    { parametersDigest: d.sha256("replacement") },
    { foundationRevision: 2 },
    { allowedOperations: [...scope.allowedOperations, "foundation_confirm"] },
    { allowedOperations: scope.allowedOperations.slice(1) },
    { allowedOperations: [...scope.allowedOperations].reverse() },
  ])
    assert.throws(() =>
      parseProjectFoundationRunAdmission({ ...scope, ...patch }, d),
    );
  for (const patch of [
    { parametersRevision: 2 },
    { confirmedProposal: { revision: 1, digest: d.sha256("proposal") } },
    { actor: { ...scope.actor, tenantId: "foreign" } },
  ]) {
    const { contentDigest: _, ...body } = { ...scope, ...patch };
    assert.throws(() =>
      parseProjectFoundationRunAdmission(
        { ...body, contentDigest: d.sha256(extensionCanonicalJson(body)) },
        d,
      ),
    );
  }
});
test("same-revision parameter/source/confirmation tampering and changed heads invalidate the frozen facts", () => {
  const f = fixture("novel");
  const scope = createProjectFoundationRunAdmission(f, d);
  assert.doesNotThrow(() =>
    assertProjectFoundationRunFoundation(scope, f.foundation, d),
  );
  for (const patch of [
    { revision: 2 },
    { projectId: "foreign" },
    { ownerPrincipalId: "foreign" },
    { parameters: { ...f.foundation.parameters, episodeCount: 3 } },
    { source: { revision: 1, digest: d.sha256("replacement") } },
    { source: null },
    {
      revision: 2,
      confirmedProposal: { revision: 1, digest: d.sha256("proposal") },
    },
  ])
    assert.throws(
      () =>
        assertProjectFoundationRunFoundation(
          scope,
          { ...f.foundation, ...patch },
          d,
        ),
      /project_foundation_run_inputs_stale/u,
    );
  assert.throws(
    () =>
      assertProjectFoundationRunFoundation(
        { ...scope, contentDigest: d.sha256("corrupt marker") },
        f.foundation,
        d,
      ),
    /project_foundation_run_admission_invalid/u,
  );
});
test("latest candidate is a hint: saving a candidate preserves Foundation and subsequent read qualification", () => {
  const f = fixture();
  const candidate = foundationRunProposal(f);
  const scope = createProjectFoundationRunAdmission(f, d);
  assert.equal(scope.latestProposal, null);
  assert.doesNotThrow(() =>
    assertProjectFoundationRunFoundation(scope, f.foundation, d),
  );
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_proposal", {
      projectId: f.foundation.projectId,
      proposalRevision: candidate.revision,
      proposalDigest: candidate.contentDigest,
      startOffset: 0,
      limit: 1024,
    }),
  );
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_proposal_save", {
      projectId: f.foundation.projectId,
      expectedFoundationRevision: 1,
      expectedProposalRevision: candidate.revision,
      kind: "creative-plan",
      text: "新的候选方案。",
    }),
  );
  const laterScope = createProjectFoundationRunAdmission(
    { ...f, latestProposal: candidate },
    d,
  );
  assert.deepEqual(laterScope.latestProposal, {
    revision: 1,
    digest: candidate.contentDigest,
  });
  assert.equal(laterScope.foundationRevision, scope.foundationRevision);
  assert.doesNotThrow(() =>
    assertProjectFoundationRunFoundation(laterScope, f.foundation, d),
  );
  assert.throws(() =>
    createProjectFoundationRunAdmission(
      { ...f, latestProposal: { ...candidate, text: "fake source" } },
      d,
    ),
  );
  assert.throws(() =>
    createProjectFoundationRunAdmission(
      { ...f, latestProposal: { ...candidate, projectId: "foreign" } },
      d,
    ),
  );
});
test("source reads remain pinned and all request scopes, ranges and candidate CAS fields are bounded", () => {
  const f = fixture("novel");
  const scope = createProjectFoundationRunAdmission(f, d);
  const source = {
    projectId: scope.projectId,
    sourceRevision: 1,
    sourceDigest: scope.source!.digest,
  };
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_scope", {}),
  );
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_read", {
      projectId: scope.projectId,
      parametersStartOffset: 0,
      parametersLimit: 1024,
    }),
  );
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_source", source),
  );
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_source_page", {
      ...source,
      startOffset: 0,
      limit: 1024,
    }),
  );
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_chapters", {
      ...source,
      limit: 16,
    }),
  );
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_chapters", {
      ...source,
      afterStartOffset: 0,
      limit: 16,
    }),
  );
  assert.doesNotThrow(() =>
    assertProjectFoundationToolRequest(scope, "foundation_proposals", {
      projectId: scope.projectId,
      afterProposalRevision: 0,
      limit: 4,
    }),
  );
  for (const [operation, request] of [
    ["foundation_scope", { projectId: scope.projectId }],
    ["foundation_source", { ...source, sourceDigest: d.sha256("foreign") }],
    ["foundation_source", { ...source, sourceRevision: 2 }],
    ["foundation_source", { ...source, owner: f.actor }],
    ["foundation_read", { projectId: "foreign" }],
    [
      "foundation_read",
      { projectId: scope.projectId, parametersStartOffset: 8193 },
    ],
    ["foundation_read", { projectId: scope.projectId, parametersLimit: 1025 }],
    [
      "foundation_read",
      { projectId: scope.projectId, parametersStartOffset: null },
    ],
    ["foundation_source_page", { ...source, startOffset: -1, limit: 1024 }],
    ["foundation_source_page", { ...source, startOffset: 0, limit: 1025 }],
    ["foundation_chapters", { ...source, limit: 17 }],
    ["foundation_chapters", { ...source, afterStartOffset: null, limit: 16 }],
    [
      "foundation_proposals",
      { projectId: scope.projectId, afterProposalRevision: 0, limit: 5 },
    ],
    [
      "foundation_proposal_save",
      {
        projectId: scope.projectId,
        expectedFoundationRevision: 2,
        expectedProposalRevision: 0,
        kind: "novel-adaptation",
        text: "候选。",
      },
    ],
    [
      "foundation_proposal_save",
      {
        projectId: scope.projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "novel-adaptation",
        text: "候选。",
        idempotencyKey: "caller-key",
      },
    ],
    ["foundation_confirm", { projectId: scope.projectId }],
    ["script_save", { projectId: scope.projectId }],
  ] as const)
    assert.throws(() =>
      assertProjectFoundationToolRequest(scope, operation, request),
    );
});
test("input getters and JSON hooks are rejected without executing them", () => {
  const f = fixture();
  const scope = createProjectFoundationRunAdmission(f, d);
  let calls = 0;
  const create = { ...f };
  Object.defineProperty(create, "foundation", {
    enumerable: true,
    get() {
      calls++;
      return f.foundation;
    },
  });
  assert.throws(() => createProjectFoundationRunAdmission(create, d));
  const parsed = { ...scope };
  Object.defineProperty(parsed, "source", {
    enumerable: true,
    get() {
      calls++;
      return null;
    },
  });
  assert.throws(() => parseProjectFoundationRunAdmission(parsed, d));
  const request = {
    projectId: scope.projectId,
    toJSON() {
      calls++;
      return {};
    },
  };
  assert.throws(() =>
    assertProjectFoundationToolRequest(scope, "foundation_read", request),
  );
  assert.equal(calls, 0);
});
