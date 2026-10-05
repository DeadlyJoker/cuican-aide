import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  createProjectConversationBinding,
  parseProjectConversationBinding,
  assertProjectConversationBindingChange,
} from "./project-conversation-binding.ts";
import {
  createProjectStageRunAdmission,
  parseProjectStageRunAdmission,
  projectStageOperations,
  assertProjectStageToolRequest,
} from "./project-stage-run-admission.ts";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
const d = {
    sha256: (text: string) =>
      "sha256:" + createHash("sha256").update(text).digest("hex"),
  },
  time = "2026-10-06T00:00:00.000Z",
  actor = {
    tenantId: "tenant",
    spaceId: "space",
    principalId: "principal",
    actorId: "actor",
  },
  installation = {
    tenantId: "tenant",
    spaceId: "space",
    profileId: "profile",
    pluginId: "crewon.short-drama",
    publisherId: "crewon",
    version: "16.0.0",
    packageDigest: d.sha256("package"),
    selectionRevision: 2,
  };
function fixture() {
  const binding = createProjectConversationBinding(
    {
      bindingId: "binding",
      owner: actor,
      profileId: "profile",
      projectId: "project",
      threadId: "thread",
      workspaceId: "workspace",
      revision: 1,
      state: "active",
      currentInstallation: installation,
      createdAt: time,
      updatedAt: time,
    },
    d,
  );
  const extension = createExtensionRunBinding(
    {
      schemaVersion: "crewon.extension-run-binding.v0",
      tenantId: "tenant",
      spaceId: "space",
      pluginId: installation.pluginId,
      actorId: "actor",
      threadId: "thread",
      runId: "run",
      configurationRevision: 1,
      configurationDigest: d.sha256("config"),
      target: {
        executionAuthority: "crewonKernel",
        agentVersionContentDigest: d.sha256("agent"),
        materializationDigest: d.sha256("materialization"),
        agentVersionId: "agent",
        authorityId: "authority",
        runtimeGeneration: "generation",
        policySnapshotId: "policy",
        workspaceBindingId: null,
      },
      inputDigest: d.sha256("plain user content"),
      source: null,
    },
    d,
  );
  const admission = {
    schemaVersion: "crewon.plugin-task-admission.v1" as const,
    ...actor,
    ...installation,
    runId: "run",
    threadId: "thread",
    extensionBindingDigest: extension.bindingDigest,
    requestDigest: d.sha256("request"),
    idempotencyKey: "receipt",
    contributionId: "workbench",
    action: "project.execute",
    authorityEpoch: "epoch",
  };
  const sources = {
    brief: { briefRevision: 1, contentDigest: d.sha256("brief") },
    outline: null,
  };
  return { binding, extension, admission, sources };
}
test("binding preserves actual owner/workspace, digest and explicit source CAS", () => {
  const f = fixture();
  assert.deepEqual(parseProjectConversationBinding(f.binding, d), f.binding);
  const { schemaVersion: _s, contentDigest: _d, ...body } = f.binding;
  const next = createProjectConversationBinding(
    {
      ...body,
      revision: 2,
      currentInstallation: { ...installation, version: "17.0.0" },
    },
    d,
  );
  assert.doesNotThrow(() =>
    assertProjectConversationBindingChange(f.binding, next),
  );
  for (const patch of [
    { workspaceId: "other" },
    { projectId: "other" },
    { threadId: "other" },
    { owner: { ...actor, principalId: "other" } },
  ])
    assert.throws(() =>
      assertProjectConversationBindingChange(
        f.binding,
        createProjectConversationBinding({ ...body, ...patch, revision: 2 }, d),
      ),
    );
  assert.throws(() =>
    parseProjectConversationBinding({ ...f.binding, revision: 2 }, d),
  );
});
test("four immutable stage records bind actual original admission without changing v1", () => {
  const f = fixture(),
    original = extensionCanonicalJson(f.admission);
  for (const stage of [
    { kind: "discussion" },
    { kind: "brief", briefRevision: 1 },
    { kind: "outline", briefRevision: 1 },
    { kind: "script", briefRevision: 1, episodeId: "episode", outline: null },
  ] as const) {
    const scope = createProjectStageRunAdmission(
      {
        actor,
        binding: f.binding,
        admission: f.admission,
        extensionBinding: f.extension,
        stage,
        sources: f.sources,
        at: time,
      },
      d,
    );
    assert.deepEqual(parseProjectStageRunAdmission(scope, d), scope);
    assert.deepEqual(scope.allowedOperations, projectStageOperations(stage));
    assert.equal(scope.userContentDigest, f.extension.inputDigest);
    assert.throws(() =>
      parseProjectStageRunAdmission(
        { ...scope, allowedOperations: ["submit"] },
        d,
      ),
    );
  }
  assert.equal(extensionCanonicalJson(f.admission), original);
  assert.throws(() =>
    createProjectStageRunAdmission(
      {
        actor,
        binding: f.binding,
        admission: { ...f.admission, principalId: "other" },
        extensionBinding: f.extension,
        stage: { kind: "discussion" },
        sources: f.sources,
        at: time,
      },
      d,
    ),
  );
});
test("scope denies cross-project, media, adoption, locks and wrong script/source while intrinsic read is allowed", () => {
  const f = fixture(),
    scope = createProjectStageRunAdmission(
      {
        actor,
        binding: f.binding,
        admission: f.admission,
        extensionBinding: f.extension,
        stage: {
          kind: "script",
          briefRevision: 1,
          episodeId: "episode",
          outline: null,
        },
        sources: f.sources,
        at: time,
      },
      d,
    );
  assert.doesNotThrow(() =>
    assertProjectStageToolRequest(scope, "project_context_read", {}),
  );
  assert.doesNotThrow(() =>
    assertProjectStageToolRequest(scope, "script_save", {
      projectId: "project",
      episodeId: "episode",
      briefRevision: 1,
      outline: null,
    }),
  );
  for (const [operation, request] of [
    ["submit", { projectId: "project" }],
    ["text_select", { projectId: "project" }],
    ["text_lock", { projectId: "project" }],
    ["project_create", {}],
    [
      "script_save",
      {
        projectId: "other",
        episodeId: "episode",
        briefRevision: 1,
        outline: null,
      },
    ],
    [
      "script_save",
      {
        projectId: "project",
        episodeId: "other",
        briefRevision: 1,
        outline: null,
      },
    ],
    [
      "script_save",
      {
        projectId: "project",
        episodeId: "episode",
        briefRevision: 2,
        outline: null,
      },
    ],
  ] as const)
    assert.throws(() =>
      assertProjectStageToolRequest(scope, operation, request),
    );
});
