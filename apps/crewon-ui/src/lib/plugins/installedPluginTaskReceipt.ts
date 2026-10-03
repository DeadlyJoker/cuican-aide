import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type {
  PluginJsonValue,
  PluginTaskReceipt,
} from "@crewon/plugin-sdk/contracts";
import {
  assertPluginUiCurrent,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";
import { uiFailure } from "./pluginUiValidation";

/** A receipt hint from this captured client's response, not a Run authorization grant. */
export type InstalledPluginTaskReceiptEvent = Readonly<{
  lease: PluginUiLease;
  receipt: PluginTaskReceipt;
}>;

const receiptKeys = Object.freeze([
  "disposition",
  "threadId",
  "threadRevision",
  "runId",
  "messageId",
  "configurationRevision",
]);

/** Ordinary action JSON remains ordinary. Read only exact own data, without invoking accessors. */
export function readInstalledPluginTaskReceipt(
  input: unknown,
): PluginTaskReceipt | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== receiptKeys.length ||
    keys.some((key) => typeof key !== "string" || !receiptKeys.includes(key))
  )
    return null;
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of receiptKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    fields[key] = descriptor.value;
  }
  if (
    (fields.disposition !== "committed" && fields.disposition !== "replayed") ||
    !id(fields.threadId) ||
    !id(fields.runId) ||
    fields.runId === "." ||
    fields.runId === ".." ||
    /[\\/]/u.test(fields.runId) ||
    !id(fields.messageId) ||
    !positiveRevision(fields.threadRevision) ||
    !positiveRevision(fields.configurationRevision) ||
    fields.configurationRevision > 2_147_483_647
  )
    return null;
  return Object.freeze({
    disposition: fields.disposition,
    threadId: fields.threadId,
    threadRevision: fields.threadRevision,
    runId: fields.runId,
    messageId: fields.messageId,
    configurationRevision: fields.configurationRevision,
  });
}

function id(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return false;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).length <= 128;
}

function positiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

type ActionResponse = Readonly<{ output: PluginJsonValue }>;

/**
 * Navigation revokes the plugin immediately, while the captured HTTP owner can
 * still observe a confirmed receipt. This owner's deadline never releases a
 * physical request slot until the real request settles.
 */
export function createInstalledPluginTaskReceiptTransport(
  options: Readonly<{
    assertCurrent: PluginUiCurrentScope;
    onTaskReceipt(event: InstalledPluginTaskReceiptEvent): void;
    onDiagnostic(error: unknown): void;
  }>,
) {
  const assertCurrent = options.assertCurrent.bind(options);
  const observer = options.onTaskReceipt.bind(options);
  const diagnostic = options.onDiagnostic.bind(options);
  const pending = new Set<Promise<ActionResponse>>();
  return (
    lease: PluginUiLease,
    caller: AbortSignal,
    request: (signal: AbortSignal) => Promise<ActionResponse>,
  ): Promise<ActionResponse> => {
    assertPluginUiCurrent(assertCurrent, caller);
    const capturedLease = parsePluginUiLease(lease);
    return pluginUiControlRequest((signal) => {
      if (pending.size >= 16) uiFailure("plugin_ui_inflight_limit");
      // Register before the deferred transport callback can re-enter this owner.
      const actual = Promise.resolve().then(async () => {
        assertPluginUiCurrent(assertCurrent, caller);
        const response = await request(signal);
        // The mount's cancellation is deliberately absent from this session check.
        assertPluginUiCurrent(assertCurrent);
        const receipt = readInstalledPluginTaskReceipt(response.output);
        if (receipt) {
          const event = Object.freeze({
            lease: capturedLease,
            receipt,
          });
          try {
            observer(event);
          } catch (error) {
            try {
              diagnostic(error);
            } catch {
              /* A host observer failure cannot turn confirmed COMMIT into a retry. */
            }
          }
        }
        return response;
      });
      pending.add(actual);
      const release = () => pending.delete(actual);
      void actual.then(release, release);
      return actual;
    });
  };
}
