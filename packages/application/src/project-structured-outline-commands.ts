import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  extensionCanonicalJson,
  parseProjectOutlineDocumentChange,
  projectTextOpaqueId,
  projectTextRecord,
  type ProjectOutlineDocumentChange,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { projectTextInput } from "./project-text-application-support.ts";

export type ProjectStructuredOutlineMutationKind =
  | "save-outline"
  | "select-revision";
type Common = Readonly<{
  projectId: string;
  expectedArtifactRevision: number;
  idempotencyKey: string;
}>;
export type SaveProjectStructuredOutlineCommand = Common &
  Readonly<{
    briefRevision: number;
    base: Readonly<{ contentRevision: number; contentDigest: string }> | null;
    change: ProjectOutlineDocumentChange;
  }>;
export type SelectProjectStructuredOutlineCommand = Common &
  Readonly<{
    artifactId: string;
    contentRevision: number;
  }>;
export type ProjectStructuredOutlineCommand =
  | SaveProjectStructuredOutlineCommand
  | SelectProjectStructuredOutlineCommand;

export function parseProjectStructuredOutlineCommand(
  kind: "save-outline",
  input: unknown,
): SaveProjectStructuredOutlineCommand;
export function parseProjectStructuredOutlineCommand(
  kind: "select-revision",
  input: unknown,
): SelectProjectStructuredOutlineCommand;
export function parseProjectStructuredOutlineCommand(
  kind: ProjectStructuredOutlineMutationKind,
  input: unknown,
): ProjectStructuredOutlineCommand;
export function parseProjectStructuredOutlineCommand(
  kind: ProjectStructuredOutlineMutationKind,
  input: unknown,
): ProjectStructuredOutlineCommand {
  return projectTextInput(() => {
    const fields = projectTextRecord(input, [
      "projectId",
      "expectedArtifactRevision",
      "idempotencyKey",
      ...(kind === "save-outline"
        ? ["briefRevision", "base", "change"]
        : ["artifactId", "contentRevision"]),
    ]);
    const idempotencyKey = creativeProjectOpaqueId(fields.idempotencyKey);
    if (idempotencyKey.includes(","))
      throw new Error("project_text_idempotency_key_invalid");
    const common = {
      projectId: projectTextOpaqueId(fields.projectId),
      idempotencyKey,
      expectedArtifactRevision: creativeProjectRevision(
        fields.expectedArtifactRevision,
        { minimum: kind === "save-outline" ? 0 : 1 },
      ),
    };
    if (kind === "select-revision")
      return Object.freeze({
        ...common,
        artifactId: projectTextOpaqueId(fields.artifactId),
        contentRevision: creativeProjectRevision(fields.contentRevision),
      });
    const change = parseProjectOutlineDocumentChange(fields.change);
    const ref =
      fields.base === null
        ? null
        : projectTextRecord(fields.base, ["contentRevision", "contentDigest"]);
    const base =
      ref === null
        ? null
        : Object.freeze({
            contentRevision: creativeProjectRevision(ref.contentRevision),
            contentDigest: creativeProjectDigest(ref.contentDigest),
          });
    if ((change.kind === "initialize") !== (base === null))
      throw new Error("project_outline_base_invalid");
    return Object.freeze({
      ...common,
      briefRevision: creativeProjectRevision(fields.briefRevision),
      base,
      change,
    });
  });
}
/** Explicit v2 receipt namespace; a v1 command or Tool cannot replay a batch with different semantics. */
export function projectStructuredOutlineCommandReceipt(
  actor: ActorContext,
  kind: ProjectStructuredOutlineMutationKind,
  command: ProjectStructuredOutlineCommand,
  digester: ContentDigester,
) {
  return Object.freeze({
    idempotencyKey: command.idempotencyKey,
    requestDigest: creativeProjectDigest(
      digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.project-structured-outline-command.v2",
          actor,
          kind,
          command,
        }),
      ),
    ),
  });
}
