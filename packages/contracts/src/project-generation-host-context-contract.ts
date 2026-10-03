import { parseExtensionIdempotencyKey } from "./extension-control-contract.ts";
import {
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
  type ProjectGenerationUiInput,
  type ProjectGenerationUiReceipt,
} from "./project-generation-ui-action-contract.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

export const PROJECT_GENERATION_HOST_CONTEXT_VERSION =
  "crewon.project-generation-host-context.v1";
export type ProjectGenerationHostIntent = Readonly<{
  request: ProjectGenerationUiInput;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  retryable: boolean;
  receipt: ProjectGenerationUiReceipt | null;
}>;
/** Bounded display/recovery data. It never supplies the current session or generation authority. */
export type ProjectGenerationHostContext = Readonly<{
  version: typeof PROJECT_GENERATION_HOST_CONTEXT_VERSION;
  phase: "idle" | "loading" | "ready" | "preparing" | "uncertain" | "error";
  thread: Readonly<{
    threadId: string;
    revision: number;
    provisional: boolean;
  }> | null;
  threadReady: boolean;
  intent: ProjectGenerationHostIntent | null;
}>;

export function parseProjectGenerationHostContext(
  input: unknown,
): ProjectGenerationHostContext {
  const fields = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["version", "phase", "thread", "threadReady", "intent"],
  );
  if (
    fields.version !== PROJECT_GENERATION_HOST_CONTEXT_VERSION ||
    !["idle", "loading", "ready", "preparing", "uncertain", "error"].includes(
      fields.phase as string,
    ) ||
    typeof fields.threadReady !== "boolean"
  )
    pluginUiFailure("project_generation_host_context_invalid");
  let thread: ProjectGenerationHostContext["thread"] = null;
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
      pluginUiFailure("project_generation_host_context_invalid");
    thread = Object.freeze({
      threadId: parseExtensionIdempotencyKey(value.threadId),
      revision: value.revision,
      provisional: value.provisional,
    });
  }
  let intent: ProjectGenerationHostIntent | null = null;
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
      pluginUiFailure("project_generation_host_context_invalid");
    const captured = parseProjectGenerationUiActionRequest({
      action: "crewon.project-generations.v1.generateConcept",
      input: value.request,
    });
    intent = Object.freeze({
      request: captured.input,
      phase: value.phase as ProjectGenerationHostIntent["phase"],
      retryable: value.retryable,
      receipt:
        value.receipt === null
          ? null
          : parseProjectGenerationUiActionResponse(captured, value.receipt),
    });
  }
  if (
    fields.threadReady &&
    (fields.phase !== "ready" ||
      thread === null ||
      intent?.phase === "pending" ||
      intent?.phase === "uncertain")
  )
    pluginUiFailure("project_generation_host_context_invalid");
  return Object.freeze({
    version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
    phase: fields.phase as ProjectGenerationHostContext["phase"],
    thread,
    threadReady: fields.threadReady,
    intent,
  });
}
