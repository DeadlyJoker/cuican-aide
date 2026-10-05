import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectTextUiActionResponse,
  PROJECT_TEXT_UI_METHOD_ACTIONS as A,
  PROJECT_TEXT_UI_ACTIONS,
  type ProjectTextMutationResponse,
} from "@crewon/contracts/project-texts-ui";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PluginProjectTextActionOwner,
  isPluginProjectTextActionOwner,
} from "./plugin-project-text-action-owner.ts";
import { projectTextActionFixture } from "./plugin-project-text-action.test-support.ts";
import { outlineContent, scriptContent } from "./project-text.test-support.ts";
import {
  uiDeferred,
  uiTestActor,
  uiTestDescriptor,
} from "./plugin-ui.test-support.ts";
import {
  capturePluginProjectTextUiInvocationCommitAuthority,
  capturePluginUiInvocationCommitAuthority,
} from "./plugin-ui-invocation-authority.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
const candidate = (projectId: string, idempotencyKey = "outline-once") => ({
  projectId,
  request: {
    expectedArtifactRevision: 0,
    briefRevision: 1,
    content: outlineContent,
  },
  idempotencyKey,
});
const mutation = (
  raw: unknown,
  action: typeof A.saveOutlineCandidate,
  input: ReturnType<typeof candidate>,
) =>
  parseProjectTextUiActionResponse(
    { action, input },
    raw,
  ) as ProjectTextMutationResponse;

test("all10 manual text actions use the actual Service and registered actor, preserving shared candidates/history/selection/lock", async (t) => {
  const f = await projectTextActionFixture();
  t.after(() => f.owner.close());
  const projectId = f.project.projectId;
  assert.equal(isPluginProjectTextActionOwner(f.owner), true);
  for (const action of PROJECT_TEXT_UI_ACTIONS)
    assert.equal(f.owner.supportsAction(action), true);
  const originalProjectRevision = f.project.revision;
  assert.deepEqual(await f.invoke("getOutline", { projectId }), { view: null });
  const input = candidate(projectId);
  const saved = mutation(
    await f.invoke("saveOutlineCandidate", input),
    A.saveOutlineCandidate,
    input,
  );
  const artifactId = saved.artifact.artifactId;
  assert.equal(saved.artifact.selectedContentRevision, null);
  const selected = (await f.invoke("selectRevision", {
    projectId,
    artifactId,
    request: { expectedArtifactRevision: 1, contentRevision: 1 },
    idempotencyKey: "select-outline",
  })) as unknown as ProjectTextMutationResponse;
  assert.equal(selected.artifact.selectedContentRevision, 1);
  const script = (await f.invoke("saveScriptCandidate", {
    projectId,
    episodeId: "ep-1",
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      outline: { artifactId, contentRevision: 1 },
      content: scriptContent,
    },
    idempotencyKey: "script-once",
  })) as unknown as ProjectTextMutationResponse;
  await f.invoke("selectRevision", {
    projectId,
    artifactId: script.artifact.artifactId,
    request: { expectedArtifactRevision: 1, contentRevision: 1 },
    idempotencyKey: "select-script",
  });
  const locked = (await f.invoke("setLocked", {
    projectId,
    artifactId,
    request: { expectedArtifactRevision: 2, locked: true },
    idempotencyKey: "lock-outline",
  })) as unknown as ProjectTextMutationResponse;
  assert.equal(locked.artifact.locked, true);
  for (const [method, query] of [
    ["getOutline", { projectId }],
    ["getScript", { projectId, episodeId: "ep-1" }],
    ["getArtifact", { projectId, artifactId }],
    ["getRevision", { projectId, artifactId, contentRevision: 1 }],
    ["listArtifacts", { projectId, afterArtifactId: null, limit: 16 }],
    [
      "listRevisions",
      { projectId, artifactId, afterContentRevision: 0, limit: 16 },
    ],
  ] as const)
    assert.ok(await f.invoke(method, query));
  assert.equal(
    (await f.projects.service.getProject(uiTestActor, { projectId })).revision,
    originalProjectRevision,
  );
  assert.equal(f.store.commits.length, 5);
  assert.ok(
    f.store.commits.every(
      (value) => value.artifact.ownerPrincipalId === uiTestActor.principalId,
    ),
  );
  const serialized = JSON.stringify(
    await f.invoke("listRevisions", {
      projectId,
      artifactId,
      afterContentRevision: 0,
      limit: 16,
    }),
  );
  for (const key of [
    "actorId",
    "principalId",
    "tenantId",
    "spaceId",
    "authorityEpoch",
    "runId",
  ])
    assert.equal(serialized.includes(`"${key}"`), false);
});
test("actual text mutations capture a distinct same-input installation qualification; reads and legacy actions receive none", async (t) => {
  const f = await projectTextActionFixture();
  t.after(() => f.owner.close());
  const input = candidate(f.project.projectId);
  f.state.onContext = (context) => {
    const grant = capturePluginProjectTextUiInvocationCommitAuthority(context);
    if (context.action === A.saveOutlineCandidate) {
      assert.ok(grant.textUiTransaction);
      assert.deepEqual(grant.textUiTransaction.actor, uiTestActor);
      assert.deepEqual(grant.textUiTransaction.input, input);
      assert.equal(grant.textUiTransaction.actionId, A.saveOutlineCandidate);
      assert.equal(
        grant.textUiTransaction.installation.selectionRevision,
        f.lease.selectionRevision,
      );
      assert.equal(
        capturePluginUiInvocationCommitAuthority(context).transaction,
        undefined,
      );
      assert.equal("run" in grant.textUiTransaction, false);
    } else assert.equal(grant.textUiTransaction, undefined);
    assert.throws(
      () => capturePluginProjectTextUiInvocationCommitAuthority({ ...context }),
      { code: "plugin_ui_invocation_unavailable" },
    );
  };
  await f.invoke("getOutline", { projectId: f.project.projectId });
  await f.invoke("saveOutlineCandidate", input);
  await assert.rejects(f.owner.actions.invoke(f.state.context!), {
    code: "plugin_ui_invocation_unavailable",
  });
  assert.equal(
    f.owner.supportsAction("crewon.creative-projects.v1.appendBrief"),
    false,
  );
  assert.equal(
    f.owner.supportsAction("crewon.project-texts.v2.saveOutlineCandidate"),
    false,
  );
});
test("same original mutation key returns checked durable replay without an additional candidate", async (t) => {
  const f = await projectTextActionFixture();
  t.after(() => f.owner.close());
  const input = candidate(f.project.projectId);
  const first = (await f.invoke(
    "saveOutlineCandidate",
    input,
  )) as unknown as ProjectTextMutationResponse;
  const again = (await f.invoke(
    "saveOutlineCandidate",
    input,
  )) as unknown as ProjectTextMutationResponse;
  assert.equal(again.disposition, "replayed");
  assert.deepEqual(first.artifact, again.artifact);
  assert.equal(f.store.commits.length, 1);
  await assert.rejects(
    f.invoke("saveOutlineCandidate", {
      ...input,
      request: {
        ...input.request,
        content: { ...outlineContent, synopsis: "不同的内容" },
      },
    }),
  );
  assert.equal(f.store.commits.length, 1);
});
test("plain claims and copied contexts never establish invocation authority, even before field getters", async (t) => {
  const f = await projectTextActionFixture();
  t.after(() => f.owner.close());
  let getters = 0;
  const forged = {};
  Object.defineProperty(forged, "actor", {
    get: () => {
      getters++;
      return uiTestActor;
    },
  });
  await assert.rejects(
    f.owner.actions.invoke(forged as PluginUiActionContext),
    { code: "plugin_ui_invocation_unavailable" },
  );
  assert.equal(getters, 0);
  assert.equal(f.store.commits.length, 0);
  assert.throws(
    () =>
      new PluginProjectTextActionOwner({
        texts: {} as never,
        publications: f.publications,
        authorization: { authorize: async () => undefined },
      }),
    { code: "plugin_project_text_config_invalid" },
  );
  assert.equal(isPluginProjectTextActionOwner({ ...f.owner }), false);
});
test("owner close withdraws an in-flight precommit call immediately and physically joins its result", async () => {
  const f = await projectTextActionFixture();
  const entered = uiDeferred(),
    release = uiDeferred();
  f.store.beforeCommit = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.invoke(
    "saveOutlineCandidate",
    candidate(f.project.projectId),
  );
  await entered.promise;
  let joined = false;
  const closing = f.owner.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  await assert.rejects(
    f.invoke("getOutline", { projectId: f.project.projectId }),
    { code: "plugin_project_text_actions_unavailable" },
  );
  release.resolve();
  await assert.rejects(pending);
  await closing;
  assert.equal(joined, true);
  assert.equal(f.store.commits.length, 0);
});
test("confirmed text receipts remain deliverable after close/policy/selection withdrawal and cannot be forged or reused", async () => {
  const f = await projectTextActionFixture();
  f.store.afterCommit = () => {
    f.ui.state.allowed.delete("invoke");
    f.state.hostAllowed = false;
    void f.owner.close();
  };
  const saved = (await f.invoke(
    "saveOutlineCandidate",
    candidate(f.project.projectId),
  )) as unknown as ProjectTextMutationResponse;
  assert.equal(saved.disposition, "committed");
  assert.equal(f.store.commits.length, 1);
  await f.owner.close();
  assert.equal(f.owner.committedMetadata.isOutcome({ ...saved }), false);
  assert.throws(
    () =>
      f.owner.committedMetadata.verify(f.state.context!, f.state.raw as never),
    { code: "plugin_ui_committed_metadata_invalid" },
  );
});
test("reads retain a post-fence and project/host revocation does not publish content", async (t) => {
  const f = await projectTextActionFixture();
  t.after(() => f.owner.close());
  const entered = uiDeferred(),
    release = uiDeferred();
  f.store.before = async (method) => {
    if (method === "loadOutline") {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.invoke("getOutline", { projectId: f.project.projectId });
  await entered.promise;
  f.ui.state.allowed.delete("invoke");
  release.resolve();
  await assert.rejects(pending, { code: "plugin_ui_authorization_denied" });
  assert.equal(f.store.commits.length, 0);
});
test("optional text UI requirement is accepted only for a genuine declared dual entry and approved module", async (t) => {
  const f = await projectTextActionFixture();
  t.after(() => f.owner.close());
  f.ui.state.descriptor = parsePluginPackageDescriptor({
    ...f.ui.state.descriptor,
    requires: [
      { service: "crewon.project-texts", apiVersion: "1", optional: true },
    ],
  });
  // A new mount sees the exact modified descriptor; no mere optional declaration grants a UI-only package the service.
  await f.service.closeMount(uiTestActor, { mountRef: f.lease.mountRef });
  const lease = await f.service.openMount(uiTestActor, {
    pluginId: uiTestDescriptor.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: f.lease.selectionRevision,
    expectedPackageDigest: f.lease.packageDigest,
  });
  await assert.rejects(
    f.service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: A.getOutline,
      input: { projectId: f.project.projectId },
    }),
    { code: "plugin_project_text_publication_unavailable" },
  );
  await f.service.closeMount(uiTestActor, { mountRef: lease.mountRef });
  f.ui.state.descriptor = parsePluginPackageDescriptor({
    ...f.ui.state.descriptor,
    entrypoints: { ...f.ui.state.descriptor.entrypoints, node: "node.mjs" },
    businessManifestPath: "business.json",
    files: [
      ...f.ui.state.descriptor.files,
      { path: "business.json", byteLength: 2, sha256: "a".repeat(64) },
    ],
  });
  const dual = await f.service.openMount(uiTestActor, {
    pluginId: uiTestDescriptor.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: f.lease.selectionRevision,
    expectedPackageDigest: f.lease.packageDigest,
  });
  assert.deepEqual(
    await f.service.invoke(uiTestActor, {
      mountRef: dual.mountRef,
      action: A.getOutline,
      input: { projectId: f.project.projectId },
    }),
    { view: null },
  );
});

test("supported32K script content crosses genuine generic invoke and history trims whole revisions with an exact continuation", async (t) => {
  const f = await projectTextActionFixture();
  t.after(() => f.owner.close());
  const projectId = f.project.projectId;
  const content = {
    title: "手动完整剧本",
    scenes: Array.from({ length: 4 }, (_, index) => ({
      sceneId: `scene-${index}`,
      location: "室内",
      timeOfDay: "夜",
      action: "x".repeat(7900),
      dialogue: [],
    })),
  };
  const first = (await f.invoke("saveScriptCandidate", {
    projectId,
    episodeId: "manual-episode",
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      outline: null,
      content,
    },
    idempotencyKey: "manual-script-v1",
  })) as unknown as ProjectTextMutationResponse;
  const artifactId = first.artifact.artifactId;
  await f.invoke("saveScriptCandidate", {
    projectId,
    episodeId: "manual-episode",
    request: {
      expectedArtifactRevision: 1,
      briefRevision: 1,
      outline: null,
      content: { ...content, title: "手动完整剧本第二版" },
    },
    idempotencyKey: "manual-script-v2",
  });
  const page = (await f.invoke("listRevisions", {
    projectId,
    artifactId,
    afterContentRevision: 0,
    limit: 16,
  })) as unknown as {
    revisions: {
      contentRevision: number;
      contentDigest: string;
      content: unknown;
    }[];
    nextContentRevision: number | null;
  };
  assert.equal(page.revisions.length, 1);
  assert.equal(page.nextContentRevision, 1);
  assert.deepEqual(page.revisions[0]!.content, content);
  assert.equal(
    page.revisions[0]!.contentDigest,
    first.contentRevision!.contentDigest,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 60 * 1024);
  const next = (await f.invoke("listRevisions", {
    projectId,
    artifactId,
    afterContentRevision: 1,
    limit: 16,
  })) as unknown as typeof page;
  assert.equal(next.revisions[0]!.contentRevision, 2);
  assert.equal(next.nextContentRevision, null);
});
