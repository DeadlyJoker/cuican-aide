import { createHash } from "node:crypto";
import type {
  CreativeProjectStore,
  CreativeProjectOwnerScope,
  CreativeProjectMutationKind,
  CreativeProjectMutationReceipt,
  CreativeProjectMutationResult,
  ActorContext,
} from "@crewon/application";
import {
  CreativeProjectError,
  creativeProjectOpaqueId,
  creativeProjectDigest,
  creativeProjectRevision,
  creativeProjectTimestamp,
  validateCreativeProjectActor,
  validateCreativeProject,
  validateConceptAsset,
  parseProjectBriefRevision,
  parseConceptAssetRevision,
  assertCreativeProjectOwner,
  assertCreativeProjectScope,
  extensionCanonicalJson,
  type CreativeProject,
  type ProjectBriefRevision,
  type ConceptAsset,
  type ConceptAssetRevision,
} from "@crewon/domain";

export {
  prepareCreativeMutation,
  verifyCreativeMutation,
  type PreparedCreativeMutation,
} from "./creative-project-store-mutations.ts";

export const creativeStoreDigester = Object.freeze({
  sha256(value: string): string {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
  },
});

export function creativeStoreFailure(code: string): never {
  throw new CreativeProjectError(code);
}

/** Detached bounded JSON. Inspect descriptors before visiting values or serializing. */
export function creativeStoreRecord(
  input: unknown,
  fields?: readonly string[],
): Record<string, unknown> {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 1_024 || depth > 12)
      creativeStoreFailure("creative_project_json_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      if (bytes > 65_536) creativeStoreFailure("creative_project_json_limit");
      for (const point of value) {
        const code = point.codePointAt(0)!;
        if (code >= 0xd800 && code <= 0xdfff)
          creativeStoreFailure("creative_project_json_invalid");
      }
      return value;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      creativeStoreFailure("creative_project_json_invalid");
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ancestors.has(value) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.values(descriptors).some(
        (entry) => !entry.enumerable || !Object.hasOwn(entry, "value"),
      )
    )
      creativeStoreFailure("creative_project_json_invalid");
    ancestors.add(value);
    const copied = Object.fromEntries(
      Object.entries(descriptors).map(([key, entry]) => {
        bytes += Buffer.byteLength(key);
        if (bytes > 65_536) creativeStoreFailure("creative_project_json_limit");
        return [key, visit(entry.value, depth + 1)];
      }),
    );
    ancestors.delete(value);
    return Object.freeze(copied);
  };
  const copied = visit(input, 0);
  if (copied === null || typeof copied !== "object")
    creativeStoreFailure("creative_project_object_invalid");
  const record = copied as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(record)) > 65_536)
    creativeStoreFailure("creative_project_json_limit");
  if (
    fields !== undefined &&
    Object.keys(record).sort().join("\0") !== [...fields].sort().join("\0")
  )
    creativeStoreFailure("creative_project_fields_invalid");
  return record;
}

export function creativeRecordJson(value: unknown): string {
  return extensionCanonicalJson(creativeStoreRecord(value));
}

export function creativeStoreOwner(value: unknown): CreativeProjectOwnerScope {
  const record = creativeStoreRecord(value, [
    "tenantId",
    "spaceId",
    "principalId",
  ]);
  return Object.freeze({
    tenantId: creativeProjectOpaqueId(record.tenantId),
    spaceId: creativeProjectOpaqueId(record.spaceId),
    principalId: creativeProjectOpaqueId(record.principalId),
  });
}

export function creativeOwnerValues(
  owner: CreativeProjectOwnerScope,
): [string, string, string] {
  return [owner.tenantId, owner.spaceId, owner.principalId];
}

export type CreativeMutationIdentity = Readonly<{
  actor: ActorContext;
  owner: CreativeProjectOwnerScope;
  receipt: CreativeProjectMutationReceipt;
  kind: CreativeProjectMutationKind;
}>;

export function creativeMutationKind(
  value: unknown,
): CreativeProjectMutationKind {
  if (
    value !== "create-project" &&
    value !== "rename-project" &&
    value !== "set-project-state" &&
    value !== "append-brief" &&
    value !== "create-concept" &&
    value !== "append-concept"
  )
    creativeStoreFailure("creative_project_mutation_kind_invalid");
  return value;
}

export function creativeMutationIdentity(
  input: unknown,
): CreativeMutationIdentity {
  const value = creativeStoreRecord(input, ["actor", "receipt", "kind"]);
  const actor = validateCreativeProjectActor(value.actor);
  const receipt = creativeStoreRecord(value.receipt, [
    "idempotencyKey",
    "requestDigest",
  ]);
  return Object.freeze({
    actor,
    owner: creativeStoreOwner({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      principalId: actor.principalId,
    }),
    kind: creativeMutationKind(value.kind),
    receipt: Object.freeze({
      idempotencyKey: creativeProjectOpaqueId(receipt.idempotencyKey),
      requestDigest: creativeProjectDigest(receipt.requestDigest),
    }),
  });
}

type ReadMethod = Exclude<
  keyof CreativeProjectStore,
  `commit${string}` | "loadMutationReceipt"
>;
const readFields: Record<ReadMethod, readonly string[]> = {
  loadProject: ["owner", "projectId"],
  listProjects: ["owner", "state", "after", "limit"],
  loadBrief: ["owner", "projectId", "briefRevision"],
  listBriefs: ["owner", "projectId", "afterBriefRevision", "limit"],
  loadConceptAsset: ["owner", "projectId", "assetId"],
  listConceptAssets: ["owner", "projectId", "afterAssetId", "limit"],
  loadConceptRevision: ["owner", "projectId", "assetId", "assetRevision"],
  listConceptRevisions: [
    "owner",
    "projectId",
    "assetId",
    "afterAssetRevision",
    "limit",
  ],
};

export function creativeReadInput<M extends ReadMethod>(
  method: M,
  input: Parameters<CreativeProjectStore[M]>[0],
): Parameters<CreativeProjectStore[M]>[0] {
  const value = creativeStoreRecord(input, readFields[method]);
  const checked: Record<string, unknown> = {
    ...value,
    owner: creativeStoreOwner(value.owner),
  };
  for (const name of ["projectId", "assetId"])
    if (name in value) checked[name] = creativeProjectOpaqueId(value[name]);
  for (const name of ["briefRevision", "assetRevision"])
    if (name in value) checked[name] = creativeProjectRevision(value[name]);
  for (const name of ["afterBriefRevision", "afterAssetRevision"])
    if (name in value)
      checked[name] = creativeProjectRevision(value[name], { minimum: 0 });
  if ("limit" in value) {
    const limit = creativeProjectRevision(value.limit);
    if (limit > 50) creativeStoreFailure("creative_project_limit_invalid");
    checked.limit = limit;
  }
  if (
    "state" in value &&
    value.state !== "active" &&
    value.state !== "archived" &&
    value.state !== "all"
  )
    creativeStoreFailure("creative_project_state_invalid");
  if ("after" in value && value.after !== null) {
    const after = creativeStoreRecord(value.after, ["updatedAt", "projectId"]);
    checked.after = Object.freeze({
      updatedAt: creativeProjectTimestamp(after.updatedAt),
      projectId: creativeProjectOpaqueId(after.projectId),
    });
  }
  if ("afterAssetId" in value && value.afterAssetId !== null)
    checked.afterAssetId = creativeProjectOpaqueId(value.afterAssetId);
  return Object.freeze(checked) as Parameters<CreativeProjectStore[M]>[0];
}

type Row = Record<string, unknown> | undefined | null;
function recordFromRow(
  row: Record<string, unknown>,
  field: "record_json" | "result_json",
) {
  const value = row[field];
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 65_536)
      creativeStoreFailure("creative_project_json_limit");
    return creativeStoreRecord(JSON.parse(value));
  }
  return creativeStoreRecord(value);
}

function indexedNumber(value: unknown): number {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return creativeStoreFailure("creative_project_store_index_invalid");
}

function same(actual: unknown, expected: unknown) {
  if (actual !== expected)
    creativeStoreFailure("creative_project_store_index_invalid");
}
function scopeRow(
  row: Record<string, unknown>,
  owner: CreativeProjectOwnerScope,
  record: { tenantId: string; spaceId: string; projectId: string },
  projectId?: string,
) {
  same(row.tenant_id, record.tenantId);
  same(row.space_id, record.spaceId);
  same(row.project_id, record.projectId);
  same(row.owner_principal_id, owner.principalId);
  same(record.tenantId, owner.tenantId);
  same(record.spaceId, owner.spaceId);
  if (projectId !== undefined) same(record.projectId, projectId);
}

export function decodeCreativeProject(
  row: Row,
  owner: CreativeProjectOwnerScope,
  projectId?: string,
): CreativeProject | null {
  if (row == null) return null;
  const project = validateCreativeProject(recordFromRow(row, "record_json"));
  scopeRow(row, owner, project, projectId);
  same(project.ownerPrincipalId, owner.principalId);
  same(indexedNumber(row.revision), project.revision);
  same(indexedNumber(row.latest_brief_revision), project.latestBriefRevision);
  same(row.state, project.state);
  same(row.updated_at, project.updatedAt);
  return project;
}

export function decodeCreativeBrief(
  row: Row,
  owner: CreativeProjectOwnerScope,
  projectId: string,
): ProjectBriefRevision | null {
  if (row == null) return null;
  const brief = parseProjectBriefRevision(
    recordFromRow(row, "record_json"),
    creativeStoreDigester,
  );
  scopeRow(row, owner, brief, projectId);
  same(indexedNumber(row.brief_revision), brief.briefRevision);
  same(row.content_digest, brief.contentDigest);
  return brief;
}

export function decodeCreativeAsset(
  row: Row,
  owner: CreativeProjectOwnerScope,
  projectId: string,
): ConceptAsset | null {
  if (row == null) return null;
  const asset = validateConceptAsset(recordFromRow(row, "record_json"));
  scopeRow(row, owner, asset, projectId);
  same(row.asset_id, asset.assetId);
  same(indexedNumber(row.revision), asset.revision);
  same(indexedNumber(row.latest_asset_revision), asset.latestAssetRevision);
  return asset;
}

export function decodeCreativeRevision(
  row: Row,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  assetId: string,
): ConceptAssetRevision | null {
  if (row == null) return null;
  const revision = parseConceptAssetRevision(
    recordFromRow(row, "record_json"),
    creativeStoreDigester,
  );
  scopeRow(row, owner, revision, projectId);
  same(row.asset_id, revision.assetId);
  same(revision.assetId, assetId);
  same(indexedNumber(row.asset_revision), revision.assetRevision);
  same(indexedNumber(row.brief_revision), revision.briefRevision);
  same(row.brief_content_digest, revision.briefContentDigest);
  same(row.content_digest, revision.contentDigest);
  return revision;
}

export function decodeCreativeReceipt(
  row: Row,
  identity: CreativeMutationIdentity,
): CreativeProjectMutationResult | null {
  if (row == null) return null;
  same(row.tenant_id, identity.actor.tenantId);
  same(row.space_id, identity.actor.spaceId);
  same(row.principal_id, identity.actor.principalId);
  same(row.actor_id, identity.actor.actorId);
  same(row.kind, identity.kind);
  same(row.idempotency_key, identity.receipt.idempotencyKey);
  if (row.request_digest !== identity.receipt.requestDigest)
    creativeStoreFailure("creative_project_idempotency_conflict");
  const fields = ["kind", "disposition", "project"];
  if (identity.kind === "create-project" || identity.kind === "append-brief")
    fields.push("brief");
  if (identity.kind === "create-concept" || identity.kind === "append-concept")
    fields.push("asset", "assetRevision");
  const value = creativeStoreRecord(recordFromRow(row, "result_json"), fields);
  same(value.kind, identity.kind);
  same(value.disposition, "committed");
  const project = validateCreativeProject(value.project);
  assertCreativeProjectOwner(project, identity.actor);
  same(row.project_id, project.projectId);
  const common = {
    kind: identity.kind,
    disposition: "replayed" as const,
    project,
  };
  if (identity.kind === "create-project" || identity.kind === "append-brief") {
    const brief = parseProjectBriefRevision(value.brief, creativeStoreDigester);
    assertCreativeProjectScope(project, brief);
    same(brief.briefRevision, project.latestBriefRevision);
    return Object.freeze({ ...common, kind: identity.kind, brief });
  }
  if (
    identity.kind === "create-concept" ||
    identity.kind === "append-concept"
  ) {
    const asset = validateConceptAsset(value.asset);
    const assetRevision = parseConceptAssetRevision(
      value.assetRevision,
      creativeStoreDigester,
    );
    assertCreativeProjectScope(project, asset);
    assertCreativeProjectScope(asset, assetRevision);
    same(asset.assetId, assetRevision.assetId);
    same(asset.latestAssetRevision, assetRevision.assetRevision);
    if (assetRevision.briefRevision > project.latestBriefRevision)
      creativeStoreFailure("creative_project_brief_reference_invalid");
    return Object.freeze({
      ...common,
      kind: identity.kind,
      asset,
      assetRevision,
    });
  }
  return Object.freeze({ ...common, kind: identity.kind });
}
