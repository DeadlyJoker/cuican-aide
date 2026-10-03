import type {
  PluginJsonValue,
  PluginTaskReceipt,
} from "@crewon/plugin-sdk/contracts";

export type KreaUiTaskProjection = Readonly<{
  ready: boolean;
  thread: Readonly<{ threadId: string; revision: number }> | null;
  source: Readonly<{ sourceRunId: string; operationId: string }> | null;
  generateKey: string | null;
  queryKey: string | null;
}>;

export function jsonRecord(
  value: PluginJsonValue,
): Readonly<Record<string, PluginJsonValue>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, PluginJsonValue>>)
    : null;
}

function reference(value: PluginJsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function key(value: PluginJsonValue | undefined): string | null {
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/u.test(value)
    ? value
    : null;
}

/** Presentation references only. The task bridge rechecks actual identity and persisted source authority. */
export function readTaskProjection(
  data: PluginJsonValue,
): KreaUiTaskProjection {
  const value = jsonRecord(data);
  return Object.freeze({
    ready:
      value === null ||
      !Object.hasOwn(value, "taskContextReady") ||
      value.taskContextReady === true,
    thread:
      value !== null &&
      reference(value.threadId) &&
      Number.isSafeInteger(value.expectedThreadRevision) &&
      (value.expectedThreadRevision as number) >= 0
        ? Object.freeze({
            threadId: value.threadId,
            revision: value.expectedThreadRevision as number,
          })
        : null,
    source:
      value !== null &&
      reference(value.sourceRunId) &&
      reference(value.operationId)
        ? Object.freeze({
            sourceRunId: value.sourceRunId,
            operationId: value.operationId,
          })
        : null,
    generateKey: key(value?.idempotencyKey),
    queryKey: key(value?.queryIdempotencyKey),
  });
}

/** A generic action result is not a confirmation unless the complete task receipt matches this request. */
export function readTaskReceipt(
  input: PluginJsonValue,
  request: Readonly<{ threadId: string; expectedThreadRevision: number }>,
): PluginTaskReceipt | null {
  const value = jsonRecord(input);
  if (
    !value ||
    Object.keys(value).length !== 6 ||
    ![
      "disposition",
      "threadId",
      "threadRevision",
      "runId",
      "messageId",
      "configurationRevision",
    ].every((field) => Object.hasOwn(value, field)) ||
    (value.disposition !== "committed" && value.disposition !== "replayed") ||
    value.threadId !== request.threadId ||
    !Number.isSafeInteger(value.threadRevision) ||
    (value.threadRevision as number) <= request.expectedThreadRevision ||
    !reference(value.runId) ||
    !reference(value.messageId) ||
    !Number.isSafeInteger(value.configurationRevision) ||
    (value.configurationRevision as number) < 1
  )
    return null;
  return Object.freeze({
    disposition: value.disposition,
    threadId: request.threadId,
    threadRevision: value.threadRevision as number,
    runId: value.runId,
    messageId: value.messageId,
    configurationRevision: value.configurationRevision as number,
  });
}
