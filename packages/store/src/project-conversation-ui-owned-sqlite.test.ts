import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  PluginUiApplicationService,
  ProjectConversationApplicationService,
  capturePluginUiInvocationCommitAuthority,
  qualifyPluginProjectReadScope,
  type PluginUiActionContext,
  type PluginProjectReadScope,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
} from "@crewon/contracts/plugins";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import {
  uiTestDescriptor,
  uiTestBytes,
} from "../../application/src/plugin-ui.test-support.ts";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { committedTaskContext } from "../../application/src/plugin-ui-committed-task-support.ts";
import { ownedConversationSqlFixture } from "./project-conversation-owned.test-support.ts";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import { pluginProjectMetadataOwnerColumns as columns } from "./plugin-project-metadata-owner-records.ts";

async function fixture(
  t: TestContext,
  mismatch: "matching" | "pluginId" = "matching",
  reader: "available" | "missing" = "available",
) {
  const f = await ownedConversationSqlFixture(t, "sqlite", mismatch);
  if (mismatch === "matching") {
    await f.parent.migratePluginProjectWorkspaceNamespaces();
    await (await f.mounted()).write();
  }
  const state = {
    policyAllowed: true,
    uiAllowed: true,
    hostActive: true,
    pinDrift: false,
    idCount: 0,
    threadPreparations: 0,
    preparedThreadId: null as string | null,
    afterThreadPrepared: null as (() => void | Promise<void>) | null,
    taskCount: 0,
    context: null as PluginUiActionContext | null,
    beforeDispatch: null as (() => Promise<void> | void) | null,
    beforeBindingCommit: null as (() => Promise<void> | void) | null,
    afterHostTransactionCurrent: null as (() => Promise<void> | void) | null,
  };
  const scopes: PluginProjectReadScope[] = [];
  const projects = f.parent.creativeProjectStore();
  assert.ok(projects instanceof SqliteCreativeProjectStore);
  const app = new ProjectConversationApplicationService({
    conversations: {
      version: f.store.version,
      migrate: f.store.migrate.bind(f.store),
      hasThreadBinding: f.store.hasThreadBinding.bind(f.store),
      loadBinding: f.store.loadBinding.bind(f.store),
      listBindings: f.store.listBindings.bind(f.store),
      loadMutationReceipt: f.store.loadMutationReceipt.bind(f.store),
      readRequiredStageDigest: f.store.readRequiredStageDigest.bind(f.store),
      loadStageAdmission: f.store.loadStageAdmission.bind(f.store),
      async commitBinding(...args: Parameters<typeof f.store.commitBinding>) {
        await state.beforeBindingCommit?.();
        return f.store.commitBinding(args[0], args[1]);
      },
    },
    threads: {
      async prepareCreateThread(actor, command) {
        state.threadPreparations++;
        const prepared = await f.threads.prepareCreateThread(actor, command);
        const event = prepared.events[0];
        assert.equal(event?.type, "thread.created");
        state.preparedThreadId = event!.identity.threadId;
        await state.afterThreadPrepared?.();
        return prepared;
      },
    },
    threadStore: f.parent,
    projects: {
      loadProject: projects.loadProject.bind(projects),
      loadBrief: projects.loadBrief.bind(projects),
      ...(reader === "missing"
        ? {}
        : {
            bindProjectReads(scope: PluginProjectReadScope) {
              scopes.push(scope);
              return projects.bindProjectReads(scope);
            },
          }),
    },
    texts: f.parent.projectTextStore(),
    tasks: {
      async createProjectConversationTurnFromHost() {
        state.taskCount++;
        throw new Error("named_no_run_in_metadata_test");
      },
    },
    authorization: {
      async authorize() {
        return state.policyAllowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_project_policy_denied" };
      },
    },
    ids: {
      nextId() {
        state.idCount++;
        return randomUUID();
      },
    },
    clock: { now: () => f.namespaceRecipe().createdAt },
    digester: f.digester,
  });
  const scope = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: f.installation.profileId,
  };
  const selection = (await f.installs.loadSelection({
    scope,
    pluginId: f.installation.pluginId,
  }))!;
  const pkg = (await f.installs.loadPackage({
    scope,
    packageDigest: selection.selectedPackageDigest!,
  }))!;
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    version: pkg.version,
    requires: [
      {
        service: "crewon.project-conversations",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  const ui = new PluginUiApplicationService({
    store: f.installs,
    profiles: {
      async resolve() {
        return scope;
      },
    },
    authorization: {
      async authorize() {
        return state.uiAllowed
          ? { outcome: "allow", authorityEpoch: "owned-conversation-ui-epoch" }
          : { outcome: "deny", reasonCode: "named_ui_denied" };
      },
    },
    packages: {
      async verify() {
        return { descriptor, publicAssets: ["ui.mjs"] };
      },
      async readAsset() {
        return {
          bytes: uiTestBytes,
          contentType: "text/javascript; charset=utf-8",
        };
      },
    },
    ids: { nextId: () => randomUUID().replaceAll("-", "").repeat(2) },
    clock: { now: () => f.namespaceRecipe().createdAt },
    actions: {
      async invoke(context) {
        state.context = context;
        const live = capturePluginUiInvocationCommitAuthority(context);
        const snapshot = committedTaskContext(context);
        // Named Host fixture retains the independent original project.execute pin; the UI pin is not rewritten or published.
        const authority: ProjectConversationCommitAuthority = Object.freeze({
          ...f.authority,
          pin: parsePluginTaskAdmissionPin({
            ...snapshot.pin,
            action: "project.execute",
            authorityEpoch: state.pinDrift
              ? "foreign-host-epoch"
              : snapshot.pin.authorityEpoch,
          }),
          selection: snapshot.context.selection,
          package: snapshot.context.package,
          assertActive() {
            live.assertActive();
            f.authority.assertActive();
            if (!state.hostActive) throw new Error("named_host_closed");
          },
          async assertCurrent() {
            authority.assertActive();
            await f.authority.assertCurrent();
            await live.assertCurrent();
          },
          async assertTransactionCurrent() {
            authority.assertActive();
            await f.authority.assertTransactionCurrent();
            await state.afterHostTransactionCurrent?.();
          },
        });
        await state.beforeDispatch?.();
        return parsePluginUiJsonValue(
          await app.metadataFromPluginUi(context, authority),
        );
      },
    },
  });
  const lease = await ui.openMount(f.actor, {
    pluginId: pkg.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: selection.revision,
    expectedPackageDigest: pkg.packageDigest,
  });
  const createInput = {
    projectId: f.reference.projectId,
    workspaceId: "workspace-isolated",
    title: "项目讨论",
    idempotencyKey: "owned-conversation-create",
  };
  const invoke = (action: string, input: unknown) =>
    ui.invoke(f.actor, {
      mountRef: lease.mountRef,
      action,
      input: input as never,
    });
  return { ...f, app, state, scopes, createInput, invoke };
}

test("genuine UI prepares a protected project through the original SQL view, creates/replays the original Thread and lists it without starting a Run", async (t) => {
  const f = await fixture(t);
  const first = (await f.invoke(actions.createConversation, f.createInput)) as {
    disposition: string;
    binding: { threadId: string; workspaceId: string };
  };
  assert.equal(first.disposition, "committed");
  assert.equal(first.binding.workspaceId, "workspace-isolated");
  const ids = f.state.idCount;
  const threadPreparations = f.state.threadPreparations;
  const replay = (await f.invoke(
    actions.createConversation,
    f.createInput,
  )) as typeof first;
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.binding.threadId, first.binding.threadId);
  assert.equal(f.state.idCount, ids);
  assert.equal(f.state.threadPreparations, threadPreparations);
  const page = (await f.invoke(actions.listConversations, {
    projectId: f.createInput.projectId,
    afterThreadId: null,
    limit: 16,
  })) as { bindings: { threadId: string }[] };
  assert.equal(page.bindings.length, 1);
  assert.equal(page.bindings[0]!.threadId, first.binding.threadId);
  const opened = (await f.invoke(actions.openConversation, {
    projectId: f.createInput.projectId,
    threadId: first.binding.threadId,
  })) as { binding: { threadId: string } };
  assert.equal(opened.binding.threadId, first.binding.threadId);
  assert.equal(
    (
      await f.second.parent.loadThread({
        tenantId: f.actor.tenantId,
        threadId: first.binding.threadId,
      })
    )?.workspaceId,
    "workspace-isolated",
  );
  assert.equal(f.state.taskCount, 0);
  for (const source of f.scopes) {
    assert.throws(() => qualifyPluginProjectReadScope(source), /unavailable/u);
    assert.throws(
      () => qualifyPluginProjectReadScope({ ...source }),
      /unavailable/u,
    );
  }
});

test("protected UI uses original binding management for revoke, restore, source refresh and replay without creating another Thread", async (t) => {
  const f = await fixture(t);
  const created = (await f.invoke(
    actions.createConversation,
    f.createInput,
  )) as {
    binding: { threadId: string; revision: number };
  };
  const initialIds = f.state.idCount;
  const initialPreparations = f.state.threadPreparations;
  const revoke = {
    projectId: f.createInput.projectId,
    threadId: created.binding.threadId,
    expectedBindingRevision: created.binding.revision,
    state: "revoked",
    idempotencyKey: "change-binding",
  };
  const revoked = (await f.invoke(actions.setState, revoke)) as {
    disposition: string;
    binding: { threadId: string; revision: number; state: string };
  };
  assert.equal(revoked.binding.state, "revoked");
  assert.equal(revoked.binding.revision, 2);
  const replay = (await f.invoke(actions.setState, revoke)) as typeof revoked;
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.binding, revoked.binding);
  await assert.rejects(
    f.invoke(actions.setState, { ...revoke, state: "active" }),
    /conflict/,
  );
  const restore = {
    ...revoke,
    state: "active",
    expectedBindingRevision: 2,
    idempotencyKey: "restore-binding",
  };
  const restored = (await f.invoke(
    actions.setState,
    restore,
  )) as typeof revoked;
  assert.equal(restored.binding.state, "active");
  assert.equal(restored.binding.revision, 3);
  const refresh = {
    projectId: revoke.projectId,
    threadId: revoke.threadId,
    expectedBindingRevision: 3,
    idempotencyKey: "change-binding",
  };
  // Equal external key across two original methods is scoped to the real action, not a different manager.
  const refreshed = (await f.invoke(
    actions.refreshSource,
    refresh,
  )) as typeof revoked;
  assert.equal(refreshed.binding.revision, 4);
  const refreshReplay = (await f.invoke(
    actions.refreshSource,
    refresh,
  )) as typeof revoked;
  assert.equal(refreshReplay.disposition, "replayed");
  assert.deepEqual(refreshReplay.binding, refreshed.binding);
  const cold = await f.second.parent.projectConversationStore().loadBinding({
    ...f.owner,
    threadId: revoke.threadId,
  });
  assert.equal(cold!.revision, 4);
  assert.equal(cold!.workspaceId, "workspace-isolated");
  assert.equal(f.state.idCount, initialIds);
  assert.equal(f.state.threadPreparations, initialPreparations);
  assert.equal(f.state.taskCount, 0);
});

test("protected binding mutations and replay retain independent project policy, current Host identity and revision checks", async (t) => {
  const f = await fixture(t);
  const created = (await f.invoke(
    actions.createConversation,
    f.createInput,
  )) as { binding: { threadId: string; revision: number } };
  const request = {
    projectId: f.createInput.projectId,
    threadId: created.binding.threadId,
    expectedBindingRevision: 1,
    state: "revoked",
    idempotencyKey: "protected-revoke",
  };
  f.state.policyAllowed = false;
  await assert.rejects(
    f.invoke(actions.setState, request),
    /creative_project_access_denied/,
  );
  f.state.policyAllowed = true;
  f.state.pinDrift = true;
  await assert.rejects(
    f.invoke(actions.setState, request),
    /plugin_project_read_scope_unavailable/,
  );
  f.state.pinDrift = false;
  await assert.rejects(
    f.invoke(actions.setState, { ...request, expectedBindingRevision: 7 }),
    /project_conversation_revision_conflict/,
  );
  assert.equal(
    (await f.store.loadBinding({ ...f.owner, threadId: request.threadId }))!
      .revision,
    1,
  );
  await f.invoke(actions.setState, request);
  f.state.policyAllowed = false;
  await assert.rejects(
    f.invoke(actions.setState, request),
    /creative_project_access_denied/,
  );
  f.state.policyAllowed = true;
  f.state.hostActive = false;
  await assert.rejects(
    f.invoke(actions.refreshSource, {
      projectId: request.projectId,
      threadId: request.threadId,
      expectedBindingRevision: 2,
      idempotencyKey: "closed-source",
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.cause instanceof Error &&
      error.cause.message === "named_host_closed",
  );
  assert.equal(
    (await f.store.loadBinding({ ...f.owner, threadId: request.threadId }))!
      .revision,
    2,
  );
  assert.equal(f.state.taskCount, 0);
});

test("withdrawal after the last Host transaction await prevents protected binding changes and their receipt", async (t) => {
  for (const method of ["setState", "refreshSource"] as const) {
    const f = await fixture(t);
    const created = (await f.invoke(
      actions.createConversation,
      f.createInput,
    )) as { binding: { threadId: string } };
    const beforeDb = new DatabaseSync(f.databasePath);
    const threadCount = Number(
      beforeDb.prepare("SELECT COUNT(*) AS n FROM threads").get()!.n,
    );
    beforeDb.close();
    f.state.beforeBindingCommit = () => {
      f.state.afterHostTransactionCurrent = () => {
        f.state.policyAllowed = false;
      };
    };
    const request = {
      projectId: f.createInput.projectId,
      threadId: created.binding.threadId,
      expectedBindingRevision: 1,
      idempotencyKey: "withdraw-binding-change",
      ...(method === "setState" ? { state: "revoked" } : {}),
    };
    await assert.rejects(
      f.invoke(actions[method], request),
      /creative_project_access_denied/,
    );
    const binding = await f.store.loadBinding({
      ...f.owner,
      threadId: request.threadId,
    });
    assert.equal(binding!.revision, 1);
    assert.equal(binding!.state, "active");
    const db = new DatabaseSync(f.databasePath);
    try {
      assert.equal(
        Number(
          db
            .prepare("SELECT COUNT(*) AS n FROM project_conversation_receipts")
            .get()!.n,
        ),
        1,
      );
      assert.equal(
        Number(db.prepare("SELECT COUNT(*) AS n FROM threads").get()!.n),
        threadCount,
      );
    } finally {
      db.close();
    }
    assert.equal(f.state.taskCount, 0);
  }
});

test("protected conversation UI retains independent project policy and refuses another plugin's project before allocating IDs", async (t) => {
  for (const condition of ["policy", "foreign"] as const) {
    const f = await fixture(
      t,
      condition === "foreign" ? "pluginId" : "matching",
    );
    if (condition === "policy") f.state.policyAllowed = false;
    await assert.rejects(
      f.invoke(actions.createConversation, f.createInput),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code ===
          (condition === "policy"
            ? "creative_project_access_denied"
            : "creative_project_not_found"),
    );
    assert.equal(f.state.idCount, 0);
    assert.equal(f.state.threadPreparations, 0);
    assert.equal(f.state.taskCount, 0);
    assert.deepEqual(
      (
        await f.store.listBindings({
          ...f.owner,
          projectId: f.createInput.projectId,
          afterThreadId: null,
          limit: 16,
        })
      ).bindings,
      [],
    );
  }
});

test("genuine UI isolates equal external creation keys by project and rejects changed contents before allocating more IDs", async (t) => {
  const f = await fixture(t);
  const projectId = "second-owned-conversation-project";
  await f.parent
    .creativeProjectStore()
    .commitProjectCreation(
      creationRecipe(projectId, "second-owned-project", f.actor),
    );
  const db = new DatabaseSync(f.databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const prior = db
      .prepare(
        "SELECT * FROM plugin_project_metadata_owners WHERE project_id=?",
      )
      .get(f.createInput.projectId)!;
    const record = JSON.parse(prior.record_json as string);
    record.owner.projectId = projectId;
    db.prepare(
      `INSERT INTO plugin_project_metadata_owners(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    ).run(
      ...columns.map((column) =>
        column === "project_id"
          ? projectId
          : column === "record_json"
            ? JSON.stringify(record)
            : prior[column]!,
      ),
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  await (
    await f.mounted()
  ).write(f.namespaceRecipe(projectId, "workspace-second"));
  const first = (await f.invoke(actions.createConversation, f.createInput)) as {
    binding: { threadId: string };
  };
  const secondInput = {
    ...f.createInput,
    projectId,
    workspaceId: "workspace-second",
  };
  const second = (await f.invoke(
    actions.createConversation,
    secondInput,
  )) as typeof first;
  assert.notEqual(second.binding.threadId, first.binding.threadId);
  const ids = f.state.idCount;
  const threadPreparations = f.state.threadPreparations;
  const replay = (await f.invoke(
    actions.createConversation,
    secondInput,
  )) as typeof first & { disposition: string };
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.binding.threadId, second.binding.threadId);
  await assert.rejects(
    f.invoke(actions.createConversation, {
      ...secondInput,
      title: "changed title",
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "project_conversation_idempotency_conflict",
  );
  for (const [input, binding] of [
    [f.createInput, first.binding],
    [secondInput, second.binding],
  ] as const) {
    const revoke = {
      projectId: input.projectId,
      threadId: binding.threadId,
      expectedBindingRevision: 1,
      state: "revoked",
      idempotencyKey: "shared-project-mutation-key",
    };
    const changed = (await f.invoke(actions.setState, revoke)) as {
      disposition: string;
      binding: { threadId: string; revision: number };
    };
    assert.equal(changed.disposition, "committed");
    assert.equal(changed.binding.threadId, binding.threadId);
    assert.equal(changed.binding.revision, 2);
    const replayed = (await f.invoke(
      actions.setState,
      revoke,
    )) as typeof changed;
    assert.equal(replayed.disposition, "replayed");
    assert.deepEqual(replayed.binding, changed.binding);
  }
  assert.equal(f.state.idCount, ids);
  assert.equal(f.state.threadPreparations, threadPreparations);
  assert.equal(f.state.taskCount, 0);
});

test("copied UI context cannot prepare a protected project and the ordinary call remains on the original legacy reader", async (t) => {
  const f = await fixture(t);
  await f.invoke(actions.listConversations, {
    projectId: f.createInput.projectId,
    afterThreadId: null,
    limit: 16,
  });
  assert.ok(f.state.context);
  await assert.rejects(
    f.app.metadataFromPluginUi({ ...f.state.context }, f.authority),
    /unavailable/u,
  );
  await assert.rejects(
    f.app.createConversation(f.actor, f.createInput, f.authority),
  );
  assert.equal(f.state.idCount, 0);
  assert.equal(f.state.threadPreparations, 0);
  assert.equal(f.state.taskCount, 0);
});

test("genuine UI cannot lend its reader to a drifting Host pin, a closed Host or stage execution", async (t) => {
  for (const condition of ["pin", "closed", "stage"] as const) {
    const f = await fixture(t);
    if (condition === "pin") f.state.pinDrift = true;
    if (condition === "closed") f.state.hostActive = false;
    const pending =
      condition === "stage"
        ? f.invoke(actions.startStage, {
            projectId: f.createInput.projectId,
            threadId: "not-an-execution-grant",
            expectedThreadRevision: 1,
            expectedBindingRevision: 1,
            content: "create a script",
            idempotencyKey: "no-run",
            stage: { kind: "discussion" },
          })
        : f.invoke(actions.createConversation, f.createInput);
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof ApplicationError &&
        (condition === "closed"
          ? error.code === "plugin_ui_unavailable" &&
            error.cause instanceof Error &&
            error.cause.message === "named_host_closed"
          : error.code === "plugin_project_read_scope_unavailable"),
    );
    assert.equal(f.state.idCount, 0);
    assert.equal(f.state.threadPreparations, 0);
    assert.equal(f.state.taskCount, 0);
    assert.equal(f.scopes.length, 0);
  }
});

test("a genuine UI call cannot fall back to legacy reads when the original Store lacks its qualified reader", async (t) => {
  const f = await fixture(t, "matching", "missing");
  await assert.rejects(
    f.invoke(actions.createConversation, f.createInput),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "plugin_project_read_store_unavailable",
  );
  assert.equal(f.state.idCount, 0);
  assert.equal(f.state.threadPreparations, 0);
  assert.equal(f.state.taskCount, 0);
  assert.equal(f.scopes.length, 0);
});

test("independent project write policy withdrawn after original Thread preparation prevents the owned Conversation commit", async (t) => {
  const f = await fixture(t);
  f.state.afterThreadPrepared = () => {
    f.state.policyAllowed = false;
  };
  await assert.rejects(
    f.invoke(actions.createConversation, f.createInput),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "creative_project_access_denied",
  );
  assert.equal(f.state.threadPreparations, 1);
  assert.ok(f.state.preparedThreadId);
  assert.equal(
    await f.parent.loadThread({
      tenantId: f.actor.tenantId,
      threadId: f.state.preparedThreadId,
    }),
    null,
  );
  const db = new DatabaseSync(f.databasePath);
  try {
    assert.equal(
      Number(
        db
          .prepare("SELECT COUNT(*) AS n FROM project_conversation_bindings")
          .get()!.n,
      ),
      0,
    );
    assert.equal(
      Number(
        db
          .prepare("SELECT COUNT(*) AS n FROM project_conversation_receipts")
          .get()!.n,
      ),
      0,
    );
  } finally {
    db.close();
  }
  assert.equal(f.state.taskCount, 0);
});
