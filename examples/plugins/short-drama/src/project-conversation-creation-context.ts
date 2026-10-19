import {
  resolvePluginProjectWorkspaceTarget,
  type PluginUiServices,
} from "@crewon/plugin-sdk/ui";

const creationContextAction =
  "crewon.project-workspace-target.v1.getCreationContext";
const creationContextSchema = "crewon.project-conversation-creation-context.v1";

export type ProjectConversationWorkspaceTarget =
  | Readonly<{ projectId: string; workspaceId: string }>
  | Readonly<{
      projectId: string;
      workspaceId: null;
      workspaceMode: "legacy-nullable";
    }>;

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

/** The Host advertises protocol support; only its authenticated response selects a mode. */
export function projectConversationCreationContextCapability(
  data: unknown,
): "v1" | null {
  return ownValue(
    ownValue(data, "hostPresentation"),
    "projectConversationCreationContext",
  ) === "v1"
    ? "v1"
    : null;
}

function creationContextMode(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== 2 ||
    ownValue(value, "schemaVersion") !== creationContextSchema
  )
    throw new Error("project_conversation_creation_context_invalid");
  const mode = ownValue(value, "workspaceMode");
  if (mode !== "legacy-nullable" && mode !== "plugin-owned-explicit")
    throw new Error("project_conversation_creation_context_invalid");
  return mode;
}

/** A denied read is never a legacy hint. The original workspace-target codec stays unchanged. */
export async function resolveProjectConversationWorkspace(
  services: PluginUiServices,
  input: Readonly<{ projectId: string }>,
  options: Readonly<{
    signal: AbortSignal;
    creationContext: "v1" | null;
  }>,
): Promise<ProjectConversationWorkspaceTarget> {
  options.signal.throwIfAborted();
  if (options.creationContext === "v1") {
    const response = await services.invoke(
      creationContextAction,
      {},
      {
        signal: options.signal,
      },
    );
    options.signal.throwIfAborted();
    if (creationContextMode(response) === "legacy-nullable")
      return Object.freeze({
        projectId: input.projectId,
        workspaceId: null,
        workspaceMode: "legacy-nullable",
      });
  }
  return resolvePluginProjectWorkspaceTarget(services, input, {
    signal: options.signal,
  });
}
