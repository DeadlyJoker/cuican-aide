import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  extensionCanonicalJson,
  parseProjectOutlineContent,
  parseProjectScriptContent,
  projectTextRecord,
  projectTextOpaqueId,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { captureCreativeProjectCommitAuthority } from "./creative-project-commit-authority.ts";
import type { CreativeProjectCommitOptions } from "./creative-project-store-port.ts";
import type { ProjectTextMutationCommand } from "./project-text-commands.ts";
import type { ProjectTextMutationKind } from "./project-text-store-port.ts";

export function projectTextInput<T>(work: () => T): T {
  try {
    return work();
  } catch (cause) {
    if (cause instanceof ApplicationError) throw cause;
    throw new ApplicationError(
      "validation",
      code(cause) || "project_text_command_invalid",
      { cause },
    );
  }
}
export function projectTextStored<T>(work: () => T): T {
  try {
    return work();
  } catch (cause) {
    throw new ApplicationError(
      "internal",
      "project_text_store_result_invalid",
      { cause },
    );
  }
}
export function projectTextInvalidStore(): never {
  throw new Error("project_text_store_result_invalid");
}
export function projectTextLimit(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 1 ||
    input > 16
  )
    throw new ApplicationError("validation", "project_text_limit_invalid");
  return input;
}
export function parseProjectTextMutationCommand(
  kind: ProjectTextMutationKind,
  input: unknown,
): ProjectTextMutationCommand {
  return projectTextInput(() => {
    const fields = ["projectId", "expectedArtifactRevision", "idempotencyKey"];
    if (kind === "save-outline" || kind === "save-script")
      fields.push("briefRevision", "content");
    else fields.push("artifactId");
    if (kind === "save-script") fields.push("episodeId", "outline");
    if (kind === "select-revision") fields.push("contentRevision");
    if (kind === "set-lock") fields.push("locked");
    const value = projectTextRecord(input, fields);
    const idempotencyKey = creativeProjectOpaqueId(value.idempotencyKey);
    if (idempotencyKey.includes(","))
      throw new Error("project_text_idempotency_key_invalid");
    const common = {
      projectId: projectTextOpaqueId(value.projectId),
      expectedArtifactRevision: creativeProjectRevision(
        value.expectedArtifactRevision,
        { minimum: kind === "save-outline" || kind === "save-script" ? 0 : 1 },
      ),
      idempotencyKey,
    };
    if (kind === "save-outline")
      return Object.freeze({
        ...common,
        briefRevision: creativeProjectRevision(value.briefRevision),
        content: parseProjectOutlineContent(value.content),
      });
    if (kind === "save-script") {
      const ref =
        value.outline === null
          ? null
          : projectTextRecord(value.outline, ["artifactId", "contentRevision"]);
      return Object.freeze({
        ...common,
        briefRevision: creativeProjectRevision(value.briefRevision),
        episodeId: projectTextOpaqueId(value.episodeId),
        outline:
          ref === null
            ? null
            : Object.freeze({
                artifactId: projectTextOpaqueId(ref.artifactId),
                contentRevision: creativeProjectRevision(ref.contentRevision),
              }),
        content: parseProjectScriptContent(value.content),
      });
    }
    const artifactId = projectTextOpaqueId(value.artifactId);
    if (kind === "select-revision")
      return Object.freeze({
        ...common,
        artifactId,
        contentRevision: creativeProjectRevision(value.contentRevision),
      });
    if (typeof value.locked !== "boolean")
      throw new Error("project_text_lock_invalid");
    return Object.freeze({ ...common, artifactId, locked: value.locked });
  });
}
export function projectTextMutationReceipt(
  actor: ActorContext,
  kind: ProjectTextMutationKind,
  command: ProjectTextMutationCommand,
  digester: ContentDigester,
) {
  return Object.freeze({
    idempotencyKey: command.idempotencyKey,
    requestDigest: creativeProjectDigest(
      digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.project-text-command.v1",
          actor,
          kind,
          command,
        }),
      ),
    ),
  });
}
/** The existing v1 UI qualification names six different actions and cannot authorize text writes. */
export function captureProjectTextCommitAuthority(
  options: CreativeProjectCommitOptions | undefined,
) {
  if (
    options !== undefined &&
    options !== null &&
    typeof options === "object"
  ) {
    const field = Object.getOwnPropertyDescriptor(options, "authority");
    if (
      field !== undefined &&
      Object.hasOwn(field, "value") &&
      field.value !== null &&
      typeof field.value === "object"
    ) {
      const transaction = Object.getOwnPropertyDescriptor(
        field.value,
        "transaction",
      );
      if (
        transaction !== undefined &&
        (!Object.hasOwn(transaction, "value") ||
          transaction.value !== undefined)
      )
        throw new ApplicationError(
          "authorization",
          "project_text_transaction_authority_unsupported",
        );
    }
  }
  const authority = captureCreativeProjectCommitAuthority(options, {
    allowTextUiTransaction: true,
    allowPlanTransaction: true,
  });
  if (authority?.transaction !== undefined)
    throw new ApplicationError(
      "authorization",
      "project_text_transaction_authority_unsupported",
    );
  return authority;
}
export async function projectTextUseCase<T>(
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof ApplicationError) throw cause;
    const value = code(cause);
    const category = [
      "creative_project_owner_mismatch",
      "creative_project_scope_mismatch",
    ].includes(value)
      ? "authorization"
      : [
            "creative_project_not_found",
            "creative_project_brief_not_found",
            "project_text_artifact_not_found",
            "project_text_revision_not_found",
          ].includes(value)
        ? "notFound"
        : [
              "creative_project_archived",
              "creative_project_revision_exhausted",
              "project_text_revision_conflict",
              "project_text_idempotency_conflict",
              "project_text_locked",
              "project_text_selection_required",
              "project_text_dependencies_stale",
              "project_text_outline_reference_invalid",
              "project_text_brief_reference_invalid",
              "project_text_protocol_upgrade_required",
              "project_outline_inputs_stale",
            ].includes(value)
          ? "conflict"
          : "internal";
    throw new ApplicationError(
      category,
      category === "internal" ? "project_text_service_unavailable" : value,
      { cause },
    );
  }
}
function code(input: unknown): string {
  if (!(input instanceof Error)) return "";
  const ownCode = Object.getOwnPropertyDescriptor(input, "code");
  if (
    ownCode !== undefined &&
    Object.hasOwn(ownCode, "value") &&
    typeof ownCode.value === "string"
  )
    return ownCode.value;
  const message = Object.getOwnPropertyDescriptor(input, "message");
  return message !== undefined &&
    Object.hasOwn(message, "value") &&
    typeof message.value === "string"
    ? message.value
    : "";
}
