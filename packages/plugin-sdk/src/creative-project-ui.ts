import {
  parseCreativeProjectUiActionRequest,
  parseCreativeProjectUiActionResponse,
  parsePluginUiJsonValue,
  type CreativeProjectUiAction,
  type CreativeProjectUiInputMap,
  type CreativeProjectUiResponseMap,
} from "./contracts.js";
import type { PluginCreativeProjectClient } from "./creative-project-ui.types.js";
import { fail } from "./definition-validation.js";
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

/** Creating a helper neither activates a service nor grants a plugin permission. */
export function createPluginCreativeProjectClient(
  services: PluginUiServices,
): PluginCreativeProjectClient {
  if (services === null || typeof services !== "object")
    fail("plugin_ui_invocation_service_invalid");
  const serviceInvoke = services.invoke;
  if (typeof serviceInvoke !== "function")
    fail("plugin_ui_invocation_service_invalid");
  const invokeHost = Function.prototype.bind.call(
    serviceInvoke,
    services,
  ) as PluginUiServices["invoke"];
  async function invoke<Action extends CreativeProjectUiAction>(
    action: Action,
    input: CreativeProjectUiInputMap[Action],
    options: PluginUiInvocationOptions = {},
  ): Promise<CreativeProjectUiResponseMap[Action]> {
    // Capture once: later caller mutation of options cannot change this invocation's signal.
    const signal = options.signal;
    assertNotAborted(signal);
    const request = parseCreativeProjectUiActionRequest({ action, input });
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
      // Promise.race observes late failure even when a host ignores the supplied signal.
      const pending = Promise.resolve().then(() => {
        assertNotAborted(signal);
        return invokeHost(request.action, json, signal ? { signal } : {});
      });
      const output = await Promise.race([pending, cancelled]);
      assertNotAborted(signal);
      const response = parseCreativeProjectUiActionResponse(request, output);
      assertNotAborted(signal);
      return response;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      rejectAborted = undefined;
    }
  }
  const client: PluginCreativeProjectClient = {
    listProjects: (input, options) =>
      invoke("crewon.creative-projects.v1.listProjects", input, options),
    getProject: (input, options) =>
      invoke("crewon.creative-projects.v1.getProject", input, options),
    createProject: (input, options) =>
      invoke("crewon.creative-projects.v1.createProject", input, options),
    renameProject: (input, options) =>
      invoke("crewon.creative-projects.v1.renameProject", input, options),
    setProjectState: (input, options) =>
      invoke("crewon.creative-projects.v1.setProjectState", input, options),
    appendBrief: (input, options) =>
      invoke("crewon.creative-projects.v1.appendBrief", input, options),
    getBrief: (input, options) =>
      invoke("crewon.creative-projects.v1.getBrief", input, options),
    listBriefs: (input, options) =>
      invoke("crewon.creative-projects.v1.listBriefs", input, options),
    createConcept: (input, options) =>
      invoke("crewon.creative-projects.v1.createConcept", input, options),
    getConceptAsset: (input, options) =>
      invoke("crewon.creative-projects.v1.getConceptAsset", input, options),
    listConceptAssets: (input, options) =>
      invoke("crewon.creative-projects.v1.listConceptAssets", input, options),
    appendConceptRevision: (input, options) =>
      invoke(
        "crewon.creative-projects.v1.appendConceptRevision",
        input,
        options,
      ),
    getConceptRevision: (input, options) =>
      invoke("crewon.creative-projects.v1.getConceptRevision", input, options),
    listConceptRevisions: (input, options) =>
      invoke(
        "crewon.creative-projects.v1.listConceptRevisions",
        input,
        options,
      ),
  };
  return Object.freeze(client);
}
