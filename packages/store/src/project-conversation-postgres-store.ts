import {
  postgresRequiredStageDigest,
  postgresThreadBindingMarker,
} from "./project-conversation-markers.ts";
import { loadPostgresStageIfAvailable } from "./project-stage-run-store-support.ts";
import type { Pool, PoolClient } from "pg";
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
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { assertPostgresProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertPostgresConversationSchema,
  migratePostgresConversations,
} from "./project-conversation-schema.ts";
import { advisoryLock, threadLockKey } from "./postgres-thread-lock.ts";
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

export class PostgresProjectConversationStore
  implements ProjectConversationStore
{
  readonly version = "crewon.project-conversation-binding.v1" as const;
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #open: () => void;
  readonly #thread: (
    client: PoolClient,
    input: CommitThreadInput,
  ) => Promise<CommitThreadResult>;
  readonly #loadThread: (
    client: PoolClient,
    tenantId: string,
    threadId: string,
  ) => Promise<ThreadState | null>;
  constructor(input: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    commitThreadWithin(
      client: PoolClient,
      input: CommitThreadInput,
    ): Promise<CommitThreadResult>;
    loadThreadWithin(
      client: PoolClient,
      tenantId: string,
      threadId: string,
    ): Promise<ThreadState | null>;
  }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    creativeProjectSchemaName(input.schema);
    this.#open = input.assertOpen.bind(input);
    this.#thread = input.commitThreadWithin.bind(input);
    this.#loadThread = input.loadThreadWithin.bind(input);
  }
  async migrate(): Promise<void> {
    await this.#transaction(async (c) => {
      await advisoryLock(
        c,
        JSON.stringify(["project-conversation-schema", this.#schema]),
      );
      await migratePostgresConversations(c, this.#schema);
    });
  }
  async loadBinding(
    input: Parameters<ProjectConversationStore["loadBinding"]>[0],
  ) {
    const v = projectTextRecord(input, ["actor", "profileId", "threadId"]),
      o = conversationOwner({ actor: v.actor, profileId: v.profileId }),
      threadId = creativeProjectOpaqueId(v.threadId);
    return this.#transaction(async (c) => {
      await assertPostgresConversationSchema(c, this.#schema);
      return decodeConversation(
        await this.#get(
          c,
          `SELECT * FROM project_conversation_bindings WHERE ${ownerWhere} AND thread_id=?`,
          [...ownerValues(o), threadId],
        ),
        o,
      );
    });
  }
  async hasThreadBinding(
    input: Parameters<ProjectConversationStore["hasThreadBinding"]>[0],
  ): Promise<boolean> {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "threadId"]),
      tenantId = creativeProjectOpaqueId(v.tenantId),
      spaceId = creativeProjectOpaqueId(v.spaceId),
      threadId = creativeProjectOpaqueId(v.threadId);
    return this.#transaction(async (c) => {
      const marker = await postgresThreadBindingMarker(c, this.#schema, {
        tenantId,
        spaceId,
        threadId,
      });
      const objects = (
        await c.query(
          "SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('project_conversation_schema_version','project_conversation_bindings','project_conversation_receipts','project_stage_run_admissions')",
          [this.#schema],
        )
      ).rows;
      if (objects.length === 0) {
        if (marker !== null)
          conversationFail("project_conversation_binding_corrupt");
        return false;
      }
      await assertPostgresConversationSchema(c, this.#schema);
      const b = decodeConversation(
        await this.#get(
          c,
          "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND thread_id=?",
          [tenantId, spaceId, threadId],
        ),
      );
      if (marker !== (b?.bindingId ?? null))
        conversationFail("project_conversation_binding_corrupt");
      return b !== null;
    });
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
    return this.#transaction(async (c) => {
      await assertPostgresConversationSchema(c, this.#schema);
      const rows = (
        await this.#query(
          c,
          `SELECT * FROM project_conversation_bindings WHERE ${ownerWhere} AND project_id=? ${after === null ? "" : 'AND thread_id COLLATE "C">?'} ORDER BY thread_id COLLATE "C" LIMIT ?`,
          [
            ...ownerValues(o),
            projectId,
            ...(after === null ? [] : [after]),
            limit + 1,
          ],
        )
      ).rows;
      const values = rows.slice(0, limit).map((r) => decodeConversation(r, o)!);
      return Object.freeze({
        bindings: Object.freeze(values),
        nextThreadId: rows.length > limit ? values.at(-1)!.threadId : null,
      });
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
    return this.#transaction(async (c) => {
      await assertPostgresConversationSchema(c, this.#schema);
      return decodeConversationReceipt(
        await this.#get(
          c,
          `SELECT * FROM project_conversation_receipts WHERE ${ownerWhere} AND idempotency_key=?`,
          [...ownerValues(o), receipt.idempotencyKey],
        ),
        o,
        receipt,
      );
    });
  }
  async commitBinding(
    input: Parameters<ProjectConversationStore["commitBinding"]>[0],
    options: Parameters<ProjectConversationStore["commitBinding"]>[1],
  ) {
    const p = captureConversationMutation(input, options),
      o = bindingOwner(p.binding);
    await p.q.assertCurrent();
    p.q.assertActive();
    return this.#transaction(
      async (c) => {
        await assertPostgresConversationSchema(c, this.#schema);
        await assertPostgresProjectTextUiCommit(c, this.#schema, p.q);
        await advisoryLock(
          c,
          JSON.stringify([
            "project-conversation-receipt",
            this.#schema,
            ...ownerValues(o),
            p.receipt.idempotencyKey,
          ]),
        );
        if (p.thread !== undefined)
          await advisoryLock(
            c,
            `idempotency:${p.thread.idempotency.scope}:${p.thread.idempotency.key}`,
          );
        await advisoryLock(
          c,
          threadLockKey(o.actor.tenantId, p.binding.threadId),
        );
        const previousReceipt = decodeConversationReceipt(
          await this.#get(
            c,
            `SELECT * FROM project_conversation_receipts WHERE ${ownerWhere} AND idempotency_key=?`,
            [...ownerValues(o), p.receipt.idempotencyKey],
          ),
          o,
          p.receipt,
        );
        const previous = decodeConversation(
          await this.#get(
            c,
            "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND thread_id=? FOR UPDATE",
            [o.actor.tenantId, o.actor.spaceId, p.binding.threadId],
          ),
        );
        await this.#project(c, p.binding);
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
          await this.#assertThread(c, previousReceipt.binding);
          return previousReceipt;
        }
        assertConversationChange(
          p.kind,
          previous,
          p.binding,
          p.expectedRevision,
        );
        if (p.thread !== undefined) {
          const created = await this.#thread(c, p.thread);
          if (created.state.threadId !== p.binding.threadId) conversationFail();
        }
        await this.#assertThread(
          c,
          p.binding,
          p.existingThread?.expectedRevision,
        );
        if (p.kind === "create")
          await this.#query(
            c,
            `INSERT INTO project_conversation_bindings(${bindingColumns}) VALUES(${Array(11).fill("?").join(",")})`,
            bindingValues(p.binding),
          );
        else if (
          (
            await this.#query(
              c,
              "UPDATE project_conversation_bindings SET revision=?,state=?,record_json=? WHERE tenant_id=? AND space_id=? AND binding_id=? AND revision=?",
              [
                p.binding.revision,
                p.binding.state,
                JSON.stringify(p.binding),
                o.actor.tenantId,
                o.actor.spaceId,
                p.binding.bindingId,
                p.expectedRevision,
              ],
            )
          ).rowCount !== 1
        )
          conversationFail("project_conversation_revision_conflict");
        if (
          p.kind === "create" &&
          (
            await c.query(
              `UPDATE ${creativeProjectSchemaName(this.#schema)}.threads SET project_conversation_binding_id=$1 WHERE tenant_id=$2 AND thread_id=$3 AND project_conversation_binding_id IS NULL`,
              [p.binding.bindingId, o.actor.tenantId, p.binding.threadId],
            )
          ).rowCount !== 1
        )
          conversationFail("project_conversation_thread_conflict");
        const result = Object.freeze({
          kind: p.kind,
          disposition: "committed" as const,
          binding: p.binding,
        });
        await this.#query(
          c,
          "INSERT INTO project_conversation_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",
          [
            ...ownerValues(o),
            p.receipt.idempotencyKey,
            p.receipt.requestDigest,
            p.kind,
            p.binding.bindingId,
            JSON.stringify(result),
          ],
        );
        return result;
      },
      p.q.assertTransactionCurrent,
      p.q.assertActive,
    );
  }
  async readRequiredStageDigest(
    input: Parameters<ProjectConversationStore["readRequiredStageDigest"]>[0],
  ) {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "runId"]);
    const locator = {
      tenantId: creativeProjectOpaqueId(v.tenantId),
      spaceId: creativeProjectOpaqueId(v.spaceId),
      runId: creativeProjectOpaqueId(v.runId),
    };
    return this.#transaction((c) =>
      postgresRequiredStageDigest(c, this.#schema, locator),
    );
  }
  async loadStageAdmission(
    input: Parameters<ProjectConversationStore["loadStageAdmission"]>[0],
  ) {
    const v = projectTextRecord(input, ["tenantId", "spaceId", "runId"]);
    const tenantId = creativeProjectOpaqueId(v.tenantId),
      spaceId = creativeProjectOpaqueId(v.spaceId),
      runId = creativeProjectOpaqueId(v.runId);
    return this.#transaction(async (c) => {
      const result = await loadPostgresStageIfAvailable(c, this.#schema, {
        tenantId,
        runId,
      });
      if (result !== null && result.actor.spaceId !== spaceId)
        conversationFail();
      return result;
    });
  }
  async #project(
    c: PoolClient,
    b: Parameters<typeof bindingOwner>[0],
  ): Promise<void> {
    await advisoryLock(
      c,
      JSON.stringify([
        "creative-project-project",
        this.#schema,
        b.owner.tenantId,
        b.owner.spaceId,
        b.projectId,
      ]),
    );
    const project = decodeCreativeProject(
      await this.#get(
        c,
        "SELECT * FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=? FOR SHARE",
        [b.owner.tenantId, b.owner.spaceId, b.projectId],
      ),
      b.owner,
      b.projectId,
    );
    if (project === null) conversationFail("creative_project_not_found");
    if (project.state !== "active")
      conversationFail("creative_project_archived");
  }
  async #assertThread(
    c: PoolClient,
    b: Parameters<typeof bindingOwner>[0],
    expectedRevision?: number,
  ): Promise<void> {
    const thread = await this.#loadThread(c, b.owner.tenantId, b.threadId);
    if (
      thread === null ||
      thread.spaceId !== b.owner.spaceId ||
      thread.createdByActorId !== b.owner.actorId ||
      thread.status !== "active" ||
      (thread.workspaceId ?? null) !== b.workspaceId ||
      (expectedRevision !== undefined && thread.revision !== expectedRevision)
    )
      conversationFail("project_conversation_thread_conflict");
    if (expectedRevision !== undefined) {
      const p = `${creativeProjectSchemaName(this.#schema)}.`;
      const params = [b.owner.tenantId, b.threadId];
      const active = await c.query(
        `SELECT s.run_id FROM ${p}run_snapshots s JOIN ${p}run_thread_bindings r ON r.tenant_id=s.tenant_id AND r.run_id=s.run_id WHERE s.tenant_id=$1 AND r.thread_id=$2 AND COALESCE(s.state_json->>'status','invalid') NOT IN ('completed','failed','canceled') LIMIT 1`,
        params,
      );
      const unsettled = await c.query(
        `SELECT w.work_item_id FROM ${p}work_items w JOIN ${p}run_thread_bindings r ON r.tenant_id=w.tenant_id AND r.run_id=w.run_id WHERE w.tenant_id=$1 AND r.thread_id=$2 AND w.status!='completed' LIMIT 1`,
        params,
      );
      if (active.rows.length > 0 || unsettled.rows.length > 0)
        conversationFail("project_conversation_thread_busy_conflict");
    }
  }
  #query(c: PoolClient, sql: string, values: readonly unknown[] = []) {
    let n = 0;
    const p = `${creativeProjectSchemaName(this.#schema)}.`;
    return c.query<Record<string, unknown>>(
      sql
        .replace(
          /\b(project_conversation_[a-z_]+|project_stage_run_admissions|creative_projects)\b/gu,
          `${p}$1`,
        )
        .replace(/\?/gu, () => `$${++n}`),
      [...values],
    );
  }
  async #get(c: PoolClient, sql: string, values: readonly unknown[] = []) {
    return (await this.#query(c, sql, values)).rows[0];
  }
  async #transaction<T>(
    work: (c: PoolClient) => Promise<T>,
    current?: () => Promise<void>,
    active?: () => void,
  ): Promise<T> {
    this.#open();
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const r = await work(c);
      await current?.();
      active?.();
      this.#open();
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}
