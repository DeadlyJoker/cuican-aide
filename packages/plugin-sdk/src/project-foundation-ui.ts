import {
  MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  projectFoundationUiCodec,
  type ProjectFoundationUiInputMap,
  type ProjectFoundationUiMethod,
  type ProjectFoundationUiResponseMap,
} from "../../contracts/src/project-foundation.ts";
import { parsePluginUiJsonValue } from "../../contracts/src/plugin-ui-json.ts";
import { fail } from "./definition-validation.js";
import type {
  PluginProjectFoundationClient,
  PluginProjectFoundationUiInvocationOptions,
  PluginProjectFoundationUiServices,
} from "./project-foundation-ui.types.js";

// Only portable foundation contracts are copied into this independent published entry.
export * from "../../contracts/src/project-foundation.ts";
export type {
  PluginProjectFoundationClient,
  PluginProjectFoundationUiInvocationOptions,
  PluginProjectFoundationUiServices,
  PluginProjectFoundationUiSignal,
} from "./project-foundation-ui.types.js";

const nativeAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)!.get!;
function signalFrom(
  options: PluginProjectFoundationUiInvocationOptions,
): AbortSignal | undefined {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    fail("plugin_ui_invocation_options_invalid");
  const keys = Reflect.ownKeys(options);
  if (keys.length > 1 || keys.some((key) => key !== "signal"))
    fail("plugin_ui_invocation_options_invalid");
  if (keys.length === 0) return undefined;
  const own = Object.getOwnPropertyDescriptor(options, "signal");
  if (!own?.enumerable || !("value" in own))
    fail("plugin_ui_invocation_options_invalid");
  if (own.value === undefined) return undefined;
  try {
    nativeAborted.call(own.value);
  } catch {
    fail("plugin_ui_invocation_options_invalid");
  }
  return own.value as AbortSignal;
}
function active(signal: AbortSignal | undefined): void {
  if (signal !== undefined && nativeAborted.call(signal))
    throw (
      signal.reason ??
      new DOMException("The operation was aborted", "AbortError")
    );
}

/** Captures existing services.invoke. This does not register, activate or probe a Host service. */
export function createPluginProjectFoundationClient(
  services: PluginProjectFoundationUiServices,
): PluginProjectFoundationClient {
  if (
    services === null ||
    typeof services !== "object" ||
    Array.isArray(services)
  )
    fail("plugin_ui_invocation_service_invalid");
  const own = Object.getOwnPropertyDescriptor(services, "invoke");
  if (!own?.enumerable || !("value" in own) || typeof own.value !== "function")
    fail("plugin_ui_invocation_service_invalid");
  const invokeHost = Function.prototype.bind.call(
    own.value,
    services,
  ) as PluginProjectFoundationUiServices["invoke"];
  async function invoke<Method extends ProjectFoundationUiMethod>(
    method: Method,
    input: ProjectFoundationUiInputMap[Method],
    options: PluginProjectFoundationUiInvocationOptions = {},
  ): Promise<ProjectFoundationUiResponseMap[Method]> {
    const signal = signalFrom(options);
    active(signal);
    const request = projectFoundationUiCodec.parseRequest({
      action: PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method],
      input,
    });
    const json = parsePluginUiJsonValue(request.input, {
      maxBytes: MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES,
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
      const pending = Promise.resolve().then(() => {
        active(signal);
        return invokeHost(request.action, json, signal ? { signal } : {});
      });
      // Cancellation observes late physical completion without retrying or inventing a receipt.
      const output = await Promise.race([pending, cancelled]);
      active(signal);
      const parsed = projectFoundationUiCodec.parseResponse(output, request);
      active(signal);
      return parsed as ProjectFoundationUiResponseMap[Method];
    } finally {
      signal?.removeEventListener("abort", onAbort);
      rejectAborted = undefined;
    }
  }
  const client: PluginProjectFoundationClient = {
    createProject: (input, options) => invoke("createProject", input, options),
    getFoundation: (input, options) => invoke("getFoundation", input, options),
    updateParameters: (input, options) =>
      invoke("updateParameters", input, options),
    appendSource: (input, options) => invoke("appendSource", input, options),
    getSource: (input, options) => invoke("getSource", input, options),
    readSourcePage: (input, options) =>
      invoke("readSourcePage", input, options),
    listSourceChapters: (input, options) =>
      invoke("listSourceChapters", input, options),
    saveProposal: (input, options) => invoke("saveProposal", input, options),
    confirmProposal: (input, options) =>
      invoke("confirmProposal", input, options),
    chooseCreativeStartMode: (input, options) =>
      invoke("chooseCreativeStartMode", input, options),
    getProposal: (input, options) => invoke("getProposal", input, options),
    listProposals: (input, options) => invoke("listProposals", input, options),
  };
  return Object.freeze(client);
}
