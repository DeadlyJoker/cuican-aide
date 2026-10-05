import {
  sqliteRequiredStageDigest,
  sqliteThreadBindingMarker,
} from "./project-conversation-markers.ts";
import { loadSqliteStageIfAvailable } from "./project-stage-run-store-support.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  CommitThreadInput,
  CommitThreadResult,
  ProjectConversationStore,
} from "@crewon/application";
import {
  projectTextRecord,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  extensionCanonicalJson,
  type ThreadState,
} from "@crewon/domain";
import { decodeCreativeProject } from "./creative-project-store-records.ts";
import { assertSqliteProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertSqliteConversationSchema,
  migrateSqliteConversations,
} from "./project-conversation-schema.ts";
import {
  assertConversationChange,
  bindingColumns,
  bindingOwner,
  bindingValues,
  captureConversationMutation,
  conversationFail,
  conversationOwner,
  conversationReceipt,
  decodeConversation,
  decodeConversationReceipt,
  decodeStageAdmission,
  ownerValues,
  ownerWhere,
} from "./project-conversation-store-support.ts";

export class SqliteProjectConversationStore
  implements ProjectConversationStore
{
  readonly version = "crewon.project-conversation-binding.v1" as const;
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  readonly #thread: (input: CommitThreadInput) => CommitThreadResult;
  readonly #loadThread: (
    tenantId: string,
    threadId: string,
  ) => ThreadState | null;
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    commitThreadWithin(input: CommitThreadInput): CommitThreadResult;
    loadThreadWithin(tenantId: string, threadId: string): ThreadState | null;
  }) {
    this.#db = input.database;
    this.#open = input.assertOpen.bind(input);
    this.#thread = input.commitThreadWithin.bind(input);
    this.#loadThread = input.loadThreadWithin.bind(input);
  }
  async migrate(): Promise<void> {
    this.#transaction(() => migrateSqliteConversations(this.#db));
  }
  async loadBinding(
    input: Parameters<ProjectConversationStore["loadBinding"]>[0],
  ) {
    const v = projectTextRecord(input, ["actor", "profileId", "threadId"]),
      o = conversationOwner({ actor: v.actor, profileId: v.profileId }),
      threadId = creativeProjectOpaqueId(v.threadId);
    this.#open();
    assertSqliteConversationSchema(this.#db);
    return decodeConversation(
      this.#get(
        `SELECT * FROM project_conversation_bindings WHERE ${ownerWhere} AND thread_id=?`,
        [...ownerValues(o), threadId],
      ),
      o,
    );
  }
  async hasThreadBinding(
    input: Parameters<ProjectConversationStore["hasThreadBinding"]>[0],
  ): Promise<boolean> {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "threadId"]),
      tenantId = creativeProjectOpaqueId(v.tenantId),
      spaceId = creativeProjectOpaqueId(v.spaceId),
      threadId = creativeProjectOpaqueId(v.threadId);
    this.#open();
    const marker = sqliteThreadBindingMarker(this.#db, {
      tenantId,
      spaceId,
      threadId,
    });
    const objects = this.#db
      .prepare(
        "SELECT name FROM main.sqlite_schema WHERE name IN ('project_conversation_schema_version','project_conversation_bindings','project_conversation_receipts','project_stage_run_admissions') UNION ALL SELECT name FROM temp.sqlite_schema WHERE name IN ('project_conversation_schema_version','project_conversation_bindings','project_conversation_receipts','project_stage_run_admissions')",
      )
      .all();
    if (objects.length === 0) {
      if (marker !== null)
        conversationFail("project_conversation_binding_corrupt");
      return false;
    }
    assertSqliteConversationSchema(this.#db);
    const b = decodeConversation(
      this.#get(
        "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND thread_id=?",
        [tenantId, spaceId, threadId],
      ),
    );
    if (marker !== (b?.bindingId ?? null))
      conversationFail("project_conversation_binding_corrupt");
    return b !== null;
  }
  async listBindings(
    input: Parameters<ProjectConversationStore["listBindings"]>[0],
  ) {
    const v = projectTextRecord(input, [
        "actor",
        "profileId",
        "projectId",
        "afterThreadId",
        "limit",
      ]),
      o = conversationOwner({ actor: v.actor, profileId: v.profileId }),
      projectId = creativeProjectOpaqueId(v.projectId),
      after =
        v.afterThreadId === null
          ? null
          : creativeProjectOpaqueId(v.afterThreadId),
      limit = creativeProjectRevision(v.limit);
    if (limit > 16) conversationFail("project_conversation_limit_invalid");
    this.#open();
    assertSqliteConversationSchema(this.#db);
    const rows = this.#db
      .prepare(
        `SELECT * FROM project_conversation_bindings WHERE ${ownerWhere} AND project_id=? ${after === null ? "" : "AND thread_id COLLATE BINARY>?"} ORDER BY thread_id COLLATE BINARY LIMIT ?`,
      )
      .all(
        ...ownerValues(o),
        projectId,
        ...(after === null ? [] : [after]),
        limit + 1,
      );
    const values = rows.slice(0, limit).map((r) => decodeConversation(r, o)!);
    return Object.freeze({
      bindings: Object.freeze(values),
      nextThreadId: rows.length > limit ? values.at(-1)!.threadId : null,
    });
  }
  async loadMutationReceipt(
    input: Parameters<ProjectConversationStore["loadMutationReceipt"]>[0],
  ) {
    const v = projectTextRecord(input, ["actor", "profileId", "receipt"]),
      o = conversationOwner({ actor: v.actor, profileId: v.profileId }),
      receipt = conversationReceipt(v.receipt);
    if (
      extensionCanonicalJson(receipt.actor) !== extensionCanonicalJson(o.actor)
    )
      conversationFail();
    this.#open();
    assertSqliteConversationSchema(this.#db);
    return decodeConversationReceipt(
      this.#get(
        `SELECT * FROM project_conversation_receipts WHERE ${ownerWhere} AND idempotency_key=?`,
        [...ownerValues(o), receipt.idempotencyKey],
      ),
      o,
      receipt,
    );
  }
  async commitBinding(
    input: Parameters<ProjectConversationStore["commitBinding"]>[0],
    options: Parameters<ProjectConversationStore["commitBinding"]>[1],
  ) {
    const p = captureConversationMutation(input, options),
      o = bindingOwner(p.binding);
    await p.q.assertCurrent();
    await p.q.assertTransactionCurrent();
    p.q.assertActive();
    return this.#transaction(
      () => {
        assertSqliteConversationSchema(this.#db);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
        const previousReceipt = decodeConversationReceipt(
          this.#get(
            `SELECT * FROM project_conversation_receipts WHERE ${ownerWhere} AND idempotency_key=?`,
            [...ownerValues(o), p.receipt.idempotencyKey],
          ),
          o,
          p.receipt,
        );
        this.#project(p.binding);
        if (previousReceipt !== null) {
          if (
            previousReceipt.kind !== p.kind ||
            previousReceipt.binding.threadId !== p.binding.threadId ||
            previousReceipt.binding.projectId !== p.binding.projectId ||
            extensionCanonicalJson(
              previousReceipt.binding.currentInstallation,
            ) !== extensionCanonicalJson(p.q.installation)
          )
            conversationFail("project_conversation_idempotency_conflict");
          this.#assertThread(previousReceipt.binding);
          return previousReceipt;
        }
        const previous = decodeConversation(
          this.#get(
            "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND thread_id=?",
            [o.actor.tenantId, o.actor.spaceId, p.binding.threadId],
          ),
        );
        assertConversationChange(
          p.kind,
          previous,
          p.binding,
          p.expectedRevision,
        );
        if (p.thread !== undefined) {
          const created = this.#thread(p.thread);
          if (created.state.threadId !== p.binding.threadId) conversationFail();
        }
        this.#assertThread(p.binding);
        if (p.kind === "create")
          this.#db
            .prepare(
              `INSERT INTO project_conversation_bindings(${bindingColumns}) VALUES(${Array(11).fill("?").join(",")})`,
            )
            .run(...bindingValues(p.binding));
        else if (
          this.#db
            .prepare(
              "UPDATE project_conversation_bindings SET revision=?,state=?,record_json=? WHERE tenant_id=? AND space_id=? AND binding_id=? AND revision=?",
            )
            .run(
              p.binding.revision,
              p.binding.state,
              JSON.stringify(p.binding),
              o.actor.tenantId,
              o.actor.spaceId,
              p.binding.bindingId,
              p.expectedRevision,
            ).changes !== 1
        )
          conversationFail("project_conversation_revision_conflict");
        if (
          p.kind === "create" &&
          this.#db
            .prepare(
              "UPDATE threads SET project_conversation_binding_id=? WHERE tenant_id=? AND thread_id=? AND project_conversation_binding_id IS NULL",
            )
            .run(p.binding.bindingId, o.actor.tenantId, p.binding.threadId)
            .changes !== 1
        )
          conversationFail("project_conversation_thread_conflict");
        const result = Object.freeze({
          kind: p.kind,
          disposition: "committed" as const,
          binding: p.binding,
        });
        this.#db
          .prepare(
            "INSERT INTO project_conversation_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            ...ownerValues(o),
            p.receipt.idempotencyKey,
            p.receipt.requestDigest,
            p.kind,
            p.binding.bindingId,
            JSON.stringify(result),
          );
        return result;
      },
      () => {
        p.q.assertActive();
        assertSqliteProjectTextUiCommit(this.#db, p.q);
      },
    );
  }
  async readRequiredStageDigest(
    input: Parameters<ProjectConversationStore["readRequiredStageDigest"]>[0],
  ) {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "runId"]);
    this.#open();
    return sqliteRequiredStageDigest(this.#db, {
      tenantId: creativeProjectOpaqueId(v.tenantId),
      spaceId: creativeProjectOpaqueId(v.spaceId),
      runId: creativeProjectOpaqueId(v.runId),
    });
  }
  async loadStageAdmission(
    input: Parameters<ProjectConversationStore["loadStageAdmission"]>[0],
  ) {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "runId"]);
    const tenantId = creativeProjectOpaqueId(v.tenantId),
      spaceId = creativeProjectOpaqueId(v.spaceId),
      runId = creativeProjectOpaqueId(v.runId);
    this.#open();
    const result = loadSqliteStageIfAvailable(this.#db, { tenantId, runId });
    if (result !== null && result.actor.spaceId !== spaceId) conversationFail();
    return result;
  }
  #project(b: Parameters<typeof bindingOwner>[0]): void {
    const project = decodeCreativeProject(
      this.#get(
        "SELECT * FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=?",
        [b.owner.tenantId, b.owner.spaceId, b.projectId],
      ),
      b.owner,
      b.projectId,
    );
    if (project === null) conversationFail("creative_project_not_found");
    if (project.state !== "active")
      conversationFail("creative_project_archived");
  }
  #assertThread(b: Parameters<typeof bindingOwner>[0]): void {
    const thread = this.#loadThread(b.owner.tenantId, b.threadId);
    if (
      thread === null ||
      thread.spaceId !== b.owner.spaceId ||
      thread.createdByActorId !== b.owner.actorId ||
      thread.status !== "active" ||
      (thread.workspaceId ?? null) !== b.workspaceId
    )
      conversationFail("project_conversation_thread_conflict");
  }
  #get(sql: string, values: readonly SQLInputValue[]) {
    return this.#db.prepare(sql).get(...values);
  }
  #transaction<T>(work: () => T, before?: () => void): T {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const r = work();
      before?.();
      this.#open();
      this.#db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
}
