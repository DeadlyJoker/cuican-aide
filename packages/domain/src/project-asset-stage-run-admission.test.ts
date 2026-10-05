import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createProjectConversationBinding } from "./project-conversation-binding.ts";
import { createExtensionRunBinding } from "./extension-run-binding.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  createProjectAssetStageRunAdmission,
  parseProjectAssetStageRunAdmission,
  parseProjectAssetStage,
  assertProjectAssetStageToolRequest,
} from "./project-asset-stage-run-admission.ts";
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
      kind: "assets" as const,
      assetKind: "character" as const,
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
test("asset admission is a distinct immutable actual Run/installation/workspace and frozen source record", () => {
  const f = fixture(),
    before = extensionCanonicalJson(f.admission),
    scope = createProjectAssetStageRunAdmission(f, d);
  assert.deepEqual(parseProjectAssetStageRunAdmission(scope, d), scope);
  assert.equal(scope.workspaceId, "actual-workspace");
  assert.equal(scope.userContentDigest, f.extensionBinding.inputDigest);
  assert.equal(extensionCanonicalJson(f.admission), before);
  for (const patch of [
    { actor: { ...f.actor, principalId: "foreign" } },
    { admission: { ...f.admission, action: "image.generate" } },
    { admission: { ...f.admission, selectionRevision: 3 } },
    {
      sources: {
        ...f.sources,
        script: { ...f.sources.script, contentRevision: 3 },
      },
    },
  ])
    assert.throws(() =>
      createProjectAssetStageRunAdmission({ ...f, ...patch }, d),
    );
  for (const patch of [
    { schemaVersion: "crewon.project-stage-run-admission.v1" },
    { allowedOperations: ["asset_save", "submit"] },
    { userContentDigest: d.sha256("changed") },
    { extra: 1 },
  ])
    assert.throws(() =>
      parseProjectAssetStageRunAdmission({ ...scope, ...patch }, d),
    );
  assert.throws(() => parseProjectAssetStage({ kind: "discussion" }));
});
test("asset scope permits only same-project asset candidate/source and explicit read operations", () => {
  const scope = createProjectAssetStageRunAdmission(fixture(), d),
    request = {
      projectId: "project",
      kind: "character",
      briefRevision: 1,
      script: { artifactId: "script", contentRevision: 2 },
    };
  assert.doesNotThrow(() =>
    assertProjectAssetStageToolRequest(scope, "asset_save", request),
  );
  assert.doesNotThrow(() =>
    assertProjectAssetStageToolRequest(scope, "asset_context_read", {}),
  );
  assert.doesNotThrow(() =>
    assertProjectAssetStageToolRequest(scope, "script_read", {
      projectId: "project",
      episodeId: "episode",
    }),
  );
  for (const operation of [
    "submit",
    "brief_append",
    "outline_save",
    "script_save",
    "text_select",
    "text_lock",
    "project_create",
    "asset_select",
    "asset_reference_save",
  ])
    assert.throws(() =>
      assertProjectAssetStageToolRequest(scope, operation, request),
    );
  for (const patch of [
    { projectId: "other" },
    { kind: "prop" },
    { briefRevision: 2 },
    { script: null },
    { script: { artifactId: "other", contentRevision: 2 } },
  ])
    assert.throws(() =>
      assertProjectAssetStageToolRequest(scope, "asset_save", {
        ...request,
        ...patch,
      }),
    );
  assert.throws(() =>
    assertProjectAssetStageToolRequest(scope, "asset_context_read", {
      projectId: "project",
    }),
  );
});
