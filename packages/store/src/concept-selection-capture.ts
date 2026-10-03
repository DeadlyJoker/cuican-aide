import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  captureCreativeProjectCommitAuthority,
  type ActorContext,
  type CommitProjectConceptSelectionInput,
  type ProjectConceptSelectionCommitOptions,
  type CreativeProjectOwnerScope,
  type CreativeProjectCommitAuthority,
  type ProjectConceptSelectionCommandSource,
} from "@crewon/application";
import {
  captureProjectConceptSelectionPublication,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  extensionCanonicalJson,
  operationResultId,
  operationResultIndex,
  parseProjectGenerationReference,
  validateCreativeProjectActor,
} from "@crewon/domain";
import { creativeStoreRecord } from "./creative-project-store-records.ts";
export type PreparedConceptSelection = Readonly<{
  input: CommitProjectConceptSelectionInput;
  authority: CreativeProjectCommitAuthority;
  source: ProjectConceptSelectionCommandSource;
}>;
export function selectionFields(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("concept_selection_fields_invalid");
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)!;
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !field.enumerable ||
      !Object.hasOwn(field, "value")
    )
      throw new Error("concept_selection_fields_invalid");
    fields[key] = field.value;
  }
  return fields;
}
export const jsonRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string" && Buffer.byteLength(value) > 65536)
    throw new Error("concept_selection_record_limit");
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const safe = parsePluginUiJsonValue(parsed);
  if (safe === null || typeof safe !== "object" || Array.isArray(safe))
    throw new Error("concept_selection_record_invalid");
  const record = selectionFields(safe, Object.keys(safe));
  if (Buffer.byteLength(extensionCanonicalJson(record)) > 65536)
    throw new Error("concept_selection_record_limit");
  return record;
};
export function captureConceptSelectionCommandSource(
  input: unknown,
): ProjectConceptSelectionCommandSource {
  const value = creativeStoreRecord(input);
  switch (value.kind) {
    case "authenticated-project-command":
      creativeStoreRecord(value, ["kind"]);
      return Object.freeze({ kind: value.kind });
    case "installed-plugin-ui":
      creativeStoreRecord(value, ["kind", "publication"]);
      return Object.freeze({
        kind: value.kind,
        publication: captureProjectConceptSelectionPublication(
          value.publication,
        ),
      });
    default:
      throw new Error("concept_selection_source_invalid");
  }
}
export function captureConceptSelection(
  input: CommitProjectConceptSelectionInput,
  options: ProjectConceptSelectionCommitOptions,
): PreparedConceptSelection {
  const fields = creativeStoreRecord(input, [
    "actor",
    "reference",
    "operationId",
    "expectedOperationRevision",
    "resultIndex",
    "expectedSelectionRevision",
    "receipt",
    "at",
  ]);
  const actor = validateCreativeProjectActor(fields.actor),
    r = creativeStoreRecord(fields.receipt, [
      "idempotencyKey",
      "requestDigest",
    ]),
    value = Object.freeze({
      actor,
      reference: parseProjectGenerationReference(fields.reference),
      operationId: operationResultId(fields.operationId),
      expectedOperationRevision: creativeProjectRevision(
        fields.expectedOperationRevision,
      ),
      resultIndex: operationResultIndex(fields.resultIndex),
      expectedSelectionRevision: creativeProjectRevision(
        fields.expectedSelectionRevision,
        { minimum: 0 },
      ),
      receipt: Object.freeze({
        idempotencyKey: creativeProjectOpaqueId(r.idempotencyKey),
        requestDigest: creativeProjectDigest(r.requestDigest),
      }),
      at: creativeProjectTimestamp(fields.at),
    });
  const opts = selectionFields(options, ["authority", "source"]),
    authority = captureCreativeProjectCommitAuthority({
      authority: opts.authority as CreativeProjectCommitAuthority,
    }),
    source = captureConceptSelectionCommandSource(opts.source);
  if (
    !authority ||
    authority.transaction !== undefined ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (key) =>
        source.kind === "installed-plugin-ui" &&
        actor[key] !== source.publication.sourcePin[key],
    )
  )
    throw new Error("concept_selection_authority_invalid");
  return Object.freeze({ input: value, authority, source });
}
export function captureConceptSelectionReceipt(
  input: Readonly<{
    actor: ActorContext;
    receipt: { idempotencyKey: string; requestDigest: string };
  }>,
) {
  const value = creativeStoreRecord(input, ["actor", "receipt"]),
    r = creativeStoreRecord(value.receipt, ["idempotencyKey", "requestDigest"]);
  return Object.freeze({
    actor: validateCreativeProjectActor(value.actor),
    receipt: Object.freeze({
      idempotencyKey: creativeProjectOpaqueId(r.idempotencyKey),
      requestDigest: creativeProjectDigest(r.requestDigest),
    }),
  });
}
export function captureConceptSelectionRead(
  input: Readonly<{
    owner: CreativeProjectOwnerScope;
    projectId: string;
    assetId: string;
  }>,
) {
  const value = creativeStoreRecord(input, ["owner", "projectId", "assetId"]),
    owner = creativeStoreRecord(value.owner, [
      "tenantId",
      "spaceId",
      "principalId",
    ]);
  return Object.freeze({
    owner: Object.freeze({
      tenantId: creativeProjectOpaqueId(owner.tenantId),
      spaceId: creativeProjectOpaqueId(owner.spaceId),
      principalId: creativeProjectOpaqueId(owner.principalId),
    }),
    projectId: creativeProjectOpaqueId(value.projectId),
    assetId: creativeProjectOpaqueId(value.assetId),
  });
}
