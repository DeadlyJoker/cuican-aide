import { parseExtensionIdempotencyKey } from "./extension-control-contract.ts";
import {
  parseProjectHistoricalQueryUiActionRequest,
  parseProjectHistoricalQueryUiActionResponse,
} from "./project-historical-query-ui-action-contract.ts";
import type {
  ProjectHistoricalQueryUiInput,
  ProjectHistoricalQueryUiReceipt,
} from "./plugin-project-historical-queries-service.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

import {
  PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION,
  type ProjectHistoricalQueryHostContext,
  type ProjectHistoricalQueryHostIntent,
} from "./plugin-project-historical-queries-service.ts";
export {
  PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION,
  type ProjectHistoricalQueryHostContext,
  type ProjectHistoricalQueryHostIntent,
} from "./plugin-project-historical-queries-service.ts";

export function parseProjectHistoricalQueryHostContext(
  input: unknown,
): ProjectHistoricalQueryHostContext {
  const fields = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["version", "recovery", "phase", "thread", "threadReady", "intent"],
  );
  if (
    fields.version !== PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION ||
    fields.recovery !== "session-only" ||
    !["idle", "loading", "ready", "uncertain", "error"].includes(
      fields.phase as string,
    ) ||
    typeof fields.threadReady !== "boolean"
  )
    pluginUiFailure("project_historical_query_host_context_invalid");
  let thread: ProjectHistoricalQueryHostContext["thread"] = null;
  if (fields.thread !== null) {
    const value = pluginUiFields(fields.thread, [
      "threadId",
      "revision",
      "provisional",
    ]);
    if (
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      value.revision >= Number.MAX_SAFE_INTEGER ||
      typeof value.provisional !== "boolean"
    )
      pluginUiFailure("project_historical_query_host_context_invalid");
    thread = Object.freeze({
      threadId: parseExtensionIdempotencyKey(value.threadId),
      revision: value.revision,
      provisional: value.provisional,
    });
  }
  let intent: ProjectHistoricalQueryHostIntent | null = null;
  if (fields.intent !== null) {
    const value = pluginUiFields(fields.intent, [
      "request",
      "phase",
      "retryable",
      "receipt",
    ]);
    if (
      !["pending", "uncertain", "accepted", "refused"].includes(
        value.phase as string,
      ) ||
      typeof value.retryable !== "boolean" ||
      (value.phase === "accepted") !== (value.receipt !== null) ||
      (value.phase !== "uncertain" && value.retryable)
    )
      pluginUiFailure("project_historical_query_host_context_invalid");
    const captured = parseProjectHistoricalQueryUiActionRequest({
      action: "crewon.project-historical-queries.v1.queryConceptGeneration",
      input: value.request,
    });
    intent = Object.freeze({
      request: captured.input,
      phase: value.phase as ProjectHistoricalQueryHostIntent["phase"],
      retryable: value.retryable,
      receipt:
        value.receipt === null
          ? null
          : parseProjectHistoricalQueryUiActionResponse(
              captured,
              value.receipt,
            ),
    });
  }
  if (
    fields.threadReady &&
    (fields.phase !== "ready" ||
      thread === null ||
      intent?.phase === "pending" ||
      intent?.phase === "uncertain")
  )
    pluginUiFailure("project_historical_query_host_context_invalid");
  return Object.freeze({
    version: PROJECT_HISTORICAL_QUERY_HOST_CONTEXT_VERSION,
    recovery: "session-only",
    phase: fields.phase as ProjectHistoricalQueryHostContext["phase"],
    thread,
    threadReady: fields.threadReady,
    intent,
  });
}
