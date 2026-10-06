import {
  MEDIA_GENERATION_ACTION,
  assertProjectMediaOperationIdentity,
  createProjectMediaOperationLink,
  materialPreparationFields,
  mediaInputSame,
  mediaOperationFail as fail,
  parseProjectMediaGenerationLink,
  parseProjectMediaOperationLink,
  type ExternalOperation,
  type ExternalOperationScope,
  type ProjectMediaGenerationLink,
  type ProjectMediaOperationLink,
  type ProjectMediaOperationState,
} from "@crewon/application";
import {
  parsePluginTaskAdmission,
  projectAssetId,
  projectAssetDigest,
  type RunState,
} from "@crewon/domain";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import {
  assetQuery,
  type AssetDialect,
  type AssetRows,
  type AssetSql,
} from "./project-asset-store-support.ts";
import { mediaGenerationLinkValues } from "./project-media-generation-turn.ts";
import { parseExternalOperation } from "./external-operation-record.ts";

export type MediaOperationPlan<T> = Generator<
  AssetSql | Readonly<{ mediaOperationSchema: true }>,
  T,
  AssetRows
>;
const raw = (v: unknown): unknown =>
  typeof v === "string" ? JSON.parse(v) : v;
const generationColumns = [
  "tenant_id",
  "space_id",
  "project_id",
  "media_input_id",
  "input_revision",
  "media_input_digest",
  "principal_id",
  "actor_id",
  "execution_id",
  "plugin_id",
  "run_id",
  "receipt_kind",
  "idempotency_key",
  "request_digest",
  "content_digest",
];
const operationColumns = [
  "tenant_id",
  "run_id",
  "space_id",
  "project_id",
  "execution_id",
  "generation_digest",
  "binding_digest",
  "operation_id",
  "tool_execution_id",
  "idempotency_key",
  "action_digest",
  "request_digest",
  "correlation_id",
  "created_at",
  "content_digest",
];
export function mediaOperationValues(
  link: ProjectMediaOperationLink,
): readonly string[] {
  const r = link.reservation;
  return [
    link.tenantId,
    link.runId,
    link.spaceId,
    link.projectId,
    link.executionId,
    link.generationDigest,
    r.bindingDigest,
    r.operationId,
    r.executionId,
    r.idempotencyKey,
    r.actionDigest,
    r.requestDigest,
    r.correlationId,
    r.createdAt,
    link.contentDigest,
  ];
}
function indexed(
  row: Record<string, unknown>,
  columns: readonly string[],
  values: readonly (string | number)[],
) {
  if (columns.some((key, i) => String(row[key]) !== String(values[i])))
    fail("history_invalid");
}
/** Read immutable original admissions only. Never takes a project lock under the account/Run locks. */
function* generation(
  d: AssetDialect,
  scope: ExternalOperationScope,
  enabled: boolean,
): MediaOperationPlan<ProjectMediaGenerationLink | null> {
  // A previously opted-in owner must never fall back after its schema is lost.
  if (enabled) yield { mediaOperationSchema: true };
  const names = [
    "plugin_task_admissions",
    "project_media_generation_links",
    "project_media_operations",
  ];
  const catalog = yield* assetQuery(
    d,
    d.postgres
      ? "SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('plugin_task_admissions','project_media_generation_links','project_media_operations')"
      : "SELECT name,type AS kind,'main' AS source FROM main.sqlite_schema WHERE name IN ('plugin_task_admissions','project_media_generation_links','project_media_operations') UNION ALL SELECT name,type AS kind,'temp' AS source FROM temp.sqlite_schema WHERE name IN ('plugin_task_admissions','project_media_generation_links','project_media_operations')",
    d.postgres ? [d.schema] : [],
  );
  if (
    catalog.some(
      (r) =>
        !names.includes(String(r.name)) ||
        r.kind !== (d.postgres ? "r" : "table") ||
        (!d.postgres && r.source !== "main"),
    ) ||
    new Set(catalog.map((r) => r.name)).size !== catalog.length
  )
    fail("schema_invalid");
  const present = (name: string) => catalog.some((r) => r.name === name),
    values = [scope.tenantId, scope.runId];
  const tasks = present(names[0]!)
    ? yield* assetQuery(
        d,
        `SELECT * FROM ${d.prefix}plugin_task_admissions WHERE tenant_id=$1 AND run_id=$2`,
        values,
      )
    : [];
  const links = present(names[1]!)
    ? yield* assetQuery(
        d,
        `SELECT * FROM ${d.prefix}project_media_generation_links WHERE tenant_id=$1 AND run_id=$2`,
        values,
      )
    : [];
  const slots = present(names[2]!)
    ? yield* assetQuery(
        d,
        `SELECT 1 FROM ${d.prefix}project_media_operations WHERE tenant_id=$1 AND run_id=$2`,
        values,
      )
    : [];
  if (tasks.length > 1 || links.length > 1 || slots.length > 1)
    fail("history_invalid");
  const admission = tasks[0]
    ? parsePluginTaskAdmission(raw(tasks[0].admission_json))
    : null;
  const media =
    admission?.pluginId === "crewon.short-drama" &&
    admission.action === MEDIA_GENERATION_ACTION;
  if (!media && !links.length && !slots.length) return null;
  if (!enabled) fail("unavailable");
  if (!media || !links[0] || !tasks[0]) fail("history_invalid");
  const link = parseProjectMediaGenerationLink(raw(links[0].record_json));
  indexed(links[0], generationColumns, mediaGenerationLinkValues(link));
  indexed(
    tasks[0],
    [
      "tenant_id",
      "space_id",
      "profile_id",
      "plugin_id",
      "principal_id",
      "actor_id",
      "run_id",
      "package_digest",
      "selection_revision",
      "extension_binding_digest",
    ],
    [
      admission.tenantId,
      admission.spaceId,
      admission.profileId,
      admission.pluginId,
      admission.principalId,
      admission.actorId,
      admission.runId,
      admission.packageDigest,
      admission.selectionRevision,
      admission.extensionBindingDigest,
    ],
  );
  if (
    !mediaInputSame(admission, link.admission) ||
    link.binding.tenantId !== scope.tenantId ||
    link.binding.runId !== scope.runId ||
    link.binding.bindingDigest !== scope.bindingDigest
  )
    fail("history_invalid");
  const originals = yield* assetQuery(
    d,
    `SELECT b.binding_json,r.request_digest FROM ${d.prefix}extension_run_bindings b JOIN ${d.prefix}extension_mutation_receipts r ON r.tenant_id=b.tenant_id AND r.space_id=b.space_id AND r.plugin_id=b.plugin_id AND r.kind='task' AND r.actor_id=$3 AND r.idempotency_key=$4 WHERE b.tenant_id=$1 AND b.run_id=$2`,
    [...values, link.actor.actorId, link.receipt.idempotencyKey],
  );
  if (
    originals.length !== 1 ||
    !mediaInputSame(raw(originals[0]!.binding_json), link.binding) ||
    originals[0]!.request_digest !== link.receipt.requestDigest
  )
    fail("history_invalid");
  return link;
}
function* state(
  d: AssetDialect,
  generation: ProjectMediaGenerationLink,
): MediaOperationPlan<ProjectMediaOperationState | null> {
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_media_operations WHERE tenant_id=$1 AND run_id=$2`,
    [generation.binding.tenantId, generation.binding.runId],
  );
  if (!rows.length) {
    const orphan = yield* assetQuery(
      d,
      `SELECT 1 FROM ${d.prefix}extension_external_operations WHERE tenant_id=$1 AND run_id=$2 LIMIT 1`,
      [generation.binding.tenantId, generation.binding.runId],
    );
    if (orphan.length) fail("history_invalid");
    return null;
  }
  const row = rows[0]!,
    link = parseProjectMediaOperationLink(raw(row.record_json));
  indexed(row, operationColumns, mediaOperationValues(link));
  if (
    rows.length !== 1 ||
    link.tenantId !== generation.actor.tenantId ||
    link.runId !== generation.binding.runId ||
    link.spaceId !== generation.actor.spaceId ||
    link.projectId !== generation.reference.projectId ||
    link.executionId !== generation.reference.executionId ||
    link.generationDigest !== generation.contentDigest ||
    link.reservation.bindingDigest !== generation.binding.bindingDigest
  )
    fail("history_invalid");
  const operations = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}extension_external_operations WHERE tenant_id=$1 AND run_id=$2 LIMIT 2`,
    [link.tenantId, link.runId],
  );
  if (operations.length !== 1) fail("history_invalid");
  const saved = operations[0]!,
    operation = parseExternalOperation(raw(saved.record_json));
  indexed(
    saved,
    [
      "tenant_id",
      "run_id",
      "binding_digest",
      "operation_id",
      "idempotency_key",
      "revision",
    ],
    [
      operation.tenantId,
      operation.runId,
      operation.bindingDigest,
      operation.operationId,
      operation.idempotencyKey,
      operation.revision,
    ],
  );
  assertProjectMediaOperationIdentity(link, operation);
  return Object.freeze({ link, operation });
}
/** Native reserve guard. It is not a byte-read, installed identity or HTTP permission. */
export function* prepareProjectMediaOperationPlan(
  d: AssetDialect,
  operation: ExternalOperation,
  enabled: boolean,
): MediaOperationPlan<ProjectMediaOperationLink | null> {
  const accepted = yield* generation(d, operation, enabled);
  if (!accepted) return null;
  const runs = yield* assetQuery(
    d,
    `SELECT r.tenant_id,r.space_id,r.run_id,r.revision,r.last_sequence,r.state_json,t.thread_id FROM ${d.prefix}run_snapshots r LEFT JOIN ${d.prefix}run_thread_bindings t ON t.tenant_id=r.tenant_id AND t.run_id=r.run_id WHERE r.tenant_id=$1 AND r.run_id=$2${d.postgres ? " FOR UPDATE OF r" : ""}`,
    [operation.tenantId, operation.runId],
  );
  if (runs.length !== 1) fail("history_invalid");
  const row = runs[0]!,
    run = normalizeStoredRunState(
      raw(row.state_json) as RunState,
      "project_media_operation_history_invalid",
    ),
    binding = accepted.binding;
  indexed(
    row,
    [
      "tenant_id",
      "space_id",
      "run_id",
      "revision",
      "last_sequence",
      "thread_id",
    ],
    [
      run.tenantId,
      run.spaceId,
      run.runId,
      run.revision,
      run.lastSequence,
      run.threadId,
    ],
  );
  if (
    run.tenantId !== binding.tenantId ||
    run.spaceId !== binding.spaceId ||
    run.runId !== binding.runId ||
    run.threadId !== binding.threadId ||
    run.createdByActorId !== binding.actorId ||
    run.agentVersionId !== binding.target.agentVersionId ||
    run.authorityId !== binding.target.authorityId ||
    run.runtimeGeneration !== binding.target.runtimeGeneration ||
    run.policySnapshotId !== binding.target.policySnapshotId ||
    run.workspaceBindingId !== binding.target.workspaceBindingId ||
    !Number.isSafeInteger(run.revision) ||
    run.revision < 1 ||
    !Number.isSafeInteger(run.lastSequence) ||
    run.lastSequence < 1
  )
    fail("history_invalid");
  // Unmetered funding proves provenance, not a live Run. Only new media claims require this fence.
  if (
    run.status !== "running" ||
    run.cancelRequested !== false ||
    run.terminalAt !== null
  )
    fail("dispatch_denied");
  if (yield* state(d, accepted)) fail("occupied");
  return createProjectMediaOperationLink(accepted, operation);
}
export function* assertProjectMediaOperationReplayPlan(
  d: AssetDialect,
  operation: ExternalOperation,
  enabled: boolean,
): MediaOperationPlan<void> {
  const accepted = yield* generation(d, operation, enabled);
  if (!accepted) return;
  const saved = yield* state(d, accepted);
  if (!saved) fail("history_invalid");
  assertProjectMediaOperationIdentity(saved.link, operation);
}
export function* saveProjectMediaOperationPlan(
  d: AssetDialect,
  link: ProjectMediaOperationLink,
): MediaOperationPlan<void> {
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_media_operations (${operationColumns.join(",")},record_json) VALUES (${Array.from({ length: 16 }, (_, i) => `$${i + 1}`).join(",")})`,
    [...mediaOperationValues(link), JSON.stringify(link)],
  );
}
/** Host observation only; reads the occupied original even when the caller has a different Tool key. */
export function* loadProjectMediaOperationPlan(
  d: AssetDialect,
  input: ExternalOperationScope,
  enabled: boolean,
): MediaOperationPlan<ProjectMediaOperationState | null> {
  const r = materialPreparationFields(input, [
    "tenantId",
    "runId",
    "bindingDigest",
  ]);
  // Reuse the original scope validator without accepting caller operation IDs or authority flags.
  const scope = {
    tenantId: projectAssetId(r.tenantId),
    runId: projectAssetId(r.runId),
    bindingDigest: projectAssetDigest(r.bindingDigest),
  };
  const accepted = yield* generation(d, scope, enabled);
  if (!accepted) fail("media_required");
  return yield* state(d, accepted);
}
