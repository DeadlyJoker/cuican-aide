import {
  parsePluginUiJsonValue,
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
  type ProjectGenerationUiInput,
  type ProjectGenerationUiReceipt,
} from "./contracts.js";
import { fail } from "./definition-validation.js";
import type { PluginProjectGenerationClient } from "./project-generation-ui.types.js";
import type {
  PluginUiInvocationOptions,
  PluginUiServices,
} from "./ui-types.js";

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw (
      signal.reason ??
      new DOMException("The operation was aborted", "AbortError")
    );
}

function invocationSignal(
  options: PluginUiInvocationOptions,
): AbortSignal | undefined {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null)
  )
    fail("plugin_ui_invocation_options_invalid");
  const keys = Reflect.ownKeys(options);
  if (keys.length > 1 || keys.some((key) => key !== "signal"))
    fail("plugin_ui_invocation_options_invalid");
  if (keys.length === 0) return undefined;
  const own = Object.getOwnPropertyDescriptor(options, "signal");
  if (!own?.enumerable || !("value" in own))
    fail("plugin_ui_invocation_options_invalid");
  return own.value as AbortSignal | undefined;
}

/** Construction never probes, activates or grants the reserved host capability. */
export function createPluginProjectGenerationClient(
  services: PluginUiServices,
): PluginProjectGenerationClient {
  if (services === null || typeof services !== "object")
    fail("plugin_ui_invocation_service_invalid");
  const own = Object.getOwnPropertyDescriptor(services, "invoke");
  if (!own?.enumerable || !("value" in own) || typeof own.value !== "function")
    fail("plugin_ui_invocation_service_invalid");
  const invokeHost = Function.prototype.bind.call(
    own.value,
    services,
  ) as PluginUiServices["invoke"];

  async function generateConcept(
    input: ProjectGenerationUiInput,
    options: PluginUiInvocationOptions = {},
  ): Promise<ProjectGenerationUiReceipt> {
    const signal = invocationSignal(options);
    assertNotAborted(signal);
    // Capture the source, key and all CAS values before any asynchronous dispatch.
    const request = parseProjectGenerationUiActionRequest({
      action: "crewon.project-generations.v1.generateConcept",
      input,
    });
    const json = parsePluginUiJsonValue(request.input, { maxBytes: 24 * 1024 });
    let rejectAborted: ((reason: unknown) => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => {
      rejectAborted?.(
        signal?.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      assertNotAborted(signal);
      // The losing host promise stays observed if a logical cancellation wins.
      const pending = Promise.resolve().then(() => {
        assertNotAborted(signal);
        return invokeHost(request.action, json, signal ? { signal } : {});
      });
      const output = await Promise.race([pending, cancelled]);
      assertNotAborted(signal);
      const receipt = parseProjectGenerationUiActionResponse(request, output);
      assertNotAborted(signal);
      return receipt;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      rejectAborted = undefined;
    }
  }
  return Object.freeze({ generateConcept });
}
