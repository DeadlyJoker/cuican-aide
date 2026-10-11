import {
  ApplicationError,
  qualifyPluginProjectWorkspacePreparation,
  type PluginProjectWorkspacePreparation,
  type PluginProjectWorkspaceNativeObservation,
  type PluginProjectWorkspaceNativeRegistrationStore,
  type PluginUiActionContext,
  type ProjectConversationCommitAuthority,
  type ProjectConversationApplicationService,
} from "@crewon/application";
import {
  parseProjectConversationsActionRequest,
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
} from "@crewon/contracts/project-conversations";
export type ProjectConversationNativeProvisioning = Readonly<{
  observe(
    preparation: PluginProjectWorkspacePreparation,
  ): Promise<PluginProjectWorkspaceNativeObservation>;
  registration: PluginProjectWorkspaceNativeRegistrationStore;
}>;
/** Explicit trusted composition only. No config JSON, package declarations or UI caller can construct this dependency. */
export function captureProjectConversationNativeProvisioning(
  input: ProjectConversationNativeProvisioning | undefined,
  ownership: "plugin-project-v1" | undefined,
): ProjectConversationNativeProvisioning | undefined {
  if (input === undefined) return undefined;
  if (
    ownership !== "plugin-project-v1" ||
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 2 ||
    keys.some((k) => k !== "observe" && k !== "registration")
  )
    invalid();
  const observe = Object.getOwnPropertyDescriptor(input, "observe"),
    registration = Object.getOwnPropertyDescriptor(input, "registration");
  if (
    !observe?.enumerable ||
    !Object.hasOwn(observe, "value") ||
    typeof observe.value !== "function" ||
    !registration?.enumerable ||
    !Object.hasOwn(registration, "value")
  )
    invalid();
  return Object.freeze({
    observe: observe.value.bind(input),
    registration: Object.freeze({
      recordFromNativeObservation: method(registration.value),
    }),
  });
}
/** Original actual UI/Control authority stays live through observe, namespace registration and Thread commit. */
export async function createNativeProvisionedProjectConversation(
  input: Readonly<{
    context: PluginUiActionContext;
    authority: ProjectConversationCommitAuthority;
    service: ProjectConversationApplicationService;
    provisioning: ProjectConversationNativeProvisioning;
  }>,
) {
  const preparation = await input.service.prepareWorkspaceFromPluginUi(
    input.context,
    input.authority,
  );
  const source = qualifyPluginProjectWorkspacePreparation(preparation);
  const request = parseProjectConversationsActionRequest({
    action: input.context.action,
    input: input.context.input,
  });
  if (
    request.action !==
      PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation ||
    request.input.workspaceId !== source.expectedWorkspaceId
  )
    throw new ApplicationError(
      "authorization",
      "project_conversation_native_workspace_explicit_target_required",
    );
  await source.assertCurrent();
  const observation = await input.provisioning.observe(preparation);
  source.assertActive();
  await source.assertCurrent();
  return input.service.createConversationFromNativeObservation({
    context: input.context,
    authority: input.authority,
    observation,
    registration: input.provisioning.registration,
  });
}
function method(
  input: unknown,
): PluginProjectWorkspaceNativeRegistrationStore["recordFromNativeObservation"] {
  if (input !== null && typeof input === "object")
    for (
      let owner: object | null = input, depth = 0;
      owner !== null && depth < 16;
      owner = Object.getPrototypeOf(owner), depth++
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
  return invalid();
}
function invalid(): never {
  throw new Error("project_conversation_native_provisioning_invalid");
}
