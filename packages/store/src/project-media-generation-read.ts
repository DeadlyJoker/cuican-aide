import {
  parseProjectMediaGenerationLink,
  mediaInputData,
  mediaInputDigest,
  mediaInputSame,
  materialPreparationFields,
  mediaGenerationFail as fail,
  type ExtensionRunLocator,
  type ProjectMediaGenerationLink,
} from "@crewon/application";
import { projectAssetId } from "@crewon/domain";
import {
  assetQuery,
  type AssetDialect,
} from "./project-asset-store-support.ts";
import {
  loadProjectMediaInputPlan,
  type ProjectMediaInputPlan,
} from "./project-media-input-plan.ts";
import { mediaGenerationLinkValues } from "./project-media-generation-turn.ts";
const raw = (v: unknown) =>
  mediaInputData(typeof v === "string" ? JSON.parse(v) : v);
const columns = [
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
/** Accepted history, never a new current material/source grant. */
export function* loadProjectMediaGenerationLinkPlan(
  d: AssetDialect,
  input: ExtensionRunLocator,
): ProjectMediaInputPlan<ProjectMediaGenerationLink | null> {
  const fields = materialPreparationFields(input, [
      "tenantId",
      "spaceId",
      "runId",
    ]),
    q = {
      tenantId: projectAssetId(fields.tenantId),
      spaceId: projectAssetId(fields.spaceId),
      runId: projectAssetId(fields.runId),
    };
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_media_generation_links WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`,
    [q.tenantId, q.spaceId, q.runId],
  );
  if (!rows.length) return null;
  const row = rows[0]!,
    link = parseProjectMediaGenerationLink(raw(row.record_json)),
    values = mediaGenerationLinkValues(link);
  if (
    rows.length !== 1 ||
    columns.some((k, i) => String(row[k]) !== String(values[i])) ||
    link.actor.tenantId !== q.tenantId ||
    link.actor.spaceId !== q.spaceId ||
    link.binding.runId !== q.runId
  )
    fail("history_invalid");
  const saved = yield* loadProjectMediaInputPlan(d, {
    actor: link.actor,
    projectId: link.reference.projectId,
    mediaInputId: link.reference.mediaInputId,
    inputRevision: link.reference.inputRevision,
  });
  if (
    !saved ||
    saved.input.contentDigest !== link.reference.mediaInputDigest ||
    saved.input.workflow.workflowId !== link.reference.workflowId
  )
    fail("history_invalid");
  const originals = yield* assetQuery(
    d,
    `SELECT b.binding_json,a.admission_json,r.request_digest FROM ${d.prefix}extension_run_bindings b JOIN ${d.prefix}plugin_task_admissions a ON a.tenant_id=b.tenant_id AND a.run_id=b.run_id JOIN ${d.prefix}extension_mutation_receipts r ON r.tenant_id=b.tenant_id AND r.space_id=b.space_id AND r.plugin_id=b.plugin_id AND r.kind='task' AND r.actor_id=$4 AND r.idempotency_key=$5 WHERE b.tenant_id=$1 AND b.space_id=$2 AND b.run_id=$3`,
    [
      q.tenantId,
      q.spaceId,
      q.runId,
      link.actor.actorId,
      link.receipt.idempotencyKey,
    ],
  );
  if (
    originals.length !== 1 ||
    !mediaInputSame(raw(originals[0]!.binding_json), link.binding) ||
    !mediaInputSame(raw(originals[0]!.admission_json), link.admission) ||
    originals[0]!.request_digest !== link.receipt.requestDigest
  )
    fail("history_invalid");
  const materials = yield* assetQuery(
    d,
    `SELECT m.*,p.content_digest,e.initial_digest AS event_initial_digest,e.record_json AS event_json FROM ${d.prefix}project_media_generation_materials m JOIN ${d.prefix}project_material_preparations p ON p.intent_id=m.intent_id JOIN ${d.prefix}project_material_preparation_events e ON e.intent_id=m.intent_id AND e.revision=m.event_revision WHERE m.tenant_id=$1 AND m.run_id=$2`,
    [q.tenantId, q.runId],
  );
  if (materials.length !== link.reference.materials.length)
    fail("history_invalid");
  for (const m of link.reference.materials) {
    const found = materials.find((row) => row.role === m.role);
    if (
      !found ||
      found.intent_id !== m.intentId ||
      found.initial_digest !== m.initialDigest ||
      found.content_digest !== m.initialDigest ||
      found.event_initial_digest !== m.initialDigest ||
      Number(found.event_revision) !== m.eventRevision ||
      found.phase !== "verified" ||
      mediaInputDigest(raw(found.event_json)) !== m.eventDigest
    )
      fail("history_invalid");
  }
  return link;
}
