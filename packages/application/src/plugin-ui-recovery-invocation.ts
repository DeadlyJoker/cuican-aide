import {
  CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
  CREWON_PLUGIN_UI_RECOVERY_SERVICE,
  parsePluginUiRecoveryRequest,
} from "@crewon/contracts";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import { uiOutput, uiInput } from "./plugin-ui-application-support.ts";
import type {
  PluginUiJsonValue,
  PluginUiActionPort,
  PluginUiActionContext,
} from "./plugin-ui-ports.ts";
import type {
  PluginUiRecoveryDispatch,
  PluginUiRecoveryPort,
} from "./plugin-ui-recovery-ports.ts";

const mutations = new Set([
  "crewon.project-media-generations.v1.generate",
  "crewon.project-generations.v1.generateConcept",
  "crewon.project-generation-queries.v1.queryConceptGeneration",
  "crewon.project-generation-selections.v1.selectConceptImage",
]);

export function pluginUiDeclaresRecovery(lease: PluginUiLease): boolean {
  return lease.descriptor.requires.some(
    ({ service, apiVersion }) =>
      service === CREWON_PLUGIN_UI_RECOVERY_SERVICE &&
      apiVersion === CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
  );
}

export function pluginUiRecoveryMutation(action: string): boolean {
  return mutations.has(action);
}

export function requirePluginUiRecovery(
  lease: PluginUiLease,
  port: PluginUiRecoveryPort | undefined,
): PluginUiRecoveryPort {
  if (!pluginUiDeclaresRecovery(lease) || port === undefined)
    throw new ApplicationError("conflict", "plugin_ui_recovery_unavailable");
  return port;
}

/** Capture callback receivers without invoking getters or accepting inherited authority fields. */
export function capturePluginUiRecoveryPort(
  input: PluginUiRecoveryPort | undefined,
): PluginUiRecoveryPort | undefined {
  if (input === undefined) return undefined;
  const methods = captureMethods(input, ["get", "stage", "beginDispatch"]);
  return Object.freeze({
    get: methods.get as PluginUiRecoveryPort["get"],
    stage: methods.stage as PluginUiRecoveryPort["stage"],
    beginDispatch:
      methods.beginDispatch as PluginUiRecoveryPort["beginDispatch"],
  });
}

export function capturePluginUiRecoveryDispatch(
  input: PluginUiRecoveryDispatch,
): PluginUiRecoveryDispatch {
  const methods = captureMethods(input, ["confirmVerified", "observeFailure"]);
  return Object.freeze({
    confirmVerified:
      methods.confirmVerified as PluginUiRecoveryDispatch["confirmVerified"],
    observeFailure:
      methods.observeFailure as PluginUiRecoveryDispatch["observeFailure"],
  });
}

export function recoveryInvocationRequest(action: string, input: unknown) {
  return uiInput(() => parsePluginUiRecoveryRequest({ action, input }));
}

export async function confirmPluginUiRecovery(
  dispatch: PluginUiRecoveryDispatch,
  result: PluginUiJsonValue,
): Promise<PluginUiJsonValue> {
  const output = uiOutput(() => parsePluginUiJsonValue(result));
  try {
    await dispatch.confirmVerified(output);
  } catch {
    // The observer diagnoses failed persistence. An already verified COMMIT stays accepted.
  }
  return output;
}

export async function invokePluginUiWithRecovery(
  actions: PluginUiActionPort,
  context: PluginUiActionContext,
  dispatch: PluginUiRecoveryDispatch | undefined,
) {
  try {
    return await actions.invoke(context);
  } catch (error) {
    if (dispatch !== undefined) {
      try {
        await dispatch.observeFailure(error);
      } catch {
        // Persistence diagnostics cannot replace the original business exception.
      }
    }
    throw error;
  }
}

function captureMethods<K extends string>(
  input: unknown,
  keys: readonly K[],
): Record<K, (...arguments_: never[]) => unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid();
  const methods = {} as Record<K, (...arguments_: never[]) => unknown>;
  for (const key of keys) {
    let target: object | null = input;
    let method: PropertyDescriptor | undefined;
    for (let depth = 0; target !== null && depth < 32; depth++) {
      method = Object.getOwnPropertyDescriptor(target, key);
      if (method !== undefined) break;
      target = Object.getPrototypeOf(target);
    }
    if (
      !method ||
      !Object.hasOwn(method, "value") ||
      typeof method.value !== "function"
    )
      invalid();
    methods[key] = method.value.bind(input);
  }
  return methods;
}

function invalid(): never {
  throw new ApplicationError("internal", "plugin_ui_recovery_port_invalid");
}
