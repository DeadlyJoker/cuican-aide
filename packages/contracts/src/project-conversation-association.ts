import { pluginUiFields, parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import {
  parseProjectTextId,
  parseProjectTextIdempotencyKey,
} from "./project-text-control-contract.ts";
import { parsePublicProjectConversationBinding } from "./plugin-project-conversations-contract.ts";
import type { PublicProjectConversationBinding } from "./plugin-project-conversations-service.ts";

/** Optional, independent protocol. Existing conversation v1 clients stay unchanged. */
export const PROJECT_CONVERSATION_ASSOCIATION_SERVICE =
  "crewon.project-conversation-association";
export const PROJECT_CONVERSATION_ASSOCIATION_API_VERSION = "1";
/** Route malformed members to the metadata owner; never fall back to Node execution. */
export function isProjectConversationUiNamespaceAction(
  action: string,
): boolean {
  return [
    "crewon.project-conversations",
    PROJECT_CONVERSATION_ASSOCIATION_SERVICE,
    "crewon.project-workspace-target",
  ].some(
    (namespace) => action === namespace || action.startsWith(`${namespace}.`),
  );
}
export const PROJECT_CONVERSATION_ASSOCIATION_ACTIONS = {
  inspect: "crewon.project-conversation-association.v1.inspect",
  attach: "crewon.project-conversation-association.v1.attach",
} as const;
export type ProjectConversationAssociationCandidate = Readonly<{
  threadId: string;
  threadRevision: number;
  workspaceId: string | null;
}>;
export type ProjectConversationAssociationInspectInput = Readonly<{
  projectId: string;
  threadId: string;
}>;
export type ProjectConversationAssociationAttachInput =
  ProjectConversationAssociationInspectInput &
    Readonly<{
      expectedThreadRevision: number;
      workspaceId: string | null;
      idempotencyKey: string;
    }>;
export type ProjectConversationAssociationRequest =
  | Readonly<{
      action: typeof PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.inspect;
      input: ProjectConversationAssociationInspectInput;
    }>
  | Readonly<{
      action: typeof PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.attach;
      input: ProjectConversationAssociationAttachInput;
    }>;
export type ProjectConversationAssociationResponse =
  | Readonly<{ candidate: ProjectConversationAssociationCandidate | null }>
  | Readonly<{
      disposition: "committed" | "replayed";
      binding: PublicProjectConversationBinding;
    }>;
const fail = (): never => {
  throw new Error("project_conversation_association_invalid");
};
const revision = (x: unknown): number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 1 ? x : fail();
const workspace = (x: unknown): string | null =>
  x === null ? null : parseProjectTextId(x);
export function parseProjectConversationAssociationRequest(
  input: unknown,
): ProjectConversationAssociationRequest {
  const v = pluginUiFields(parsePluginUiJsonValue(input, { maxBytes: 8192 }), [
    "action",
    "input",
  ]);
  const attach = v.action === PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.attach;
  if (!attach && v.action !== PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.inspect)
    fail();
  const b = pluginUiFields(
    v.input,
    attach
      ? [
          "projectId",
          "threadId",
          "expectedThreadRevision",
          "workspaceId",
          "idempotencyKey",
        ]
      : ["projectId", "threadId"],
  );
  const common = {
    projectId: parseProjectTextId(b.projectId),
    threadId: parseProjectTextId(b.threadId),
  };
  return attach
    ? Object.freeze({
        action: PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.attach,
        input: Object.freeze({
          ...common,
          expectedThreadRevision: revision(b.expectedThreadRevision),
          workspaceId: workspace(b.workspaceId),
          idempotencyKey: parseProjectTextIdempotencyKey(b.idempotencyKey),
        }),
      })
    : Object.freeze({
        action: PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.inspect,
        input: Object.freeze(common),
      });
}
export function parseProjectConversationAssociationResponse(
  requestInput: ProjectConversationAssociationRequest,
  input: unknown,
): ProjectConversationAssociationResponse {
  const request = parseProjectConversationAssociationRequest(requestInput);
  const v = parsePluginUiJsonValue(input, { maxBytes: 8192 });
  if (request.action === PROJECT_CONVERSATION_ASSOCIATION_ACTIONS.inspect) {
    const out = pluginUiFields(v, ["candidate"]);
    if (out.candidate === null) return Object.freeze({ candidate: null });
    const c = pluginUiFields(out.candidate, [
      "threadId",
      "threadRevision",
      "workspaceId",
    ]);
    if (c.threadId !== request.input.threadId) fail();
    return Object.freeze({
      candidate: Object.freeze({
        threadId: parseProjectTextId(c.threadId),
        threadRevision: revision(c.threadRevision),
        workspaceId: workspace(c.workspaceId),
      }),
    });
  }
  const out = pluginUiFields(v, ["disposition", "binding"]);
  const binding = parsePublicProjectConversationBinding(out.binding);
  if (
    (out.disposition !== "committed" && out.disposition !== "replayed") ||
    binding.projectId !== request.input.projectId ||
    binding.threadId !== request.input.threadId ||
    binding.workspaceId !== request.input.workspaceId ||
    binding.revision !== 1 ||
    binding.state !== "active"
  )
    fail();
  return Object.freeze({
    disposition: out.disposition as "committed" | "replayed",
    binding,
  });
}
