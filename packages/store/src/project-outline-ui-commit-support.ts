import { assertProjectOutlinePreparedCommand } from "./project-outline-prepared-command.ts";
import {
  projectOutlineUiMutationCommand,
  type ActorContext,
  type CreativeProjectCommitAuthority,
  type CreativeProjectMutationReceipt,
  type ProjectStructuredOutlineMutationKind,
} from "@crewon/application";
import {
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
  if (q) assertProjectOutlinePreparedCommand(q.command, prepared, base, denied);
}
function denied(): never {
  throw new Error("project_outline_ui_commit_command_mismatch");
}
