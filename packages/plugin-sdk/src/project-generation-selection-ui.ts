import {
  MAX_PROJECT_GENERATION_SELECTION_BYTES,
  parsePluginUiJsonValue,
  parseProjectGenerationSelectionUiActionRequest,
  parseGetConceptSelectionResponse,
  parseSelectConceptImageResponse,
  type ConceptSelectionLocator,
  type ProjectGenerationSelectionUiActionRequest,
  type ProjectGenerationSelectionUiInput,
} from "./contracts.js";
import { fail } from "./definition-validation.js";
import type { PluginProjectGenerationSelectionClient } from "./project-generation-selection-ui.types.js";
import type {
  PluginUiInvocationOptions,
  PluginUiServices,
} from "./ui-types.js";

function signalFrom(
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
function active(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw (
      signal.reason ??
      new DOMException("The operation was aborted", "AbortError")
    );
}

/** Construction only captures the host ABI; it neither probes nor installs a service. */
export function createPluginProjectGenerationSelectionClient(
  services: PluginUiServices,
): PluginProjectGenerationSelectionClient {
  if (services === null || typeof services !== "object")
    fail("plugin_ui_invocation_service_invalid");
  const own = Object.getOwnPropertyDescriptor(services, "invoke");
  if (!own?.enumerable || !("value" in own) || typeof own.value !== "function")
    fail("plugin_ui_invocation_service_invalid");
  const invoke = Function.prototype.bind.call(
    own.value,
    services,
  ) as PluginUiServices["invoke"];

  async function dispatch<T>(
    request: ProjectGenerationSelectionUiActionRequest,
    options: PluginUiInvocationOptions,
    parse: (output: unknown) => T,
  ): Promise<T> {
    const signal = signalFrom(options);
    active(signal);
    const json = parsePluginUiJsonValue(request.input, {
      maxBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES,
    });
    let rejectAborted: ((reason: unknown) => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () =>
      rejectAborted?.(
        signal?.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      active(signal);
      // Keep the physical host promise observed when logical cancellation wins.
      const pending = Promise.resolve().then(() => {
        active(signal);
        return invoke(request.action, json, signal ? { signal } : {});
      });
      const output = await Promise.race([pending, cancelled]);
      active(signal);
      const parsed = parse(output);
      active(signal);
      return parsed;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      rejectAborted = undefined;
    }
  }
  return Object.freeze({
    async getConceptSelection(
      input: ConceptSelectionLocator,
      options: PluginUiInvocationOptions = {},
    ) {
      const request = parseProjectGenerationSelectionUiActionRequest({
        action: "crewon.project-generation-selections.v1.getConceptSelection",
        input,
      });
      if (
        request.action !==
        "crewon.project-generation-selections.v1.getConceptSelection"
      )
        fail("plugin_ui_invocation_action_invalid");
      return dispatch(request, options, (output) =>
        parseGetConceptSelectionResponse(output, request.input),
      );
    },
    async selectConceptImage(
      input: ProjectGenerationSelectionUiInput,
      options: PluginUiInvocationOptions = {},
    ) {
      const request = parseProjectGenerationSelectionUiActionRequest({
        action: "crewon.project-generation-selections.v1.selectConceptImage",
        input,
      });
      if (
        request.action !==
        "crewon.project-generation-selections.v1.selectConceptImage"
      )
        fail("plugin_ui_invocation_action_invalid");
      const { idempotencyKey: _key, ...body } = request.input;
      return dispatch(request, options, (output) =>
        parseSelectConceptImageResponse(output, body),
      );
    },
  });
}
