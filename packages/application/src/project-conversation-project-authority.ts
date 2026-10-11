import { authorizeConversationProject } from "./project-conversation-project-reader.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";

/** Retain the original pin and callbacks; check independent project write policy after the final original Host await. */
export function ownedConversationProjectWriteAuthority(
  input: Readonly<{
    authority: ProjectConversationCommitAuthority;
    projectId: string;
    authorization: CreativeProjectAuthorizationPort;
  }>,
): ProjectConversationCommitAuthority {
  const q = input.authority;
  const check = async (original: () => Promise<void>) => {
    q.assertActive();
    await original();
    await authorizeConversationProject({
      ...input,
      action: "creativeProject:write",
    });
    q.assertActive();
  };
  return Object.freeze({
    ...q,
    assertCurrent: () => check(q.assertCurrent),
    assertTransactionCurrent: () => check(q.assertTransactionCurrent),
  });
}
