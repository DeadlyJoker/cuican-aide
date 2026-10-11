import { extensionCanonicalJson } from "@crewon/domain";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
} from "./plugin-project-read-scope.ts";
import { ApplicationError } from "./application-error.ts";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS } from "@crewon/contracts/project-conversations";

export function projectConversationReceipt(
  options: Readonly<{
    kind: string;
    input: Readonly<{ idempotencyKey: string }>;
    authority: ProjectConversationCommitAuthority;
    digester: ContentDigester;
    readScope?: PluginProjectReadScope;
  }>,
) {
  const { kind, input, authority: q, digester } = options;
  const original = legacyReceipt(kind, input, q, digester);
  if (options.readScope === undefined) return original;
  const source = qualifyPluginProjectReadScope(options.readScope);
  const expectedScope = {
    ...q.actor,
    profileId: q.installation.profileId,
    pluginId: q.installation.pluginId,
    publisherId: q.installation.publisherId,
  };
  if (
    kind !== "create" ||
    source.purpose !== "read" ||
    source.request.action !==
      PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation ||
    extensionCanonicalJson(source.scope) !==
      extensionCanonicalJson(expectedScope) ||
    extensionCanonicalJson(source.request.input) !==
      extensionCanonicalJson(input)
  )
    throw new ApplicationError(
      "authorization",
      "project_conversation_receipt_scope_mismatch",
    );
  // Stable data namespace only: current installation, write policy and original receipt digest remain independently checked.
  return {
    ...original,
    idempotencyKey: `project-conversation:scoped-v1:${digester.sha256(extensionCanonicalJson({ version: "crewon.plugin-project-conversation-receipt.v1", owner: source.scope, projectId: source.request.input.projectId, action: source.request.action, externalKey: input.idempotencyKey })).slice(7)}`,
  };
}
function legacyReceipt(
  kind: string,
  input: Readonly<{ idempotencyKey: string }>,
  q: ProjectConversationCommitAuthority,
  digester: ContentDigester,
) {
  return {
    actor: q.actor,
    idempotencyKey: `project-conversation:${digester.sha256(extensionCanonicalJson([q.actor, q.installation.profileId, input.idempotencyKey])).slice(7)}`,
    requestDigest: digester.sha256(
      extensionCanonicalJson({
        version: "crewon.project-conversation-command.v1",
        kind,
        actor: q.actor,
        installation: q.installation,
        input,
      }),
    ),
  };
}
