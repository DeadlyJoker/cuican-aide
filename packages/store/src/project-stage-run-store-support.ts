import { assertOutlineSourceInputsCurrent } from "./project-outline-source-store-support.ts";
import {
  captureSqliteProjectFoundationDownstream,
  capturePostgresProjectFoundationDownstream,
} from "./project-foundation-downstream-guard.ts";
import {
  sqliteRequiredStageDigest,
  postgresRequiredStageDigest,
  assertStageMarker,
  sqliteThreadBindingMarker,
  postgresThreadBindingMarker,
} from "./project-conversation-markers.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type {
  CommitExtensionTurnInput,
  CommitExtensionTurnOptions,
  ProjectConversationCommitAuthority,
  PluginProjectReadScope,
} from "@crewon/application";
import {
  createProjectStageRunAdmission,
  extensionCanonicalJson,
  parseProjectStageRunAdmission,
  parseProjectTextArtifact,
  parseProjectOutlineSourceRevision,
  validateThreadState,
  type ProjectStageRunAdmission,
  type PluginTaskAdmission,
  type ThreadState,
  type ProjectOutlineSourceRevision,
} from "@crewon/domain";
import {
  creativeStoreDigester,
  decodeCreativeProject,
  decodeCreativeBrief,
} from "./creative-project-store-records.ts";
import {
  captureConversationAuthority,
  conversationFail,
  decodeConversation,
  decodeStageAdmission,
} from "./project-conversation-store-support.ts";
import {
  assertSqliteConversationSchema,
  assertPostgresConversationSchema,
} from "./project-conversation-schema.ts";
import {
  assertSqliteProjectTextUiCommit,
  assertPostgresProjectTextUiCommit,
} from "./project-text-ui-commit-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import {
  assertSqliteProjectConceptConversation,
  assertPostgresProjectConceptConversation,
  type ProjectConceptConversationTurn,
} from "./project-concept-conversation-turn.ts";

type PreparedStage = Readonly<{
  admission: ProjectStageRunAdmission;
  authority: ProjectConversationCommitAuthority;
  binding: CommitExtensionTurnInput["binding"];
  readScope?: PluginProjectReadScope;
}>;
export function captureProjectStageTurn(
  input: CommitExtensionTurnInput,
  options: CommitExtensionTurnOptions | undefined,
): Readonly<{
  stage: PreparedStage | null;
  options: CommitExtensionTurnOptions | undefined;
}> {
  const d = Object.getOwnPropertyDescriptor(input, "projectStageAdmission"),
    a =
      options === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(options, "projectStageAuthority");
  if (
    (d === undefined && "projectStageAdmission" in input) ||
    (d !== undefined && (!d.enumerable || !Object.hasOwn(d, "value")))
  )
    conversationFail("project_stage_admission_invalid");
  if (
    options !== undefined &&
    ((a === undefined && "projectStageAuthority" in options) ||
      (a !== undefined && (!a.enumerable || !Object.hasOwn(a, "value"))))
  )
    conversationFail("project_conversation_authority_required");
  const readScope =
    options === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(options, "projectStageReadScope");
  if (
    (readScope === undefined &&
      options !== undefined &&
      "projectStageReadScope" in options) ||
    (readScope !== undefined &&
      (!readScope.enumerable ||
        !Object.hasOwn(readScope, "value") ||
        readScope.value === undefined))
  )
    conversationFail("project_foundation_stage_read_scope_invalid");
  if (d?.value === undefined) {
    if (a !== undefined || readScope !== undefined)
      conversationFail("project_stage_admission_required");
    return { stage: null, options };
  }
  if (
    input.projectGeneration !== undefined ||
    input.projectQuery !== undefined ||
    input.pluginQueryAdmission !== undefined ||
    input.pluginAdmission === undefined ||
    a?.value === undefined
  )
    conversationFail("project_stage_admission_invalid");
  if (
    options === undefined ||
    Reflect.ownKeys(options).some(
      (k) =>
        k !== "projectStageAuthority" &&
        k !== "projectStageReadScope" &&
        k !== "unmeteredAuthority",
    )
  )
    conversationFail("project_conversation_authority_required");
  const admission = parseProjectStageRunAdmission(
      d.value,
      creativeStoreDigester,
    ),
    authority = captureConversationAuthority(a.value),
    task = input.pluginAdmission;
  if (
    extensionCanonicalJson(admission.actor) !==
      extensionCanonicalJson(authority.actor) ||
    extensionCanonicalJson(admission.installation) !==
      extensionCanonicalJson(authority.installation) ||
    admission.runId !== input.binding.runId ||
    admission.threadId !== input.binding.threadId ||
    admission.requestDigest !== input.receipt.requestDigest ||
    admission.idempotencyKey !== input.receipt.idempotencyKey ||
    admission.extensionBindingDigest !== input.binding.bindingDigest ||
    admission.pluginTaskAdmissionDigest !==
      creativeStoreDigester.sha256(extensionCanonicalJson(task))
  )
    conversationFail("project_stage_admission_invalid");
  const remaining = Object.create(
    Object.getPrototypeOf(options),
    Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(options)).filter(
        ([k]) => k !== "projectStageAuthority" && k !== "projectStageReadScope",
      ),
    ),
  ) as CommitExtensionTurnOptions;
  return {
    stage: Object.freeze({
      admission,
      authority,
      binding: structuredClone(input.binding),
      ...(readScope === undefined
        ? {}
        : { readScope: readScope.value as PluginProjectReadScope }),
    }),
    options: Reflect.ownKeys(remaining).length === 0 ? undefined : remaining,
  };
}
function stageQueries(p: PreparedStage, prefix: string) {
  const s = p.admission,
    scope = [s.actor.tenantId, s.actor.spaceId, s.projectId];
  return {
    binding: {
      sql: `SELECT * FROM ${prefix}project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3`,
      values: [s.actor.tenantId, s.actor.spaceId, s.bindingId],
    },
    thread: {
      sql: `SELECT * FROM ${prefix}threads WHERE tenant_id=$1 AND thread_id=$2`,
      values: [s.actor.tenantId, s.threadId],
    },
    project: {
      sql: `SELECT * FROM ${prefix}creative_projects WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3`,
      values: scope,
    },
    brief:
      s.sources.brief === null
        ? null
        : {
            sql: `SELECT b.*,p.owner_principal_id FROM ${prefix}creative_project_briefs b JOIN ${prefix}creative_projects p ON p.tenant_id=b.tenant_id AND p.space_id=b.space_id AND p.project_id=b.project_id WHERE b.tenant_id=$1 AND b.space_id=$2 AND b.project_id=$3 AND b.brief_revision=$4`,
            values: [...scope, s.sources.brief.briefRevision],
          },
    outline:
      s.sources.outline === null
        ? null
        : {
            sql: `SELECT h.record_json AS head_json,r.record_json AS revision_json FROM ${prefix}project_text_artifacts h JOIN ${prefix}project_text_revisions r ON r.tenant_id=h.tenant_id AND r.space_id=h.space_id AND r.project_id=h.project_id AND r.artifact_id=h.artifact_id WHERE h.tenant_id=$1 AND h.space_id=$2 AND h.project_id=$3 AND h.artifact_id=$4 AND r.content_revision=$5`,
            values: [
              ...scope,
              s.sources.outline.artifactId,
              s.sources.outline.contentRevision,
            ],
          },
  };
}
function json(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : v;
}
function checkStageRows(
  p: PreparedStage,
  task: PluginTaskAdmission,
  requireCurrentSources: boolean,
  rows: {
    binding: Record<string, unknown> | undefined;
    thread: Record<string, unknown> | undefined;
    project: Record<string, unknown> | undefined;
    brief: Record<string, unknown> | undefined;
    outline: Record<string, unknown> | undefined;
  },
): ProjectOutlineSourceRevision | null {
  const s = p.admission,
    b = decodeConversation(rows.binding),
    project = decodeCreativeProject(rows.project, s.actor, s.projectId);
  if (
    b === null ||
    b.state !== "active" ||
    b.revision !== s.bindingRevision ||
    b.bindingId !== s.bindingId ||
    b.threadId !== s.threadId ||
    b.workspaceId !== s.workspaceId ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(s.actor) ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(s.installation) ||
    project === null ||
    project.state !== "active"
  )
    conversationFail("project_stage_binding_conflict");
  const actual = createProjectStageRunAdmission(
    {
      actor: s.actor,
      binding: b,
      admission: task,
      extensionBinding: p.binding,
      stage: s.stage,
      sources: s.sources,
      at: s.createdAt,
    },
    creativeStoreDigester,
  );
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(s))
    conversationFail("project_stage_admission_invalid");
  const t = json(rows.thread?.state_json);
  validateThreadState(t as ThreadState);
  const thread = t as {
    tenantId: string;
    spaceId: string;
    threadId: string;
    createdByActorId: string;
    status: string;
    revision: number;
    workspaceId?: string | null;
  };
  if (
    thread.tenantId !== s.actor.tenantId ||
    thread.spaceId !== s.actor.spaceId ||
    thread.threadId !== s.threadId ||
    thread.createdByActorId !== s.actor.actorId ||
    thread.status !== "active" ||
    (thread.workspaceId ?? null) !== s.workspaceId ||
    rows.thread?.tenant_id !== thread.tenantId ||
    rows.thread?.space_id !== thread.spaceId ||
    rows.thread?.thread_id !== thread.threadId ||
    rows.thread?.created_by_actor_id !== thread.createdByActorId ||
    rows.thread?.project_conversation_binding_id !== s.bindingId ||
    rows.thread?.status !== thread.status ||
    String(rows.thread?.revision) !== String(thread.revision)
  )
    conversationFail("project_conversation_thread_conflict");
  if (s.sources.brief !== null) {
    const brief = decodeCreativeBrief(rows.brief, s.actor, s.projectId);
    if (
      brief === null ||
      brief.contentDigest !== s.sources.brief.contentDigest ||
      (requireCurrentSources &&
        project.latestBriefRevision !== brief.briefRevision)
    )
      conversationFail("project_stage_sources_stale");
  }
  if (s.sources.outline !== null) {
    if (rows.outline === undefined)
      conversationFail("project_stage_sources_stale");
    const h = parseProjectTextArtifact(json(rows.outline.head_json)),
      r = parseProjectOutlineSourceRevision(
        json(rows.outline.revision_json),
        creativeStoreDigester,
      );
    if (
      h.tenantId !== s.actor.tenantId ||
      h.spaceId !== s.actor.spaceId ||
      h.ownerPrincipalId !== s.actor.principalId ||
      h.projectId !== s.projectId ||
      h.kind !== "outline" ||
      h.artifactId !== s.sources.outline.artifactId ||
      (requireCurrentSources &&
        h.selectedContentRevision !== s.sources.outline.contentRevision) ||
      r.kind !== "outline" ||
      r.artifactId !== h.artifactId ||
      r.projectId !== s.projectId ||
      r.tenantId !== s.actor.tenantId ||
      r.spaceId !== s.actor.spaceId ||
      r.contentDigest !== s.sources.outline.contentDigest ||
      r.contentRevision !== s.sources.outline.contentRevision ||
      (s.stage.kind === "script" &&
        !r.content.episodes.some(
          (e) =>
            e.episodeId ===
            (s.stage.kind === "script" ? s.stage.episodeId : null),
        ))
    )
      conversationFail("project_stage_sources_stale");
    return r;
  }
  return null;
}
export function assertSqliteProjectStage(
  db: DatabaseSync,
  p: PreparedStage | null,
  input: CommitExtensionTurnInput,
  requireCurrentSources = true,
  concept: ProjectConceptConversationTurn | null = null,
): void {
  if (p === null) {
    const marker = sqliteThreadBindingMarker(db, {
      tenantId: input.binding.tenantId,
      spaceId: input.binding.spaceId,
      threadId: input.binding.threadId!,
    });
    if (marker !== null)
      assertSqliteProjectConceptConversation(db, {
        marker,
        operation: concept,
        input,
        newTurn: requireCurrentSources,
      });
    return;
  }
  assertSqliteConversationSchema(db);
  assertSqliteProjectTextUiCommit(db, p.authority);
  const qs = stageQueries(p, "");
  const read = (
    q: { sql: string; values: string[] | (string | number)[] } | null,
  ) =>
    q === null
      ? undefined
      : db.prepare(q.sql.replaceAll(/\$[1-5]/gu, "?")).get(...q.values);
  const outline = checkStageRows(
    p,
    input.pluginAdmission!,
    requireCurrentSources,
    {
      binding: read(qs.binding),
      thread: read(qs.thread),
      project: read(qs.project),
      brief: read(qs.brief),
      outline: read(qs.outline),
    },
  );
  if (
    requireCurrentSources &&
    outline?.schemaVersion === "crewon.project-text-revision.v2"
  )
    assertOutlineSourceInputsCurrent(
      outline,
      captureSqliteProjectFoundationDownstream(db, {
        actor: p.admission.actor,
        projectId: p.admission.projectId,
      }),
    );
}
export async function assertPostgresProjectStage(
  c: PoolClient,
  schema: string,
  p: PreparedStage | null,
  input: CommitExtensionTurnInput,
  requireCurrentSources = true,
  concept: ProjectConceptConversationTurn | null = null,
): Promise<void> {
  if (p === null) {
    const marker = await postgresThreadBindingMarker(c, schema, {
      tenantId: input.binding.tenantId,
      spaceId: input.binding.spaceId,
      threadId: input.binding.threadId!,
    });
    if (marker !== null)
      await assertPostgresProjectConceptConversation(c, schema, {
        marker,
        operation: concept,
        input,
        newTurn: requireCurrentSources,
      });
    return;
  }
  await assertPostgresConversationSchema(c, schema);
  await assertPostgresProjectTextUiCommit(c, schema, p.authority);
  await advisoryLock(
    c,
    `idempotency:${input.turn.idempotency.scope}:${input.turn.idempotency.key}`,
  );
  await advisoryLock(c, `run:${input.binding.tenantId}:${input.binding.runId}`);
  await advisoryLock(
    c,
    `thread:${input.binding.tenantId}:${input.binding.threadId}`,
  );
  const s = p.admission;
  await advisoryLock(
    c,
    JSON.stringify([
      "creative-project-project",
      schema,
      s.actor.tenantId,
      s.actor.spaceId,
      s.projectId,
    ]),
  );
  const qs = stageQueries(p, `${creativeProjectSchemaName(schema)}.`);
  const read = async (
    q: { sql: string; values: (string | number)[] } | null,
  ) =>
    q === null
      ? undefined
      : (await c.query<Record<string, unknown>>(q.sql + " FOR SHARE", q.values))
          .rows[0];
  const outline = checkStageRows(
    p,
    input.pluginAdmission!,
    requireCurrentSources,
    {
      binding: await read(qs.binding),
      thread: await read(qs.thread),
      project: await read(qs.project),
      brief: await read(qs.brief),
      outline: await read(qs.outline),
    },
  );
  if (
    requireCurrentSources &&
    outline?.schemaVersion === "crewon.project-text-revision.v2"
  )
    assertOutlineSourceInputsCurrent(
      outline,
      await capturePostgresProjectFoundationDownstream(c, schema, {
        actor: p.admission.actor,
        projectId: p.admission.projectId,
      }),
    );
}
export function assertStageReplay(
  p: PreparedStage | null,
  saved: ProjectStageRunAdmission | null,
): void {
  if (p === null && saved === null) return;
  if (
    p === null ||
    saved === null ||
    extensionCanonicalJson(p.admission) !== extensionCanonicalJson(saved)
  )
    conversationFail("project_stage_admission_conflict");
}
export const stageValues = (s: ProjectStageRunAdmission) =>
  [
    s.actor.tenantId,
    s.actor.spaceId,
    s.runId,
    s.threadId,
    s.bindingId,
    s.bindingRevision,
    JSON.stringify(s),
  ] as const;
export function loadSqliteStageIfAvailable(
  db: DatabaseSync,
  input: { tenantId: string; runId: string },
): ProjectStageRunAdmission | null {
  const required = sqliteRequiredStageDigest(db, input);
  const rows = db
    .prepare(
      "SELECT name,type FROM main.sqlite_schema WHERE name IN ('project_conversation_schema_version','project_conversation_bindings','project_conversation_receipts','project_stage_run_admissions') UNION ALL SELECT name,type FROM temp.sqlite_schema WHERE name IN ('project_conversation_schema_version','project_conversation_bindings','project_conversation_receipts','project_stage_run_admissions')",
    )
    .all();
  if (rows.length === 0) {
    assertStageMarker(required, null);
    return null;
  }
  if (rows.length !== 4 || rows.some((r) => r.type !== "table"))
    conversationFail("project_conversation_schema_incomplete");
  assertSqliteConversationSchema(db);
  const result = decodeStageAdmission(
    db
      .prepare(
        "SELECT * FROM project_stage_run_admissions WHERE tenant_id=? AND run_id=?",
      )
      .get(input.tenantId, input.runId),
  );
  assertStageMarker(required, result);
  return result;
}
export async function loadPostgresStageIfAvailable(
  c: PoolClient,
  schema: string,
  input: { tenantId: string; runId: string },
): Promise<ProjectStageRunAdmission | null> {
  const required = await postgresRequiredStageDigest(c, schema, input);
  const rows = (
    await c.query<{ relkind: string }>(
      "SELECT c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('project_conversation_schema_version','project_conversation_bindings','project_conversation_receipts','project_stage_run_admissions')",
      [schema],
    )
  ).rows;
  if (rows.length === 0) {
    assertStageMarker(required, null);
    return null;
  }
  if (rows.length !== 4 || rows.some((r) => r.relkind !== "r"))
    conversationFail("project_conversation_schema_incomplete");
  await assertPostgresConversationSchema(c, schema);
  const result = decodeStageAdmission(
    (
      await c.query<Record<string, unknown>>(
        `SELECT * FROM ${creativeProjectSchemaName(schema)}.project_stage_run_admissions WHERE tenant_id=$1 AND run_id=$2`,
        [input.tenantId, input.runId],
      )
    ).rows[0],
  );
  assertStageMarker(required, result);
  return result;
}
