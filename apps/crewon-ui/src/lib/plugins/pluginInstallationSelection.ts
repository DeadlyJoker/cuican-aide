import {
  parsePluginSelectionResponse,
  type ErrorCategory,
  type SelectPluginPackageRequest,
} from "@crewon/contracts";
import { ControlApiClientError } from "@crewon/control-client";
import { getDesktopBridge } from "../desktop/desktopBridge";
import type { DesktopPluginSelectionReply } from "../desktop/desktopBridge";
import type { PluginInstallationSettingsClient } from "./usePluginInstallationSettings";

/** Selection may have committed before Native activation failed; only a current API read can confirm its state. */
export class NativePluginSelectionOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("desktop_plugin_selection_outcome_unknown", { cause });
    this.name = "NativePluginSelectionOutcomeUnknownError";
  }
}

/** Native activation retains the same original selection command and receipt; Web keeps its authenticated API. */
export async function setPluginInstallationSelection(
  input: Readonly<{
    client: PluginInstallationSettingsClient;
    pluginId: string;
    request: SelectPluginPackageRequest;
    idempotencyKey: string;
    signal: AbortSignal;
    /** Native owns its operation deadline; this signal only withdraws the UI owner. */
    ownerSignal: AbortSignal;
  }>,
) {
  input.signal.throwIfAborted();
  const runtime = getDesktopBridge()?.runtime;
  const select = runtime?.setPluginSelection;
  if (typeof select !== "function")
    return input.client.setSelection(
      input.pluginId,
      input.request,
      input.idempotencyKey,
      { signal: input.signal },
    );
  let result: DesktopPluginSelectionReply;
  try {
    result = await select.call(runtime, {
      pluginId: input.pluginId,
      request: input.request,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (cause) {
    throw new NativePluginSelectionOutcomeUnknownError(cause);
  }
  // Main reconciles selection and business activation under its own bounded deadline.
  // A shorter HTTP deadline cannot invalidate an authenticated Native receipt.
  input.ownerSignal.throwIfAborted();
  if (getDesktopBridge()?.runtime !== runtime)
    throw new Error("desktop_plugin_selection_owner_changed");
  const reply = record(result);
  record(result, reply.ok === true ? ["ok", "value"] : ["ok", "error"]);
  if (reply.ok === false) {
    const kind = record(reply.error).kind;
    const error = record(
      reply.error,
      kind === "http"
        ? ["kind", "status", "category", "code", "message", "requestId"]
        : ["kind", "code"],
    );
    if (
      error.kind === "unknown" &&
      error.code === "desktop_native_plugin_business_activation_failed"
    )
      throw new NativePluginSelectionOutcomeUnknownError(error.code);
    if (
      error.kind !== "http" ||
      !Number.isInteger(error.status) ||
      typeof error.status !== "number" ||
      error.status < 400 ||
      error.status > 599 ||
      !categories.has(error.category as ErrorCategory)
    )
      throw new Error("desktop_plugin_selection_reply_invalid");
    const cause = new ControlApiClientError({
      status: error.status,
      category: error.category as ErrorCategory,
      code: text(error.code),
      requestId: text(error.requestId),
    });
    text(error.message);
    if ([400, 401, 403, 404, 409, 422].includes(cause.status)) throw cause;
    throw new NativePluginSelectionOutcomeUnknownError(cause);
  }
  if (reply.ok !== true)
    throw new Error("desktop_plugin_selection_reply_invalid");
  return parsePluginSelectionResponse(reply.value, {
    pluginId: input.pluginId,
    request: input.request,
  });
}

const categories = new Set<ErrorCategory>([
  "authentication",
  "authorization",
  "notFound",
  "conflict",
  "validation",
  "rateLimit",
  "providerUnavailable",
  "deviceUnavailable",
  "unknownOutcome",
  "internal",
]);

function record(
  input: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new Error("desktop_plugin_selection_reply_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const found = Reflect.ownKeys(descriptors);
  if (
    keys &&
    (found.length !== keys.length || keys.some((key) => !found.includes(key)))
  )
    throw new Error("desktop_plugin_selection_reply_invalid");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of found) {
    if (
      typeof key !== "string" ||
      !descriptors[key]!.enumerable ||
      !("value" in descriptors[key]!)
    )
      throw new Error("desktop_plugin_selection_reply_invalid");
    result[key] = descriptors[key]!.value;
  }
  return result;
}

function text(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096)
    throw new Error("desktop_plugin_selection_reply_invalid");
  return input;
}
