import {
  extensionCanonicalJson,
  parseProjectAsset,
  parseProjectAssetRevision,
  parseProjectAssetReferenceRevision,
  assertProjectAssetRevisionIdentity,
  assertProjectAssetReferenceRevisionIdentity,
  projectAssetRecord,
  projectAssetDigest,
  type CreativeProject,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type {
  ProjectAssetMutationCommand,
  ProjectAssetMutationKind,
} from "./project-asset-commands.ts";
import type { ProjectAssetMutationResult } from "./project-asset-store-port.ts";

export function projectAssetMutationReceipt(
  actor: ActorContext,
  kind: ProjectAssetMutationKind,
  command: ProjectAssetMutationCommand,
  digester: ContentDigester,
) {
  return Object.freeze({
    idempotencyKey: command.idempotencyKey,
    requestDigest: projectAssetDigest(
      digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.project-asset-command.v1",
          actor,
          kind,
          command,
        }),
      ),
    ),
  });
}
export function projectAssetLimit(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 1 ||
    input > 16
  )
    throw new ApplicationError("validation", "project_asset_limit_invalid");
  return input;
}
export function projectAssetBoundMethod<
  T extends (...args: never[]) => unknown,
>(input: unknown, key: string): T {
  if (
    input === null ||
    (typeof input !== "object" && typeof input !== "function")
  )
    invalid();
  for (
    let owner: object | null = input;
    owner !== null;
    owner = Object.getPrototypeOf(owner)
  ) {
    const field = Object.getOwnPropertyDescriptor(owner, key);
    if (!field) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      invalid();
    return field.value.bind(input) as T;
  }
  return invalid();
}
export function projectAssetOwnFields(input: unknown, keys: readonly string[]) {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !field ||
      !Object.hasOwn(field, "value") ||
      !field.enumerable
    )
      invalid();
    result[key] = field.value;
  }
  if (keys.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}
export function checkedProjectAssetMutationResult(
  raw: unknown,
  actor: ActorContext,
  project: CreativeProject,
  kind: ProjectAssetMutationKind,
  command: ProjectAssetMutationCommand,
  digester: ContentDigester,
): ProjectAssetMutationResult {
  try {
    const value = projectAssetRecord(raw, [
        "kind",
        "disposition",
        "asset",
        "contentRevision",
        "referenceRevision",
      ]),
      asset = parseProjectAsset(value.asset);
    const contentRevision =
        value.contentRevision === null
          ? null
          : parseProjectAssetRevision(value.contentRevision, digester),
      referenceRevision =
        value.referenceRevision === null
          ? null
          : parseProjectAssetReferenceRevision(
              value.referenceRevision,
              digester,
            );
    if (
      value.kind !== kind ||
      (value.disposition !== "committed" && value.disposition !== "replayed") ||
      asset.tenantId !== actor.tenantId ||
      asset.spaceId !== actor.spaceId ||
      asset.ownerPrincipalId !== actor.principalId ||
      asset.projectId !== project.projectId ||
      asset.projectId !== command.projectId ||
      (command.assetId !== null && asset.assetId !== command.assetId)
    )
      invalid();
    if (contentRevision !== null)
      assertProjectAssetRevisionIdentity(asset, contentRevision);
    if (referenceRevision !== null)
      assertProjectAssetReferenceRevisionIdentity(asset, referenceRevision);
    if (kind === "save-content") {
      if (
        !("content" in command) ||
        !contentRevision ||
        referenceRevision !== null ||
        contentRevision.contentRevision !== asset.latestContentRevision ||
        contentRevision.kind !== command.kind ||
        contentRevision.brief.briefRevision !== command.briefRevision ||
        extensionCanonicalJson(contentRevision.content) !==
          extensionCanonicalJson(command.content) ||
        extensionCanonicalJson(
          contentRevision.script === null
            ? null
            : {
                artifactId: contentRevision.script.artifactId,
                contentRevision: contentRevision.script.contentRevision,
              },
        ) !== extensionCanonicalJson(command.script)
      )
        invalid();
    } else if (kind === "select-content") {
      if (
        !("contentRevision" in command) ||
        !contentRevision ||
        referenceRevision !== null ||
        contentRevision.contentRevision !== command.contentRevision ||
        asset.selectedContentRevision !== command.contentRevision
      )
        invalid();
    } else if (kind === "set-lock") {
      if (
        !("locked" in command) ||
        asset.locked !== command.locked ||
        contentRevision !== null ||
        referenceRevision !== null
      )
        invalid();
    } else if (kind === "save-reference") {
      if (
        !("assetContentRevision" in command) ||
        contentRevision !== null ||
        !referenceRevision ||
        referenceRevision.referenceRevision !== asset.latestReferenceRevision ||
        referenceRevision.assetContentRevision !==
          command.assetContentRevision ||
        referenceRevision.source.conceptAssetId !== command.conceptAssetId ||
        referenceRevision.source.selectionRevision !== command.selectionRevision
      )
        invalid();
    } else if (
      !("referenceRevision" in command) ||
      contentRevision !== null ||
      !referenceRevision ||
      asset.selectedReferenceRevision !== command.referenceRevision ||
      referenceRevision.referenceRevision !== command.referenceRevision
    )
      invalid();
    if (
      asset.revision !== command.expectedAssetRevision + 1 ||
      asset.updatedByActorId !== actor.actorId
    )
      invalid();
    return Object.freeze({
      kind,
      disposition: value.disposition,
      asset,
      contentRevision,
      referenceRevision,
    });
  } catch (cause) {
    throw new ApplicationError(
      "internal",
      "project_asset_store_result_invalid",
      { cause },
    );
  }
}
export async function projectAssetUseCase<T>(
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof ApplicationError) throw cause;
    const code =
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : cause instanceof Error
          ? cause.message
          : "project_asset_unavailable";
    const category = [
      "creative_project_scope_mismatch",
      "creative_project_owner_mismatch",
      "project_asset_owner_mismatch",
      "project_asset_commit_authority_invalid",
      "project_asset_commit_authority_sync_required",
      "project_asset_ui_qualification_denied",
      "project_asset_run_qualification_denied",
    ].includes(code)
      ? "authorization"
      : [
            "creative_project_archived",
            "project_asset_revision_conflict",
            "project_asset_locked",
            "project_asset_source_stale",
            "project_asset_reference_stale",
            "project_asset_concept_selection_changed",
            "project_asset_receipt_conflict",
            "project_asset_selection_required",
          ].includes(code)
        ? "conflict"
        : [
              "creative_project_not_found",
              "creative_project_brief_not_found",
              "project_asset_not_found",
              "project_asset_revision_not_found",
              "project_asset_reference_not_found",
              "project_asset_script_not_found",
            ].includes(code)
          ? "notFound"
          : [
                "project_asset_command_invalid",
                "project_asset_fields_invalid",
                "project_asset_identity_invalid",
                "project_asset_creation_invalid",
                "project_asset_kind_invalid",
                "project_asset_content_invalid",
                "project_asset_content_limit",
                "project_asset_lock_invalid",
                "project_asset_idempotency_key_invalid",
                "project_asset_limit_invalid",
              ].includes(code)
            ? "validation"
            : "internal";
    throw new ApplicationError(
      category,
      category === "internal" ? "project_asset_unavailable" : code,
      { cause },
    );
  }
}
function invalid(): never {
  throw new Error("project_asset_store_result_invalid");
}
