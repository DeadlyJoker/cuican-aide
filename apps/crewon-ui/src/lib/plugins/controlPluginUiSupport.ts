import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { PluginUiCatalogItem } from "@crewon/contracts";
import {
  abortedPluginUiOperation,
  awaitPluginUiOperation,
  PluginUiLoaderError,
  uiFailure,
} from "./pluginUiValidation";

export const PLUGIN_UI_CONTROL_DEADLINE_MS = 5_000;
export type PluginUiCurrentScope = () => void;

/** This synchronous check belongs to the host's captured client/session, never to a plugin. */
export function assertPluginUiCurrent(
  assertCurrent: PluginUiCurrentScope,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw abortedPluginUiOperation();
  const result: unknown = assertCurrent();
  if (result !== undefined) uiFailure("plugin_ui_scope_check_invalid");
  if (signal?.aborted) throw abortedPluginUiOperation();
}

/** Every request has a deadline. Open/close deliberately omit the caller's cancellation signal. */
export async function pluginUiControlRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted) throw abortedPluginUiOperation();
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PLUGIN_UI_CONTROL_DEADLINE_MS);
  try {
    const result = await awaitPluginUiOperation(
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw abortedPluginUiOperation();
        return request(controller.signal);
      }),
      controller.signal,
    );
    if (controller.signal.aborted) throw abortedPluginUiOperation();
    return result;
  } catch (error) {
    if (timedOut)
      throw new PluginUiLoaderError("plugin_ui_control_timeout", {
        cause: error,
      });
    if (parent?.aborted) throw abortedPluginUiOperation();
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

/** The entire server-issued pin is immutable: validating just a reference would permit a changed package. */
export function checkedLeaseIdentity(input: PluginUiLease): string {
  return JSON.stringify(parsePluginUiLease(input));
}

export function pluginUiCatalogIdentity(input: PluginUiCatalogItem): string {
  return JSON.stringify({
    descriptor: input.descriptor,
    publicAssets: input.publicAssets,
    selectionRevision: input.selectionRevision,
    packageDigest: input.packageDigest,
  });
}
