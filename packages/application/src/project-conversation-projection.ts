import {
  parseProjectConversationBinding,
  type ProjectConversationBinding,
} from "@crewon/domain";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";
import type { ContentDigester } from "./application-runtime-ports.ts";
export function projectConversationPublicBinding(
  raw: ProjectConversationBinding,
  digester: ContentDigester,
): PublicProjectConversationBinding {
  const b = parseProjectConversationBinding(raw, digester),
    i = b.currentInstallation;
  return {
    bindingId: b.bindingId,
    projectId: b.projectId,
    threadId: b.threadId,
    workspaceId: b.workspaceId,
    revision: b.revision,
    state: b.state,
    source: {
      pluginId: i.pluginId,
      publisherId: i.publisherId,
      version: i.version,
      packageDigest: i.packageDigest,
      selectionRevision: i.selectionRevision,
    },
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}
