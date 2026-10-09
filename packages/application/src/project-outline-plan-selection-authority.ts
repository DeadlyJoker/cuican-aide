import { extensionCanonicalJson } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import type {
  ProjectStructuredOutlineCommand,
  ProjectStructuredOutlineMutationKind,
} from "./project-structured-outline-commands.ts";

/** A captured completed-plan selection only selects its exact outline; it never authorizes v2 edits. SQL independently rechecks the current plan, receipt and result. */
export function assertProjectOutlinePlanSelectionCommand(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectStructuredOutlineMutationKind,
  command: ProjectStructuredOutlineCommand,
): void {
  const tx = authority?.planTransaction;
  if (tx === undefined) return;
  if (
    kind !== "select-revision" ||
    tx.result.kind !== "outline" ||
    tx.step.kind !== "outline" ||
    tx.admission.kind !== "outline" ||
    extensionCanonicalJson(tx.authority.actor) !==
      extensionCanonicalJson(actor) ||
    extensionCanonicalJson(tx.input) !== extensionCanonicalJson(command)
  )
    throw new ApplicationError(
      "authorization",
      "project_outline_commit_authority_unsupported",
    );
}
