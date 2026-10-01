import {
  copyWorkItemExecutionScope,
  type WorkItemExecutionScope,
} from "@crewon/application";
import { bundledComfyRegistration } from "./comfyui-bundled-registration.ts";

export type ExtensionExecutionMode = "current" | "historical";

export function parseExtensionExecutionMode(
  input: unknown,
): ExtensionExecutionMode {
  if (input === undefined || input === "current") return "current";
  if (input === "historical") return input;
  throw new Error("extension_execution_mode_invalid");
}

/** The implementation comes from this loaded host, never a caller-supplied digest. */
export function extensionWorkItemExecutionScope(input: {
  tenantId: string;
  mode: ExtensionExecutionMode;
}): WorkItemExecutionScope {
  return copyWorkItemExecutionScope({
    tenantId: input.tenantId,
    extensionImplementationDigest:
      bundledComfyRegistration().implementationDigest,
    unboundRuns:
      parseExtensionExecutionMode(input.mode) === "current"
        ? "include"
        : "exclude",
  });
}
