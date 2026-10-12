import {
  PROJECT_WORKSPACE_TARGET_ACTION,
  parseProjectWorkspaceTargetRequest,
  parseProjectWorkspaceTargetResponse,
  type ProjectWorkspaceTargetRequest,
  type ProjectWorkspaceTargetResponse,
} from "../../contracts/src/plugin-project-workspace-target.ts";
import { fail } from "./definition-validation.js";
import type {
  PluginUiServices,
  PluginUiInvocationOptions,
} from "./ui-types.js";

export * from "../../contracts/src/plugin-project-workspace-target.ts";
const aborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)!.get!;
/** Same mounted services.invoke ABI. No activation, ownership fields, retries or directory allocation. */
export async function resolvePluginProjectWorkspaceTarget(
  services: Pick<PluginUiServices, "invoke">,
  input: ProjectWorkspaceTargetRequest,
  options: PluginUiInvocationOptions = {},
): Promise<ProjectWorkspaceTargetResponse> {
  if (services === null || typeof services !== "object")
    fail("plugin_ui_invocation_service_invalid");
  const method = Object.getOwnPropertyDescriptor(services, "invoke");
  if (
    !method?.enumerable ||
    !Object.hasOwn(method, "value") ||
    typeof method.value !== "function"
  )
    fail("plugin_ui_invocation_service_invalid");
  if (
    options === null ||
    typeof options !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    Reflect.ownKeys(options).some((key) => key !== "signal")
  )
    fail("plugin_ui_invocation_options_invalid");
  const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
  if (
    descriptor !== undefined &&
    (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
  )
    fail("plugin_ui_invocation_options_invalid");
  const signal: AbortSignal | undefined = descriptor?.value;
  if (signal !== undefined) {
    try {
      aborted.call(signal);
    } catch {
      fail("plugin_ui_invocation_options_invalid");
    }
  }
  const active = () => {
    if (signal !== undefined && aborted.call(signal))
      throw (
        signal.reason ??
        new DOMException("The operation was aborted", "AbortError")
      );
  };
  active();
  const request = parseProjectWorkspaceTargetRequest(input);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort?.(
      signal?.reason ??
        new DOMException("The operation was aborted", "AbortError"),
    );
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    active();
    const pending = Promise.resolve().then(() => {
      active();
      return Function.prototype.call.call(
        method.value,
        services,
        PROJECT_WORKSPACE_TARGET_ACTION,
        request,
        signal === undefined ? {} : { signal },
      );
    });
    const response = await Promise.race([pending, cancelled]);
    active();
    return parseProjectWorkspaceTargetResponse(response, request);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rejectAbort = undefined;
  }
}
