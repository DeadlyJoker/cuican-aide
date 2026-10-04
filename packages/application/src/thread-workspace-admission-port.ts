import type { ActorContext } from "./authorization-port.ts";

/** Optional server-owned admission; clients cannot admit their own workspace. */
export interface ThreadWorkspaceAdmissionPort {
  admit(
    input: Readonly<{ actor: ActorContext; workspaceId: string }>,
  ): Promise<void>;
}
