import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ThreadApplicationService,
  ExtensionTaskApplicationService,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import {
  createProjectConversationBinding,
  parsePluginTaskAdmissionPin,
  type ProjectConversationBinding,
} from "@crewon/domain";
import { unmeteredFixture } from "./plugin-task-unmetered.test-support.ts";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";

/** Actual parent Thread/project/installation and task writers; named policy only, no provider or ledger. */
export async function conversationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  base?: Awaited<ReturnType<typeof unmeteredFixture>>,
) {
  const f = base ?? (await unmeteredFixture(t, backend)),
    parent = f.first.parent,
    store = parent.projectConversationStore();
  await store.migrate();
  const pin = parsePluginTaskAdmissionPin({
    ...f.pin,
    action: "project.execute",
  });
  const installation = Object.freeze({
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    profileId: pin.profileId,
    pluginId: pin.pluginId,
    publisherId: pin.publisherId,
    version: pin.version,
    packageDigest: pin.packageDigest,
    selectionRevision: pin.selectionRevision,
  });
  const state = {
    live: true,
    current: true,
    beforeTransaction: null as (() => void | Promise<void>) | null,
    withdrawAfterChecks: 0,
    transactionChecks: 0,
  };
  const active = () => {
    if (!state.live)
      throw new Error("named_project_conversation_owner_withdrawn");
  };
  const authority: ProjectConversationCommitAuthority = {
    version: "crewon.project-conversation-commit.v1",
    actor: f.actor,
    installation,
    selection: f.enabled.selection,
    package: f.installed.package,
    pin,
    async assertCurrent() {
      active();
      if (!state.current)
        throw new Error("named_project_conversation_pdp_denied");
    },
    async assertTransactionCurrent() {
      state.transactionChecks++;
      await state.beforeTransaction?.();
      active();
      if (!state.current)
        throw new Error("named_project_conversation_pdp_denied");
      if (
        state.withdrawAfterChecks > 0 &&
        state.transactionChecks === state.withdrawAfterChecks
      )
        state.live = false;
    },
    assertActive: active,
  };
  const allow = {
    async authorize() {
      return { outcome: "allow" as const };
    },
  };
  const threads = new ThreadApplicationService({
    store: parent,
    authorization: allow,
    clock: { now: () => timestamp },
    ids: { nextId: () => randomUUID() },
    digester,
    workspaceAdmission: {
      async admit() {
        active();
      },
    },
  });
  async function prepare(
    key = randomUUID(),
    workspaceId: string | null = "workspace-original",
  ) {
    const thread = await threads.prepareCreateThread(f.actor, {
      kind: "thread.create",
      title: "Project conversation",
      workspaceId,
      idempotencyKey: key,
    });
    const event = thread.events[0];
    assert.equal(event?.type, "thread.created");
    assert.ok(event);
    const binding = createProjectConversationBinding(
      {
        bindingId: randomUUID(),
        owner: f.actor,
        profileId: installation.profileId,
        projectId: f.reference.projectId,
        threadId: event.identity.threadId,
        workspaceId,
        revision: 1,
        state: "active",
        currentInstallation: installation,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      digester,
    );
    return {
      kind: "create" as const,
      binding,
      expectedRevision: 0,
      receipt: {
        actor: f.actor,
        idempotencyKey: key,
        requestDigest: digester.sha256(`conversation:${key}`),
      },
      thread,
    };
  }
  const mutate = (
    previous: ProjectConversationBinding,
    kind: "refresh-source" | "set-state",
    key = randomUUID(),
  ) => {
    const { schemaVersion: _s, contentDigest: _d, ...body } = previous;
    return {
      kind,
      binding: createProjectConversationBinding(
        {
          ...body,
          revision: previous.revision + 1,
          state: kind === "set-state" ? "revoked" : previous.state,
          updatedAt: timestamp,
        },
        digester,
      ),
      expectedRevision: previous.revision,
      receipt: {
        actor: f.actor,
        idempotencyKey: key,
        requestDigest: digester.sha256(`conversation:${key}`),
      },
    };
  };
  const tasks = new ExtensionTaskApplicationService({
    ...f.dependencies,
    store: parent,
    extensions: f.first.store,
    operations: f.operations,
    ids: { nextId: () => randomUUID() },
    host: { ...f.dependencies.host, taskAdmissionMode: () => "installed" },
    unmeteredTasks: {
      async prepareGeneration(input) {
        assert.deepEqual(input.pin, pin);
        return f.authority;
      },
    },
  });
  return {
    ...f,
    originalTaskFixture: f,
    parent,
    store,
    threads,
    installation,
    authority,
    active,
    owner: { actor: f.actor, profileId: installation.profileId },
    state,
    prepare,
    mutate,
    tasks,
    digester,
  };
}

/** Observe actual stage INSERT and confirmed SQL COMMIT, preserving original query results. */
export function observeStageCommit(
  backend: "sqlite" | "postgres",
  afterCommit: () => void,
): () => void {
  const prototype =
    backend === "sqlite" ? DatabaseSync.prototype : Client.prototype;
  const key = backend === "sqlite" ? "exec" : "query",
    descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
  const insertDescriptor =
    backend === "sqlite"
      ? Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!
      : null;
  let inserted = false;
  if (insertDescriptor !== null)
    Object.defineProperty(DatabaseSync.prototype, "prepare", {
      ...insertDescriptor,
      value: function (this: DatabaseSync, ...args: unknown[]) {
        const result = Reflect.apply(insertDescriptor.value, this, args);
        if (
          typeof args[0] === "string" &&
          /INSERT INTO .*project_stage_run_admissions/u.test(args[0])
        ) {
          const statement = result as { run(...values: unknown[]): unknown };
          const run = statement.run.bind(statement);
          statement.run = (...values) => {
            const value = run(...values);
            inserted = true;
            return value;
          };
        }
        return result;
      },
    });
  Object.defineProperty(prototype, key, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const value = Reflect.apply(descriptor.value, this, args);
      const sql = typeof args[0] === "string" ? args[0] : "";
      const observe = () => {
        if (/INSERT INTO .*project_stage_run_admissions/u.test(sql))
          inserted = true;
        if (sql === "COMMIT" && inserted) {
          inserted = false;
          afterCommit();
        }
      };
      if (backend === "postgres")
        return Promise.resolve(value).then((result) => {
          observe();
          return result;
        });
      observe();
      return value;
    },
  });
  return () => {
    Object.defineProperty(prototype, key, descriptor);
    if (insertDescriptor !== null)
      Object.defineProperty(
        DatabaseSync.prototype,
        "prepare",
        insertDescriptor,
      );
  };
}
