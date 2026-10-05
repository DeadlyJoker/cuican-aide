import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type {
  ProjectTextPlanCommitAuthority,
  ProjectTextPlanLocator,
} from "./project-text-plan-store-port.ts";
export type ProjectTextPlanContinuationAuthority = Readonly<{
  plan: ProjectTextPlanCommitAuthority;
  conversation: ProjectConversationCommitAuthority;
  /** Real current Node action declaration/execution authority is issued only when a ready step is admitted. */
  prepareExecution(): Promise<ProjectConversationCommitAuthority>;
}>;
/** Issued by the actual current Control/deployment owner, never reconstructed from saved actor data. */
export interface ProjectTextPlanContinuationPort {
  run<T>(
    locator: ProjectTextPlanLocator,
    signal: AbortSignal,
    work: (authority: ProjectTextPlanContinuationAuthority) => Promise<T>,
  ): Promise<T>;
}
