import { PROJECT_CONVERSATIONS_METHOD_ACTIONS } from "@crewon/contracts/project-conversations";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import type { PluginProjectWorkspaceNativeRegistrationStore } from "./plugin-project-workspace-store-port.ts";
import {
  qualifyPluginProjectWorkspaceNativeObservation,
  type PluginProjectWorkspaceNativeObservation,
} from "./plugin-project-workspace-native-observation.ts";
import { conversationUiProjectReader } from "./project-conversation-ui-project-reader.ts";
import { qualifyPluginProjectReadScope } from "./plugin-project-read-scope.ts";
import { ApplicationError } from "./application-error.ts";

/** Original Host create request only. Registration and Thread commit remain separate original transactions. */
export async function prepareNativeWorkspaceConversation(
  input: Readonly<{
    context: PluginUiActionContext;
    authority: ProjectConversationCommitAuthority;
    observation: PluginProjectWorkspaceNativeObservation;
    registration: PluginProjectWorkspaceNativeRegistrationStore;
    projects: ProjectConversationApplicationDependencies["projects"];
    createdAt: string;
  }>,
) {
  const view = conversationUiProjectReader(input);
  const native = qualifyPluginProjectWorkspaceNativeObservation(
    input.observation,
  );
  const source = qualifyPluginProjectReadScope(view.scope);
  if (
    view.request.action !==
      PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation ||
    source.snapshot.fingerprint !== native.invocationFingerprint ||
    view.request.input.workspaceId !== native.expectedWorkspaceId
  )
    throw new ApplicationError(
      "authorization",
      "project_conversation_native_workspace_source_mismatch",
    );
  const register = method(input.registration);
  await native.assertCurrent();
  await register(input.observation, { createdAt: input.createdAt });
  await native.assertCurrent();
  native.assertActive();
  return Object.freeze({
    request: view.request.input,
    projects: view.projects,
    readScope: view.scope,
  });
}
function method(
  input: PluginProjectWorkspaceNativeRegistrationStore,
): PluginProjectWorkspaceNativeRegistrationStore["recordFromNativeObservation"] {
  if (input !== null && typeof input === "object") {
    let owner: object | null = input;
    for (
      let depth = 0;
      owner !== null && depth < 16;
      depth++, owner = Object.getPrototypeOf(owner)
    ) {
      const d = Object.getOwnPropertyDescriptor(
        owner,
        "recordFromNativeObservation",
      );
      if (d === undefined) continue;
      if (Object.hasOwn(d, "value") && typeof d.value === "function")
        return d.value.bind(input);
      break;
    }
  }
  throw new ApplicationError(
    "authorization",
    "project_conversation_native_workspace_registration_unavailable",
  );
}
