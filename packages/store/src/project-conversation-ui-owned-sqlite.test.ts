import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  qualifyPluginProjectReadScope,
  qualifyPluginProjectWorkspacePreparation,
} from "@crewon/application";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ownedConversationUiFixture as fixture } from "./project-conversation-ui-owned.test-support.ts";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import { pluginProjectMetadataOwnerColumns as columns } from "./plugin-project-metadata-owner-records.ts";

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

test("original protected project prepares a live Native owner from genuine UI and original Store without allocating a directory or another Thread", async (t) => {
  const f = await fixture(t, "matching", "available", "nativeIdentity");
  f.state.prepareWorkspace = true;
  f.state.onWorkspacePrepared = async (ref) => {
    const q = qualifyPluginProjectWorkspacePreparation(ref);
    assert.deepEqual(q.owner, f.namespaceOwner());
    assert.equal(q.expectedWorkspaceId, f.createInput.workspaceId);
    assert.deepEqual(q.packageIdentity, {
      pluginId: f.installation.pluginId,
      publisherId: f.installation.publisherId,
      version: f.installation.version,
      packageDigest: f.installation.packageDigest,
    });
    assert.ok(Object.isFrozen(q.owner));
    assert.ok(Object.isFrozen(q.packageIdentity));
    assert.throws(
      () => qualifyPluginProjectWorkspacePreparation({ ...ref }),
      /preparation_unavailable/,
    );
    assert.equal(f.state.threadPreparations, 0);
    assert.equal(f.state.idCount, 0);
    await q.assertCurrent();
  };
  await f.invoke(actions.createConversation, f.createInput);
  assert.equal(f.state.preparations.length, 1);
  assert.throws(
    () => qualifyPluginProjectWorkspacePreparation(f.state.preparations[0]!),
    /unavailable/,
  );
  assert.equal(f.state.threadPreparations, 1);
  assert.equal(f.state.taskCount, 0);
});

test("workspace preparation refuses borrowed methods, arbitrary workspaces, missing readers, foreign projects and write-policy withdrawal", async (t) => {
  for (const condition of [
    "method",
    "workspace",
    "reader",
    "foreign",
    "legacy",
    "policy",
    "lastAwait",
  ] as const) {
    const f = await fixture(
      t,
      condition === "foreign" ? "pluginId" : "matching",
      condition === "reader" ? "missing" : "available",
      "nativeIdentity",
    );
    f.state.prepareWorkspace = true;
    let legacyProjectId: string | undefined;
    if (condition === "legacy") {
      legacyProjectId = "legacy-workspace-preparation-project";
      await f.parent
        .creativeProjectStore()
        .commitProjectCreation(
          creationRecipe(
            legacyProjectId,
            "legacy-workspace-preparation",
            f.actor,
          ),
        );
    }
    if (condition === "policy") f.state.policyAllowed = false;
    if (condition === "lastAwait")
      f.state.afterHostTransactionCurrent = () => {
        f.state.policyAllowed = false;
      };
    const action =
      condition === "method"
        ? actions.listConversations
        : actions.createConversation;
    const input =
      condition === "method"
        ? { projectId: f.createInput.projectId, afterThreadId: null, limit: 16 }
        : condition === "workspace"
          ? { ...f.createInput, workspaceId: "another-workspace" }
          : condition === "legacy"
            ? {
                ...f.createInput,
                projectId: legacyProjectId!,
                workspaceId: null,
              }
            : f.createInput;
    const expected =
      condition === "method"
        ? "plugin_project_workspace_preparation_method_mismatch"
        : condition === "workspace"
          ? "plugin_project_workspace_preparation_target_mismatch"
          : condition === "reader"
            ? "plugin_project_read_store_unavailable"
            : condition === "foreign" || condition === "legacy"
              ? "creative_project_not_found"
              : "creative_project_access_denied";
    await assert.rejects(
      f.invoke(action, input),
      (error) => error instanceof ApplicationError && error.code === expected,
    );
    assert.equal(f.state.preparations.length, 0);
    assert.equal(f.state.idCount, 0);
    assert.equal(f.state.threadPreparations, 0);
    assert.equal(f.state.taskCount, 0);
  }
});

test("a prepared Native owner rechecks project state, live Host, policy and UI identity rather than becoming a retained write grant", async (t) => {
  const f = await fixture(t, "matching", "available", "nativeIdentity");
  f.state.prepareWorkspace = true;
  f.state.onWorkspacePrepared = async (ref) => {
    const q = qualifyPluginProjectWorkspacePreparation(ref);
    f.state.policyAllowed = false;
    await assert.rejects(q.assertCurrent(), /creative_project_access_denied/);
    f.state.policyAllowed = true;
    f.state.hostActive = false;
    assert.throws(q.assertActive, /named_host_closed/);
    f.state.hostActive = true;
    // Explicit persisted-state fixture exercises the original reader; it is not a production mutation shortcut.
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare(
        "UPDATE creative_projects SET state='archived', record_json=json_set(record_json,'$.state','archived') WHERE project_id=?",
      ).run(f.createInput.projectId);
    } finally {
      db.close();
    }
    await assert.rejects(q.assertCurrent(), /creative_project_archived/);
    const restore = new DatabaseSync(f.databasePath);
    try {
      restore
        .prepare(
          "UPDATE creative_projects SET state='active', record_json=json_set(record_json,'$.state','active') WHERE project_id=?",
        )
        .run(f.createInput.projectId);
    } finally {
      restore.close();
    }
    await q.assertCurrent();
  };
  await f.invoke(actions.createConversation, f.createInput);
  assert.throws(
    () => qualifyPluginProjectWorkspacePreparation(f.state.preparations[0]!),
    /unavailable/,
  );
  assert.equal(f.state.taskCount, 0);
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
