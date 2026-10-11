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
  };
  const scopes: PluginProjectReadScope[] = [];
  const projects = f.parent.creativeProjectStore();
  assert.ok(projects instanceof SqliteCreativeProjectStore);
  const app = new ProjectConversationApplicationService({
    conversations: f.store,
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
