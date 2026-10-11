import type { ProjectConversationNativeProvisioning } from "./project-conversation-native-provisioning.ts";

export type DesktopProjectWorkspaceObserver =
  ProjectConversationNativeProvisioning["observe"];

/** Private process composition: capture without invoking accessors or enabling legacy projects. */
export function captureDesktopProjectWorkspaceObserver(
  input: object,
  field: "desktopNativeProjectWorkspaceObserver" | "nativeWorkspaceObserver",
  ownership: "plugin-project-v1" | undefined,
): DesktopProjectWorkspaceObserver | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, field);
  if (
    (descriptor === undefined && field in input) ||
    (descriptor !== undefined &&
      (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")))
  )
    throw new Error("project_conversation_native_provisioning_invalid");
  const observer: unknown = descriptor?.value;
  if (observer === undefined) return undefined;
  if (ownership !== "plugin-project-v1" || typeof observer !== "function")
    throw new Error("project_conversation_native_provisioning_invalid");
  return observer as DesktopProjectWorkspaceObserver;
}
