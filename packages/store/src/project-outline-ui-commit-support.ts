import {
  projectOutlineUiMutationCommand,
  type ActorContext,
  type CreativeProjectCommitAuthority,
  type CreativeProjectMutationReceipt,
  type ProjectStructuredOutlineMutationKind,
} from "@crewon/application";
import {
  changeProjectOutlineDocument,
  extensionCanonicalJson,
  type StoredProjectTextArtifactRevision,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import type { StructuredTextPrepared } from "./project-structured-outline-store-support.ts";

export function projectOutlineUiCommitQualification(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectStructuredOutlineMutationKind,
  receipt: CreativeProjectMutationReceipt,
) {
  const transaction = authority?.outlineUiTransaction;
  if (!transaction) return undefined;
  const expected = projectOutlineUiMutationCommand(
    transaction,
    creativeStoreDigester,
  );
  if (
    extensionCanonicalJson(actor) !==
      extensionCanonicalJson(transaction.actor) ||
    kind !== expected.kind ||
    receipt.idempotencyKey !== expected.receipt.idempotencyKey ||
    receipt.requestDigest !== expected.receipt.requestDigest
  )
    denied();
  return Object.freeze({ ...transaction, command: expected.command });
}
export function assertProjectOutlineUiPrepared(
  q: ReturnType<typeof projectOutlineUiCommitQualification>,
  prepared: StructuredTextPrepared,
  base: StoredProjectTextArtifactRevision | null,
): void {
  if (!q) return;
  const command = q.command;
  if (
    prepared.project.projectId !== command.projectId ||
    prepared.expectedArtifactRevision !== command.expectedArtifactRevision
  )
    denied();
  if (prepared.kind === "select-revision") {
    if (
      !("artifactId" in command) ||
      prepared.artifact.artifactId !== command.artifactId ||
      prepared.contentRevision.contentRevision !== command.contentRevision
    )
      denied();
    return;
  }
  if (
    !("change" in command) ||
    prepared.contentRevision.brief.briefRevision !== command.briefRevision
  )
    denied();
  if (
    command.base === null
      ? base !== null
      : base === null ||
        base.schemaVersion !== "crewon.project-text-revision.v2" ||
        base.artifactId !== prepared.artifact.artifactId ||
        base.projectId !== command.projectId ||
        base.contentRevision !== command.base.contentRevision ||
        base.contentDigest !== command.base.contentDigest
  )
    denied();
  const expected = changeProjectOutlineDocument(
    base?.schemaVersion === "crewon.project-text-revision.v2"
      ? base.content
      : null,
    command.change,
  );
  if (
    extensionCanonicalJson(expected) !==
    extensionCanonicalJson(prepared.contentRevision.content)
  )
    denied();
}
function denied(): never {
  throw new Error("project_outline_ui_commit_command_mismatch");
}
