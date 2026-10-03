import type {
  ActorContext,
  CommitExtensionTurnInput,
  CreativeProjectCommitAuthority,
  ExtensionMutationReceipt,
  ExtensionRunLocator,
  CommitExtensionTurnOptions,
  ProjectGenerationExecutionPublication,
} from "@crewon/application";
import { captureCreativeProjectCommitAuthority } from "@crewon/application";
import {
  assertProjectGenerationReplay,
  createProjectGenerationLink,
  parseProjectGenerationLink,
  parseProjectGenerationReference,
  parseExtensionRunBinding,
  extensionCanonicalJson,
  extensionOpaqueId,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type ProjectGenerationLink,
  type ProjectGenerationReference,
} from "@crewon/domain";
import { extensionStoreDigester } from "./extension-store-records.ts";
import {
  decodeCreativeProject,
  decodeCreativeAsset,
  decodeCreativeRevision,
  decodeCreativeBrief,
} from "./creative-project-store-records.ts";
import { captureProjectGenerationPublicationAdmission } from "./project-generation-publication-admission.ts";

export type ProjectGenerationCommitOptions = CommitExtensionTurnOptions;
export type PreparedProjectGeneration = Readonly<{
  reference: ProjectGenerationReference;
  actor: ActorContext;
  authority: CreativeProjectCommitAuthority;
  publication?: ProjectGenerationExecutionPublication;
}>;

/** Capture the immutable reference and borrowed callbacks before any lock or policy await. */
export function captureProjectGeneration(
  input: CommitExtensionTurnInput,
  admission: PluginTaskAdmission | undefined,
  enabled: boolean,
  options?: ProjectGenerationCommitOptions,
): PreparedProjectGeneration | null {
  const field = Object.getOwnPropertyDescriptor(input, "projectGeneration");
  if (
    (field === undefined && "projectGeneration" in input) ||
    (field !== undefined &&
      (!field.enumerable || !Object.hasOwn(field, "value")))
  )
    throw new Error("project_generation_reference_invalid");
  if (field?.value === undefined) {
    if (
      options !== undefined &&
      options !== null &&
      typeof options === "object" &&
      "projectGenerationPublication" in options
    )
      throw new Error("project_generation_reference_required");
    return null;
  }
  if (!enabled) throw new Error("project_generation_unavailable");
  const reference = parseProjectGenerationReference(field.value);
  if (
    admission === undefined ||
    input.creditAdmission === undefined ||
    input.creditAdmission.reservation.scope.principalId !==
      admission.principalId ||
    input.creditAdmission.reservation.scope.tenantId !== admission.tenantId
  )
    throw new Error("project_generation_paid_plugin_admission_required");
  if (
    options === undefined ||
    options === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw new Error("project_generation_authority_required");
  const keys = Reflect.ownKeys(options);
  const authorityField = Object.getOwnPropertyDescriptor(
    options,
    "projectGenerationAuthority",
  );
  const publicationField = Object.getOwnPropertyDescriptor(
    options,
    "projectGenerationPublication",
  );
  if (
    keys.length !== (publicationField === undefined ? 1 : 2) ||
    keys.some(
      (key) =>
        key !== "projectGenerationAuthority" &&
        key !== "projectGenerationPublication",
    ) ||
    authorityField === undefined ||
    !authorityField.enumerable ||
    !Object.hasOwn(authorityField, "value") ||
    authorityField.value === undefined
  )
    throw new Error("project_generation_authority_required");
  if (
    publicationField === undefined &&
    "projectGenerationPublication" in options
  )
    throw new Error("project_generation_publication_invalid");
  const authority = captureCreativeProjectCommitAuthority({
    authority: authorityField.value,
  });
  if (authority === undefined)
    throw new Error("project_generation_authority_required");
  if (
    publicationField !== undefined &&
    (!publicationField.enumerable ||
      !Object.hasOwn(publicationField, "value") ||
      publicationField.value === undefined)
  )
    throw new Error("project_generation_publication_invalid");
  const publication =
    publicationField === undefined
      ? undefined
      : captureProjectGenerationPublicationAdmission(
          publicationField.value,
          admission,
        );
  return Object.freeze({
    reference,
    authority,
    ...(publication === undefined ? {} : { publication }),
    actor: Object.freeze({
      tenantId: admission.tenantId,
      spaceId: admission.spaceId,
      principalId: admission.principalId,
      actorId: admission.actorId,
    }),
  });
}

export function assertProjectGenerationReceipt(input: {
  prepared: PreparedProjectGeneration | null;
  link: ProjectGenerationLink | null;
  binding: ExtensionRunBinding;
  receipt: ExtensionMutationReceipt;
}): void {
  if (input.prepared === null && input.link === null) return;
  if (input.prepared === null || input.link === null)
    throw new Error("project_generation_receipt_conflict");
  assertProjectGenerationReplay(
    {
      link: input.link,
      reference: input.prepared.reference,
      actor: input.prepared.actor,
      binding: input.binding,
      receipt: input.receipt,
    },
    extensionStoreDigester,
  );
}

type Rows = (
  sql: string,
  values: readonly (string | number)[],
) => Promise<readonly Record<string, unknown>[]>;
type SyncRows = (
  sql: string,
  values: readonly (string | number)[],
) => readonly Record<string, unknown>[];

function metadataQueries(
  prepared: PreparedProjectGeneration,
  prefix: string,
  pg: boolean,
) {
  const { actor, reference } = prepared;
  const args = [
    actor.tenantId,
    actor.spaceId,
    actor.principalId,
    reference.projectId,
  ];
  const markers = (n: number) => (pg ? `$${n}` : "?");
  const filter = `p.tenant_id=${markers(1)} AND p.space_id=${markers(2)} AND p.owner_principal_id=${markers(3)} AND p.project_id=${markers(4)}`;
  const child = (table: string) =>
    `SELECT c.*,p.owner_principal_id FROM ${prefix}${table} c JOIN ${prefix}creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id WHERE ${filter}`;
  return {
    args,
    project: `SELECT p.* FROM ${prefix}creative_projects p WHERE ${filter}`,
    asset: `${child("creative_concept_assets")} AND c.asset_id=${markers(5)}`,
    revision: `${child("creative_concept_revisions")} AND c.asset_id=${markers(5)} AND c.asset_revision=${markers(6)}`,
    brief: `${child("creative_project_briefs")} AND c.brief_revision=${markers(5)}`,
  };
}
function sourceLink(
  prepared: PreparedProjectGeneration,
  input: CommitExtensionTurnInput,
  source: {
    projectRow?: Record<string, unknown>;
    assetRow?: Record<string, unknown>;
    revisionRow?: Record<string, unknown>;
    briefRow?: Record<string, unknown>;
  },
) {
  const owner = {
    tenantId: prepared.actor.tenantId,
    spaceId: prepared.actor.spaceId,
    principalId: prepared.actor.principalId,
  };
  const { reference } = prepared;
  const project = decodeCreativeProject(
    source.projectRow,
    owner,
    reference.projectId,
  );
  const asset = decodeCreativeAsset(
    source.assetRow,
    owner,
    reference.projectId,
  );
  const assetRevision = decodeCreativeRevision(
    source.revisionRow,
    owner,
    reference.projectId,
    reference.assetId,
  );
  const brief = decodeCreativeBrief(
    source.briefRow,
    owner,
    reference.projectId,
  );
  if (
    project === null ||
    asset === null ||
    assetRevision === null ||
    brief === null
  )
    throw new Error("project_generation_source_not_found");
  const event = input.turn.run.events[0];
  if (event?.type !== "run.created")
    throw new Error("project_generation_run_invalid");
  return createProjectGenerationLink(
    {
      actor: prepared.actor,
      reference,
      project,
      asset,
      assetRevision,
      brief,
      binding: input.binding,
      receipt: input.receipt,
      at: event.occurredAt,
    },
    extensionStoreDigester,
  );
}
export async function preparePostgresProjectGeneration(
  prepared: PreparedProjectGeneration,
  input: CommitExtensionTurnInput,
  prefix: string,
  rows: Rows,
): Promise<ProjectGenerationLink> {
  const q = metadataQueries(prepared, prefix, true);
  const projectRow = (await rows(q.project, q.args))[0];
  const assetRow = (
    await rows(q.asset, [...q.args, prepared.reference.assetId])
  )[0];
  const revisionRow = (
    await rows(q.revision, [
      ...q.args,
      prepared.reference.assetId,
      prepared.reference.assetRevision,
    ])
  )[0];
  const revision = decodeCreativeRevision(
    revisionRow,
    {
      tenantId: prepared.actor.tenantId,
      spaceId: prepared.actor.spaceId,
      principalId: prepared.actor.principalId,
    },
    prepared.reference.projectId,
    prepared.reference.assetId,
  );
  if (revision === null) throw new Error("project_generation_source_not_found");
  const briefRow = (
    await rows(q.brief, [...q.args, revision.briefRevision])
  )[0];
  return sourceLink(prepared, input, {
    projectRow,
    assetRow,
    revisionRow,
    briefRow,
  });
}
export function prepareSqliteProjectGeneration(
  prepared: PreparedProjectGeneration,
  input: CommitExtensionTurnInput,
  rows: SyncRows,
): ProjectGenerationLink {
  const q = metadataQueries(prepared, "", false);
  const projectRow = rows(q.project, q.args)[0];
  const assetRow = rows(q.asset, [...q.args, prepared.reference.assetId])[0];
  const revisionRow = rows(q.revision, [
    ...q.args,
    prepared.reference.assetId,
    prepared.reference.assetRevision,
  ])[0];
  const revision = decodeCreativeRevision(
    revisionRow,
    {
      tenantId: prepared.actor.tenantId,
      spaceId: prepared.actor.spaceId,
      principalId: prepared.actor.principalId,
    },
    prepared.reference.projectId,
    prepared.reference.assetId,
  );
  if (revision === null) throw new Error("project_generation_source_not_found");
  const briefRow = rows(q.brief, [...q.args, revision.briefRevision])[0];
  return sourceLink(prepared, input, {
    projectRow,
    assetRow,
    revisionRow,
    briefRow,
  });
}

export function projectGenerationLocator(
  input: ExtensionRunLocator,
): [string, string, string] {
  return [
    extensionOpaqueId(input.tenantId),
    extensionOpaqueId(input.spaceId),
    extensionOpaqueId(input.runId),
  ];
}
export function projectGenerationReadSql(prefix = "", pg = false) {
  return `SELECT l.*,b.binding_json,r.request_digest AS stored_request_digest FROM ${prefix}creative_project_generation_links l LEFT JOIN ${prefix}extension_run_bindings b ON b.tenant_id=l.tenant_id AND b.run_id=l.run_id LEFT JOIN ${prefix}extension_mutation_receipts r ON r.tenant_id=l.tenant_id AND r.space_id=l.space_id AND r.plugin_id=l.plugin_id AND r.kind=l.receipt_kind AND r.actor_id=l.actor_id AND r.idempotency_key=l.idempotency_key WHERE l.tenant_id=${pg ? "$1" : "?"} AND l.space_id=${pg ? "$2" : "?"} AND l.run_id=${pg ? "$3" : "?"}`;
}
export function decodeProjectGeneration(
  row: Record<string, unknown> | undefined,
  locator: ExtensionRunLocator,
): ProjectGenerationLink | null {
  if (row === undefined) return null;
  const json =
    typeof row.record_json === "string"
      ? row.record_json
      : JSON.stringify(row.record_json);
  if (typeof json !== "string" || Buffer.byteLength(json) > 32_768)
    throw new Error("project_generation_record_invalid");
  const link = parseProjectGenerationLink(
    JSON.parse(json),
    extensionStoreDigester,
  );
  const binding = parseExtensionRunBinding(
    typeof row.binding_json === "string"
      ? JSON.parse(row.binding_json)
      : row.binding_json,
    extensionStoreDigester,
  );
  const fields = {
    tenant_id: link.tenantId,
    space_id: link.spaceId,
    project_id: link.projectId,
    owner_principal_id: link.ownerPrincipalId,
    asset_id: link.reference.assetId,
    asset_revision: link.reference.assetRevision,
    asset_content_digest: link.assetContentDigest,
    brief_revision: link.briefRevision,
    brief_content_digest: link.briefContentDigest,
    plugin_id: link.binding.pluginId,
    run_id: link.binding.runId,
    thread_id: link.binding.threadId,
    actor_id: link.receipt.actorId,
    binding_digest: link.binding.bindingDigest,
    receipt_kind: "task",
    idempotency_key: link.receipt.idempotencyKey,
    request_digest: link.receipt.requestDigest,
    content_digest: link.contentDigest,
  };
  if (
    Object.entries(fields).some(
      ([key, value]) => String(row[key]) !== String(value),
    ) ||
    link.tenantId !== locator.tenantId ||
    link.spaceId !== locator.spaceId ||
    link.binding.runId !== locator.runId ||
    extensionCanonicalJson(link.binding) !== extensionCanonicalJson(binding) ||
    row.stored_request_digest !== link.receipt.requestDigest
  )
    throw new Error("project_generation_record_identity_mismatch");
  return link;
}
export function projectGenerationValues(
  link: ProjectGenerationLink,
): (string | number)[] {
  return [
    link.tenantId,
    link.spaceId,
    link.projectId,
    link.ownerPrincipalId,
    link.reference.assetId,
    link.reference.assetRevision,
    link.assetContentDigest,
    link.briefRevision,
    link.briefContentDigest,
    link.binding.pluginId,
    link.binding.runId,
    link.binding.threadId,
    link.receipt.actorId,
    link.binding.bindingDigest,
    "task",
    link.receipt.idempotencyKey,
    link.receipt.requestDigest,
    link.contentDigest,
    JSON.stringify(link),
  ];
}
export function projectGenerationInsertSql(prefix = "", pg = false) {
  return `INSERT INTO ${prefix}creative_project_generation_links VALUES(${Array.from({ length: 19 }, (_, i) => (pg ? `$${i + 1}` : "?")).join(",")})`;
}
export function projectGenerationSlotSql(prefix = "", pg = false) {
  return `SELECT run_id FROM ${prefix}creative_project_generation_links WHERE tenant_id=${pg ? "$1" : "?"} AND space_id=${pg ? "$2" : "?"} AND project_id=${pg ? "$3" : "?"} AND asset_id=${pg ? "$4" : "?"} AND asset_revision=${pg ? "$5" : "?"}`;
}
export function projectGenerationSlotValues(link: ProjectGenerationLink) {
  return [
    link.tenantId,
    link.spaceId,
    link.projectId,
    link.reference.assetId,
    link.reference.assetRevision,
  ];
}
