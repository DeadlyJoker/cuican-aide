import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATIVE_PROJECT_UI_ACTIONS,
  parsePluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  type ProjectBriefListResponse,
  type CreativeProjectListResponse,
  type CreativeProjectBriefMutationResponse,
  type CreativeProjectConceptMutationResponse,
  type CreativeProjectMetadataMutationResponse,
} from "@crewon/contracts";
import { ApplicationError } from "./application-error.ts";
import {
  isPluginCreativeProjectActionOwner,
  PluginCreativeProjectActionOwner,
} from "./plugin-creative-project-action-owner.ts";
import type { PluginUiCommittedMetadataOutcome } from "./plugin-ui-ports.ts";
import { deferred } from "./creative-project.test-support.ts";
import {
  creativeActionDescriptor,
  creativeActionFixture,
  creativeCreateInput,
} from "./plugin-creative-project-action.test-support.ts";
import { uiTestActor } from "./plugin-ui.test-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import {
  taskActor,
  taskPin,
  taskCommand,
} from "./extension-plugin-task.test-support.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";

function code(expected: string) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.code === expected;
}

test("dispatches all 14 strict metadata actions through the actual Service using the registered actor", async () => {
  const f = creativeActionFixture();
  const created = (await f.invoke(
    "createProject",
    creativeCreateInput(),
  )) as unknown as CreativeProjectBriefMutationResponse;
  const projectId = created.project.projectId;
  assert.equal(created.disposition, "committed");
  assert.deepEqual(await f.invoke("getProject", { projectId }), {
    project: created.project,
  });
  assert.deepEqual(
    await f.invoke("getBrief", { projectId, briefRevision: 1 }),
    { brief: created.brief },
  );
  const renamed = (await f.invoke("renameProject", {
    projectId,
    idempotencyKey: "rename-1",
    request: {
      title: "晴日重逢",
      expectedProjectRevision: created.project.revision,
    },
  })) as unknown as CreativeProjectMetadataMutationResponse;
  const appended = (await f.invoke("appendBrief", {
    projectId,
    idempotencyKey: "brief-2",
    request: {
      text: "他们决定一起离开。",
      expectedProjectRevision: renamed.project.revision,
    },
  })) as unknown as CreativeProjectBriefMutationResponse;
  const concept = (await f.invoke("createConcept", {
    projectId,
    idempotencyKey: "concept-1",
    request: {
      name: "主角",
      prompt: "雨夜的年轻人",
      briefRevision: 1,
      expectedProjectRevision: appended.project.revision,
    },
  })) as unknown as CreativeProjectConceptMutationResponse;
  const assetId = concept.asset.assetId;
  assert.deepEqual(await f.invoke("getConceptAsset", { projectId, assetId }), {
    asset: concept.asset,
  });
  assert.deepEqual(
    await f.invoke("getConceptRevision", {
      projectId,
      assetId,
      assetRevision: 1,
    }),
    { assetRevision: concept.assetRevision },
  );
  const revision = (await f.invoke("appendConceptRevision", {
    projectId,
    assetId,
    idempotencyKey: "concept-2",
    request: {
      briefRevision: 2,
      prompt: "晴日的年轻人",
      expectedProjectRevision: concept.project.revision,
      expectedAssetMetadataRevision: concept.asset.revision,
    },
  })) as unknown as CreativeProjectConceptMutationResponse;
  assert.equal(
    revision.assetRevision.briefContentDigest,
    appended.brief.contentDigest,
  );
  assert.equal(
    concept.assetRevision.briefContentDigest,
    created.brief.contentDigest,
  );
  assert.deepEqual(await f.invoke("listBriefs", { projectId, query: {} }), {
    briefs: [created.brief, appended.brief],
    nextAfterBriefRevision: null,
  });
  assert.deepEqual(
    await f.invoke("listConceptAssets", { projectId, query: {} }),
    { assets: [revision.asset], nextAfterAssetId: null },
  );
  assert.deepEqual(
    await f.invoke("listConceptRevisions", { projectId, assetId, query: {} }),
    {
      revisions: [concept.assetRevision, revision.assetRevision],
      nextAfterAssetRevision: null,
    },
  );
  const archived = (await f.invoke("setProjectState", {
    projectId,
    idempotencyKey: "archive-1",
    request: {
      state: "archived",
      expectedProjectRevision: revision.project.revision,
    },
  })) as unknown as CreativeProjectMetadataMutationResponse;
  assert.deepEqual(
    await f.invoke("listProjects", { query: { state: "archived" } }),
    { projects: [archived.project], nextCursor: null },
  );
  assert.equal(f.projects.store.commits.length, 6);
  assert.ok(
    f.projects.authorizations.every(
      (entry) => JSON.stringify(entry.actor) === JSON.stringify(uiTestActor),
    ),
  );
  assert.equal(
    f.projects.store.projects.values().next().value?.ownerPrincipalId,
    uiTestActor.principalId,
  );
  for (const entry of [
    created,
    renamed,
    appended,
    concept,
    revision,
    archived,
  ]) {
    const json = JSON.stringify(entry);
    for (const forbidden of [
      "ownerPrincipalId",
      "tenantId",
      "spaceId",
      "createdByActorId",
      "updatedByActorId",
      "profileId",
      "packageDigest",
      "credit",
      "runId",
    ])
      assert.equal(json.includes(`"${forbidden}"`), false, forbidden);
  }
});

test("uses receipt-first replay and cannot substitute caller fields or method monkey patches for a commit", async () => {
  const f = creativeActionFixture();
  f.projects.service.createProject = async () => {
    throw new Error("fake_method_must_not_be_called");
  };
  const first = (await f.invoke(
    "createProject",
    creativeCreateInput(),
  )) as unknown as CreativeProjectBriefMutationResponse;
  const replay = (await f.invoke(
    "createProject",
    creativeCreateInput(),
  )) as unknown as CreativeProjectBriefMutationResponse;
  assert.deepEqual(replay, { ...first, disposition: "replayed" });
  assert.equal(f.projects.store.commits.length, 1);
  for (const invalid of [
    { ...creativeCreateInput("invalid-1"), actor: uiTestActor },
    { ...creativeCreateInput("invalid-2"), scope: f.ui.state.scope },
    { ...creativeCreateInput("invalid-3"), pluginId: "other.plugin" },
    { ...creativeCreateInput("invalid-4"), idempotencyKey: "x".repeat(129) },
    {
      request: { ...creativeCreateInput().request, kind: "run" },
      idempotencyKey: "invalid-5",
    },
  ])
    await assert.rejects(
      () => f.invoke("createProject", invalid),
      code("plugin_creative_project_action_invalid"),
    );
  assert.equal(f.projects.store.commits.length, 1);
});

test("only genuine owners and exact reserved action names are recognized", async () => {
  const f = creativeActionFixture();
  assert.equal(isPluginCreativeProjectActionOwner(f.owner), true);
  assert.equal(isPluginCreativeProjectActionOwner({ ...f.owner }), false);
  assert.equal(
    isPluginCreativeProjectActionOwner(
      Object.create(PluginCreativeProjectActionOwner.prototype),
    ),
    false,
  );
  for (const action of CREATIVE_PROJECT_UI_ACTIONS)
    assert.equal(f.owner.supportsAction(action), true);
  for (const action of [
    "createProject",
    "crewon.creative-projects.v2.createProject",
    "crewon.creative-projects.v1.generate",
    `${CREATIVE_PROJECT_UI_ACTIONS[0]}.extra`,
  ]) {
    assert.equal(f.owner.supportsAction(action), false);
    const lease = await f.open();
    await assert.rejects(
      () =>
        f.service.invoke(uiTestActor, {
          mountRef: lease.mountRef,
          action,
          input: {},
        }),
      code("plugin_creative_project_action_invalid"),
    );
  }
  assert.equal(f.projects.store.calls.length, 0);
});

test("publication/module and required service version must match the actual lease", async () => {
  for (const descriptor of [
    creativeActionDescriptor({ requires: [] }),
    creativeActionDescriptor({
      requires: [
        {
          service: "crewon.creative-projects",
          apiVersion: "2",
          optional: false,
        },
      ],
    }),
    creativeActionDescriptor({
      requires: [
        {
          service: "crewon.creative-projects",
          apiVersion: "1",
          optional: true,
        },
      ],
    }),
  ]) {
    const f = creativeActionFixture();
    f.ui.state.descriptor = descriptor;
    await assert.rejects(
      () => f.invoke("listProjects", { query: {} }),
      code("plugin_creative_project_publication_unavailable"),
    );
    assert.equal(f.projects.store.calls.length, 0);
  }
  const f = creativeActionFixture();
  const other = new PluginCreativeProjectActionOwner({
    projects: f.projects.service,
    publications: [{ ...f.publications[0]!, contributionId: "different" }],
    authorization: { async authorize() {} },
  });
  f.state.afterAction = async (context) => {
    await assert.rejects(
      () => other.actions.invoke(context),
      code("plugin_creative_project_publication_unavailable"),
    );
  };
  await f.invoke("listProjects", { query: {} });
});

test("pins pure publication/config fields and rejects getters without invoking them", async () => {
  const f = creativeActionFixture();
  const config = {
    projects: f.projects.service,
    publications: f.publications,
    authorization: { async authorize() {} },
  };
  let getters = 0;
  for (const bad of [
    { ...config, publications: [] },
    { ...config, publications: [f.publications[0], f.publications[0]] },
    { ...config, projects: {} },
    { ...config, authorization: null },
    {
      ...config,
      authorization: {
        get authorize() {
          getters++;
          return async () => {};
        },
      },
    },
    {
      ...config,
      get publications() {
        getters++;
        return [];
      },
    },
    {
      ...config,
      publications: [
        {
          ...f.publications[0],
          get pluginId() {
            getters++;
            return "other.plugin";
          },
        },
      ],
    },
  ])
    assert.throws(
      () => new PluginCreativeProjectActionOwner(bad as never),
      code("plugin_creative_project_config_invalid"),
    );
  assert.equal(getters, 0);
  f.publications[0]!.pluginId = "other.plugin";
  await f.invoke("listProjects", { query: {} });
  class ClassPolicy {
    async authorize() {}
  }
  const classOwner = new PluginCreativeProjectActionOwner({
    ...config,
    publications: [{ ...f.publications[0]!, pluginId: "example.story" }],
    authorization: new ClassPolicy(),
  });
  classOwner.assertAvailable();
  await classOwner.close();
});

test("structurally valid detached or completed contexts cannot acquire invocation commit authority", async () => {
  const f = creativeActionFixture();
  await f.invoke("listProjects", { query: {} });
  const completed = f.state.context!;
  for (const context of [
    completed,
    { ...completed },
    structuredClone(completed),
  ])
    await assert.rejects(
      () => f.owner.actions.invoke(context),
      code("plugin_ui_invocation_unavailable"),
    );
  assert.equal(f.projects.store.commits.length, 0);
});

test("Host readiness deny and project policy deny reject before writing", async () => {
  const f = creativeActionFixture();
  f.state.hostAllowed = false;
  await assert.rejects(
    () => f.invoke("createProject", creativeCreateInput()),
    code("plugin_creative_project_action_denied"),
  );
  assert.equal(f.projects.store.calls.length, 0);
  f.state.hostAllowed = true;
  f.projects.authorization = () => ({
    outcome: "deny",
    reasonCode: "not_authorized",
  });
  await assert.rejects(
    () => f.invoke("createProject", creativeCreateInput()),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.equal(f.projects.store.commits.length, 0);
  assert.ok(
    f.projects.authorizations.every(
      (entry) => entry.actor.principalId === uiTestActor.principalId,
    ),
  );
});

test("Host approval receives the exact registered context and cannot be replaced by a detached permission JSON", async () => {
  const f = creativeActionFixture();
  f.state.beforeHost = async () => {
    assert.equal(f.state.hostContexts.at(-1), f.state.context);
    capturePluginUiInvocationCommitAuthority(
      f.state.hostContexts.at(-1)!,
    ).assertActive();
  };
  await f.invoke("createProject", creativeCreateInput());
  assert.ok(f.state.hostContexts.length >= 2);
  assert.equal(f.projects.store.commits.length, 1);
});

test("Host readiness withdrawn during the Service receipt read is rechecked before any mutation", async () => {
  const f = creativeActionFixture();
  f.projects.store.before = async (method) => {
    if (method === "loadMutationReceipt") f.state.hostAllowed = false;
  };
  await assert.rejects(
    () => f.invoke("createProject", creativeCreateInput()),
    code("plugin_creative_project_action_denied"),
  );
  assert.equal(f.projects.store.commits.length, 0);
  assert.equal(f.projects.idCalls.length, 0);
});

test("principal ownership and project pagination remain enforced by the borrowed actual Service", async () => {
  const f = creativeActionFixture();
  const foreign = await f.projects.service.createProject(
    { ...uiTestActor, principalId: "foreign-principal" },
    { ...creativeCreateInput().request, idempotencyKey: "foreign-1" },
  );
  await assert.rejects(
    () => f.invoke("getProject", { projectId: foreign.project.projectId }),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "notFound",
  );
  const first = (await f.invoke(
    "createProject",
    creativeCreateInput("own-1"),
  )) as unknown as CreativeProjectBriefMutationResponse;
  const second = (await f.invoke(
    "createProject",
    creativeCreateInput("own-2"),
  )) as unknown as CreativeProjectBriefMutationResponse;
  const page = (await f.invoke("listProjects", {
    query: { limit: 1 },
  })) as unknown as CreativeProjectListResponse;
  assert.deepEqual(page.projects, [second.project]);
  assert.equal(typeof page.nextCursor, "string");
  const next = (await f.invoke("listProjects", {
    query: { limit: 1, cursor: page.nextCursor },
  })) as unknown as CreativeProjectListResponse;
  assert.deepEqual(next.projects, [first.project]);
  assert.equal(next.nextCursor, null);
  await assert.rejects(
    () =>
      f.invoke("listProjects", {
        query: { state: "archived", cursor: page.nextCursor },
      }),
    code("plugin_creative_project_action_invalid"),
  );
});

test("brief pages honor the UTF-8 budget by suffix trimming and preserve complete immutable history", async () => {
  const f = creativeActionFixture();
  const text = "雨".repeat(2730);
  let result: Pick<CreativeProjectBriefMutationResponse, "project" | "brief"> =
    await f.projects.service.createProject(uiTestActor, {
      title: "雨夜",
      briefText: text,
      idempotencyKey: "large-1",
    });
  const expected = [result.brief];
  for (let revision = 2; revision <= 10; revision++) {
    result = await f.projects.service.appendBrief(uiTestActor, {
      projectId: result.project.projectId,
      text,
      expectedProjectRevision: result.project.revision,
      idempotencyKey: `large-${revision}`,
    });
    expected.push(result.brief);
  }
  const page = (await f.invoke("listBriefs", {
    projectId: result.project.projectId,
    query: { limit: 50 },
  })) as unknown as ProjectBriefListResponse;
  assert.ok(page.briefs.length > 0 && page.briefs.length < expected.length);
  assert.ok(
    Buffer.byteLength(JSON.stringify(page), "utf8") <=
      MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  );
  assert.equal(page.nextAfterBriefRevision, page.briefs.at(-1)!.briefRevision);
  assert.ok(page.briefs.every((brief) => brief.text === text));
  const next = (await f.invoke("listBriefs", {
    projectId: result.project.projectId,
    query: { afterBriefRevision: page.nextAfterBriefRevision!, limit: 50 },
  })) as unknown as ProjectBriefListResponse;
  assert.equal(next.nextAfterBriefRevision, null);
  assert.deepEqual(
    [...page.briefs, ...next.briefs].map((item) => item.contentDigest),
    expected.map((item) => item.contentDigest),
  );
});

test("closing during Host await withdraws the invocation and close joins its physical completion", async () => {
  const f = creativeActionFixture();
  const entered = deferred(),
    release = deferred();
  f.state.beforeHost = async () => {
    entered.resolve();
    await release.promise;
  };
  const running = f.invoke("createProject", creativeCreateInput());
  const rejected = assert.rejects(
    running,
    code("plugin_creative_project_actions_unavailable"),
  );
  await entered.promise;
  let joined = false;
  const closing = f.owner.close().then(() => {
    joined = true;
  });
  assert.throws(
    () => f.owner.assertAvailable(),
    code("plugin_creative_project_actions_unavailable"),
  );
  await Promise.resolve();
  assert.equal(joined, false);
  release.resolve();
  await rejected;
  await closing;
  assert.equal(joined, true);
  assert.equal(f.projects.store.commits.length, 0);
  assert.equal(f.owner.close(), f.owner.close());
});

test("actual closeMount and invoke policy withdrawal during Host await prevent dispatch", async () => {
  for (const mode of ["close", "deny"] as const) {
    const f = creativeActionFixture();
    const lease = await f.open();
    const entered = deferred(),
      release = deferred();
    f.state.beforeHost = async () => {
      entered.resolve();
      await release.promise;
    };
    const running = f.service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: "crewon.creative-projects.v1.createProject",
      input: creativeCreateInput(),
    });
    const rejected = assert.rejects(
      running,
      code(
        mode === "close"
          ? "plugin_ui_mount_unavailable"
          : "plugin_ui_authorization_denied",
      ),
    );
    await entered.promise;
    if (mode === "close")
      await f.service.closeMount(uiTestActor, { mountRef: lease.mountRef });
    else f.ui.state.allowed.delete("invoke");
    release.resolve();
    await rejected;
    assert.equal(f.projects.store.commits.length, 0);
  }
});

test("confirmed metadata receipts remain deliverable after close/deny/selection change without another write", async () => {
  for (const mode of ["closeMount", "deny", "selection", "owner"] as const) {
    const f = creativeActionFixture();
    f.state.afterAction = async (context, output) => {
      assert.equal(f.owner.committedMetadata.isOutcome(output), true);
      assert.throws(() => parsePluginUiJsonValue(output));
      if (mode === "closeMount")
        await f.service.closeMount(uiTestActor, {
          mountRef: context.lease.mountRef,
        });
      if (mode === "deny") f.ui.state.allowed.delete("invoke");
      if (mode === "selection") f.ui.state.selection = null;
      if (mode === "owner") await f.owner.close();
    };
    const response = (await f.invoke(
      "createProject",
      creativeCreateInput(),
    )) as unknown as CreativeProjectBriefMutationResponse;
    assert.equal(response.disposition, "committed");
    assert.equal(f.projects.store.commits.length, 1);
    assert.equal(f.owner.committedMetadata.isOutcome(f.state.raw), false);
    assert.throws(
      () =>
        f.owner.committedMetadata.verify(
          f.state.context!,
          f.state.raw as PluginUiCommittedMetadataOutcome,
        ),
      code("plugin_ui_committed_metadata_invalid"),
    );
  }
});

test("a close after Store confirmed a commit but before Service return cannot turn it into a retry", async () => {
  const f = creativeActionFixture();
  const entered = deferred(),
    release = deferred();
  const original = f.projects.store.commitProjectCreation.bind(
    f.projects.store,
  );
  f.projects.store.commitProjectCreation = async (input) => {
    const committed = await original(input);
    entered.resolve();
    await release.promise;
    return committed;
  };
  const running = f.invoke("createProject", creativeCreateInput());
  await entered.promise;
  const closing = f.owner.close();
  assert.equal(f.projects.store.commits.length, 1);
  release.resolve();
  const response =
    (await running) as unknown as CreativeProjectBriefMutationResponse;
  await closing;
  assert.equal(response.disposition, "committed");
  assert.equal(f.projects.store.receipts.size, 1);
});

test("ordinary JSON and metadata reads retain post-fence rejection after withdrawal", async () => {
  const f = creativeActionFixture();
  const created = (await f.invoke(
    "createProject",
    creativeCreateInput(),
  )) as unknown as CreativeProjectBriefMutationResponse;
  for (const mode of ["read", "claimedCommit"] as const) {
    const current = creativeActionFixture();
    if (mode === "read")
      await current.projects.service.createProject(uiTestActor, {
        ...creativeCreateInput().request,
        idempotencyKey: "seed-1",
      });
    else
      current.state.rawOverride = { committed: true, output: created } as never;
    current.state.afterAction = () => {
      current.ui.state.allowed.delete("invoke");
    };
    await assert.rejects(
      () =>
        current.invoke(
          mode === "read" ? "listProjects" : "createProject",
          mode === "read" ? { query: {} } : creativeCreateInput(),
        ),
      code("plugin_ui_authorization_denied"),
    );
    assert.equal(
      current.projects.store.commits.length,
      mode === "read" ? 1 : 0,
    );
  }
});

test("metadata outcomes resist forged JSON, prototype copying, other owner, and identical-field context reuse", async () => {
  const f = creativeActionFixture(),
    other = creativeActionFixture();
  f.state.afterAction = (context, raw) => {
    assert.equal(f.owner.committedMetadata.isOutcome(raw), true);
    assert.equal(other.owner.committedMetadata.isOutcome(raw), false);
    for (const fake of [
      { committed: true },
      {},
      Object.create(Object.getPrototypeOf(raw)),
      Object.create(raw as object),
    ]) {
      assert.equal(f.owner.committedMetadata.isOutcome(fake), false);
      assert.throws(
        () =>
          f.owner.committedMetadata.verify(
            context,
            fake as PluginUiCommittedMetadataOutcome,
          ),
        code("plugin_ui_committed_metadata_invalid"),
      );
    }
    assert.throws(
      () =>
        other.owner.committedMetadata.verify(
          context,
          raw as PluginUiCommittedMetadataOutcome,
        ),
      code("plugin_ui_committed_metadata_invalid"),
    );
    assert.equal(f.owner.committedMetadata.isOutcome(raw), true);
    assert.throws(
      () =>
        f.owner.committedMetadata.verify(
          { ...context },
          raw as PluginUiCommittedMetadataOutcome,
        ),
      code("plugin_ui_committed_metadata_invalid"),
    );
    assert.equal(f.owner.committedMetadata.isOutcome(raw), false);
  };
  await assert.rejects(
    () => f.invoke("createProject", creativeCreateInput()),
    code("plugin_ui_output_invalid"),
  );
  assert.equal(f.projects.store.commits.length, 1);
});

test("independent task and metadata owners coexist; neither recognizes the other's receipt", async () => {
  const tasks = committedUiFixture();
  const metadata = creativeActionFixture();
  const descriptor = creativeActionDescriptor({
    ...tasks.detachedContext().lease.descriptor,
  });
  // Override only its requirements while preserving the task fixture's installed identities.
  const combinedDescriptor = creativeActionDescriptor({
    ...descriptor,
    requires: [
      { service: "crewon.creative-projects", apiVersion: "1", optional: false },
    ],
  });
  const owner = new PluginCreativeProjectActionOwner({
    projects: metadata.projects.service,
    publications: [
      {
        pluginId: taskPin.pluginId,
        packageDigest: taskPin.packageDigest,
        contributionId: taskPin.contributionId,
      },
    ],
    authorization: { async authorize() {} },
  });
  const accepted = await tasks.accept();
  const taskOutcome = await tasks.authority.issue(accepted);
  assert.equal(owner.committedMetadata.isOutcome(taskOutcome), false);
  const service = new PluginUiApplicationService({
    store: tasks.ledger,
    profiles: {
      async resolve() {
        return tasks.state.scope;
      },
    },
    authorization: {
      async authorize() {
        return { outcome: "allow", authorityEpoch: tasks.state.epoch };
      },
    },
    packages: {
      async verify() {
        return { descriptor: combinedDescriptor, publicAssets: ["ui.mjs"] };
      },
      async readAsset() {
        return { bytes: new Uint8Array(), contentType: "text/javascript" };
      },
    },
    clock: { now: () => tasks.state.now },
    ids: { nextId: () => "b".repeat(40) },
    committedTasks: tasks.authority,
    committedMetadata: owner.committedMetadata,
    actions: {
      async invoke(context) {
        if (owner.supportsAction(context.action)) {
          const outcome = await owner.actions.invoke(context);
          assert.equal(tasks.authority.isOutcome(outcome), false);
          return outcome;
        }
        const result = await tasks.accept(context);
        const outcome = await tasks.authority.issue(result);
        assert.equal(owner.committedMetadata.isOutcome(outcome), false);
        return outcome;
      },
    },
  });
  const lease = await service.openMount(taskActor, tasks.openCommand);
  const project = (await service.invoke(taskActor, {
    mountRef: lease.mountRef,
    action: "crewon.creative-projects.v1.createProject",
    input: creativeCreateInput(),
  })) as unknown as CreativeProjectBriefMutationResponse;
  assert.equal(project.disposition, "committed");
  const run = await service.invoke(taskActor, {
    mountRef: lease.mountRef,
    action: taskPin.action,
    input: { intent: taskCommand.intent },
  });
  assert.equal(typeof (run as { runId: unknown }).runId, "string");
  assert.equal(metadata.projects.store.commits.length, 1);
  assert.equal(tasks.tasks.state.commits.length, 1);
});
