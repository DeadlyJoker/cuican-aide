import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createProjectConversationBinding } from "./project-conversation-binding.ts";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  createProjectMediaInputStageRunAdmission,
  parseProjectMediaInputStageRunAdmission,
  parseProjectMediaInputStage,
  assertProjectMediaInputStageToolRequest,
} from "./project-media-input-stage-run-admission.ts";
const d = {
    sha256: (text: string) =>
      `sha256:${createHash("sha256").update(text).digest("hex")}`,
  },
  at = "2026-10-06T00:00:00.000Z";
function fixture() {
  const actor = {
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
      version: "19.0.0",
      packageDigest: d.sha256("installed-package"),
      selectionRevision: 2,
    };
  const binding = createProjectConversationBinding(
    {
      bindingId: "binding",
      owner: actor,
      profileId: "profile",
      projectId: "project",
      threadId: "thread",
      workspaceId: "actual-workspace",
      revision: 1,
      state: "active",
      currentInstallation: installation,
      createdAt: at,
      updatedAt: at,
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
      configurationDigest: d.sha256("configuration"),
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
      inputDigest: d.sha256("plain original prompt"),
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
    idempotencyKey: "original-key",
    contributionId: "workbench",
    action: "project.execute",
    authorityEpoch: "real-host-epoch",
  };
  const stage = {
      kind: "media-input" as const,
      workflowId: "flux2-three-reference-storyboard" as const,
      configurationRevision: 1,
      briefRevision: 1,
      script: {
        artifactId: "script",
        episodeId: "episode",
        contentRevision: 2,
      },
    },
    sources = {
      brief: { briefRevision: 1, contentDigest: d.sha256("brief") },
      script: { ...stage.script, contentDigest: d.sha256("script") },
    };
  return {
    actor,
    binding,
    admission,
    extensionBinding: extension,
    stage,
    sources,
    at,
  };
}
test("media-input preparation has an independent exact Run, installation, workspace, workflow and frozen script scope", () => {
  const f = fixture(),
    scope = createProjectMediaInputStageRunAdmission(f, d);
  assert.deepEqual(parseProjectMediaInputStageRunAdmission(scope, d), scope);
  assert.equal(scope.workspaceId, "actual-workspace");
  assert.equal(scope.stage.workflowId, "flux2-three-reference-storyboard");
  for (const patch of [
    { actor: { ...f.actor, principalId: "foreign" } },
    { admission: { ...f.admission, action: "image.generate" } },
    { admission: { ...f.admission, selectionRevision: 4 } },
    { stage: { ...f.stage, configurationRevision: 2 } },
    { stage: { ...f.stage, script: null } },
    {
      sources: {
        ...f.sources,
        script: { ...f.sources.script, contentRevision: 3 },
      },
    },
  ])
    assert.throws(() =>
      createProjectMediaInputStageRunAdmission(
        { ...f, ...patch } as typeof f,
        d,
      ),
    );
  for (const patch of [
    { schemaVersion: "crewon.project-asset-stage-run-admission.v1" },
    { allowedOperations: [...scope.allowedOperations, "media_submit"] },
    { userContentDigest: d.sha256("replacement") },
    { extra: true },
  ])
    assert.throws(() =>
      parseProjectMediaInputStageRunAdmission({ ...scope, ...patch }, d),
    );
  assert.throws(() =>
    parseProjectMediaInputStage({
      kind: "assets",
      assetKind: "character",
      briefRevision: 1,
      script: null,
    }),
  );
});
test("media-input stage permits matching metadata preparation and project reads, not generation or other stage writes", () => {
  const scope = createProjectMediaInputStageRunAdmission(fixture(), d);
  const request = {
    method: "saveInput",
    projectId: "project",
    workflowId: "flux2-three-reference-storyboard",
    configurationRevision: 1,
    briefRevision: 1,
    script: { artifactId: "script", contentRevision: 2 },
    item: { kind: "storyboard-frame-exploration", episodeId: "episode" },
  };
  assert.doesNotThrow(() =>
    assertProjectMediaInputStageToolRequest(scope, "media_input", request),
  );
  assert.doesNotThrow(() =>
    assertProjectMediaInputStageToolRequest(scope, "media_input", {
      method: "getContext",
    }),
  );
  assert.throws(() =>
    assertProjectMediaInputStageToolRequest(scope, "media_input", {
      method: "getContext",
      projectId: "foreign",
    }),
  );
  for (const method of ["getOptions", "listInputs", "getInput", "readPrompt"])
    assert.doesNotThrow(() =>
      assertProjectMediaInputStageToolRequest(scope, "media_input", {
        method,
        projectId: "project",
      }),
    );
  for (const operation of ["asset_read", "script_read", "content_read"])
    assert.doesNotThrow(() =>
      assertProjectMediaInputStageToolRequest(scope, operation, {
        projectId: "project",
      }),
    );
  for (const operation of [
    "media_submit",
    "asset_save",
    "script_save",
    "text_select",
    "text_lock",
    "project_create",
    "submit",
  ])
    assert.throws(() =>
      assertProjectMediaInputStageToolRequest(scope, operation, request),
    );
  for (const patch of [
    { projectId: "foreign" },
    { method: "submit" },
    { workflowId: "krea2-reference-four-view" },
    { configurationRevision: 2 },
    { briefRevision: 2 },
    { script: null },
    { item: { kind: "storyboard-frame-exploration", episodeId: "other" } },
  ])
    assert.throws(() =>
      assertProjectMediaInputStageToolRequest(scope, "media_input", {
        ...request,
        ...patch,
      }),
    );
  assert.doesNotThrow(() =>
    assertProjectMediaInputStageToolRequest(
      scope,
      "media_input_context_read",
      {},
    ),
  );
  assert.throws(() =>
    assertProjectMediaInputStageToolRequest(scope, "media_input_context_read", {
      projectId: "project",
    }),
  );
});
test("T10 preparation can omit a script without widening the frozen workflow or stage fields", () => {
  const f = fixture();
  const scope = createProjectMediaInputStageRunAdmission(
    {
      ...f,
      stage: {
        ...f.stage,
        workflowId: "krea2-reference-four-view",
        script: null,
      },
      sources: { ...f.sources, script: null },
    },
    d,
  );
  const q = {
    method: "saveInput",
    projectId: "project",
    workflowId: "krea2-reference-four-view",
    configurationRevision: 1,
    briefRevision: 1,
    script: null,
    item: { kind: "character-reference", assetId: "character" },
  };
  assert.doesNotThrow(() =>
    assertProjectMediaInputStageToolRequest(scope, "media_input", q),
  );
  assert.throws(() =>
    assertProjectMediaInputStageToolRequest(scope, "media_input", {
      ...q,
      item: { kind: "storyboard-frame-exploration", episodeId: "episode" },
    }),
  );
  assert.throws(() =>
    parseProjectMediaInputStage({
      ...scope.stage,
      baseUrl: "https://example.test",
    }),
  );
});
