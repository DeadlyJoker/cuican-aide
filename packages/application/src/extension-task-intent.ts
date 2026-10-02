import {
  extensionCanonicalJson,
  extensionOpaqueId,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { extensionCommand } from "./extension-application-support.ts";
import type { ExtensionTaskIntent } from "./extension-task-application-service.ts";

export function parseExtensionTaskIntent(input: unknown): ExtensionTaskIntent {
  const value = input as Record<string, unknown>;
  if (value?.kind === "generate") {
    const parsed = extensionCommand(input, ["kind", "input"]);
    if (
      new TextEncoder().encode(extensionCanonicalJson(parsed.input)).length >
      16 * 1024
    )
      throw new ApplicationError("validation", "extension_task_input_invalid");
    return { kind: "generate", input: parsed.input as WorkflowSchemaValue };
  }
  if (value?.kind === "query") {
    const parsed = extensionCommand(input, [
      "kind",
      "sourceRunId",
      "operationId",
    ]);
    const operationId = extensionOpaqueId(parsed.operationId);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        operationId,
      )
    )
      throw new ApplicationError(
        "validation",
        "extension_task_operation_invalid",
      );
    return {
      kind: "query",
      sourceRunId: extensionOpaqueId(parsed.sourceRunId),
      operationId,
    };
  }
  throw new ApplicationError("validation", "extension_task_intent_invalid");
}
