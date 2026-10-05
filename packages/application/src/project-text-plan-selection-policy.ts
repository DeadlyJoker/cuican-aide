import { extensionCanonicalJson } from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import { parseProjectTextMutationCommand } from "./project-text-application-support.ts";
import type { ProjectTextMutationKind } from "./project-text-store-port.ts";
export function assertProjectTextPlanSelectionCommand(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectTextMutationKind,
  command: unknown,
): void {
  if (authority?.planTransaction === undefined) return;
  const q = authority.planTransaction;
  if (
    kind !== "select-revision" ||
    extensionCanonicalJson(actor) !==
      extensionCanonicalJson(q.authority.actor) ||
    extensionCanonicalJson(command) !==
      extensionCanonicalJson(
        parseProjectTextMutationCommand("select-revision", q.input),
      )
  )
    throw new Error("project_text_plan_selection_command_mismatch");
}
export function bindProjectTextPlanSelectionPolicy(
  authority: CreativeProjectCommitAuthority | undefined,
  assertPolicy: () => Promise<void>,
): CreativeProjectCommitAuthority | undefined {
  if (authority?.planTransaction === undefined) return authority;
  const q = authority.planTransaction;
  return Object.freeze({
    ...authority,
    planTransaction: Object.freeze({
      ...q,
      assertCurrent: async () => {
        await assertPolicy();
        await q.assertCurrent();
      },
    }),
  });
}
