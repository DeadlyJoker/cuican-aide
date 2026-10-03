import { parseExtensionIdempotencyKey } from "./extension-control-contract.ts";
import {
  parseProjectGenerationQueryUiActionRequest,
  parseProjectGenerationQueryUiActionResponse,
  type ProjectGenerationQueryUiInput,
  type ProjectGenerationQueryUiReceipt,
} from "./project-generation-query-ui-action-contract.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

export const PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION =
  "crewon.project-generation-query-host-context.v1";
export type ProjectGenerationQueryHostIntent = Readonly<{
  request: ProjectGenerationQueryUiInput;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  retryable: boolean;
  receipt: ProjectGenerationQueryUiReceipt | null;
}>;
/** Bounded display/recovery data. It never supplies the current session or query authority. */
export type ProjectGenerationQueryHostContext = Readonly<{
  version: typeof PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION;
  phase: "idle" | "loading" | "ready" | "uncertain" | "error";
  thread: Readonly<{
    threadId: string;
    revision: number;
    provisional: boolean;
  }> | null;
  threadReady: boolean;
  intent: ProjectGenerationQueryHostIntent | null;
}>;

export function parseProjectGenerationQueryHostContext(
  input: unknown,
): ProjectGenerationQueryHostContext {
  const fields = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["version", "phase", "thread", "threadReady", "intent"],
  );
  if (
    fields.version !== PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION ||
    !["idle", "loading", "ready", "uncertain", "error"].includes(
      fields.phase as string,
    ) ||
    typeof fields.threadReady !== "boolean"
  )
    pluginUiFailure("project_generation_query_host_context_invalid");
  let thread: ProjectGenerationQueryHostContext["thread"] = null;
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
      pluginUiFailure("project_generation_query_host_context_invalid");
    thread = Object.freeze({
      threadId: parseExtensionIdempotencyKey(value.threadId),
      revision: value.revision,
      provisional: value.provisional,
    });
  }
  let intent: ProjectGenerationQueryHostIntent | null = null;
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
      pluginUiFailure("project_generation_query_host_context_invalid");
    const captured = parseProjectGenerationQueryUiActionRequest({
      action: "crewon.project-generation-queries.v1.queryConceptGeneration",
      input: value.request,
    });
    intent = Object.freeze({
      request: captured.input,
      phase: value.phase as ProjectGenerationQueryHostIntent["phase"],
      retryable: value.retryable,
      receipt:
        value.receipt === null
          ? null
          : parseProjectGenerationQueryUiActionResponse(
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
    pluginUiFailure("project_generation_query_host_context_invalid");
  return Object.freeze({
    version: PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
    phase: fields.phase as ProjectGenerationQueryHostContext["phase"],
    thread,
    threadReady: fields.threadReady,
    intent,
  });
}
