import type { ProjectToolsMethod } from "@crewon/contracts/project-tools";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";
import { parseProjectToolsRequest } from "./project-tools-service-request.ts";

/** Host-only, pure validation failure before any plugin/service dispatch. */
export class ProjectToolInputError extends Error {
  readonly method: ProjectToolsMethod;
  constructor(method: ProjectToolsMethod) {
    super("plugin_project_tools_request_invalid");
    this.method = method;
  }
}

export function parseProjectDispatchInput(
  method: ProjectToolsMethod,
  input: string,
) {
  try {
    return parseProjectToolsRequest(method, JSON.parse(input));
  } catch {
    throw new ProjectToolInputError(method);
  }
}

export function projectToolInputErrorResult(
  error: ProjectToolInputError,
  command: ToolExecutionCommand,
): ToolExecutionResolution {
  const hint =
    error.method === "readContent"
      ? 'Use {projectId,offset,source}. For a brief, source must contain only {kind:"brief",briefRevision}. For text, source must contain only {kind:"text",artifactId,contentRevision}. Read project context for actual IDs/revisions; do not mix the two source shapes.'
      : "Arguments do not match this project tool. Check the declared schema and current project context, then correct the arguments. No operation was performed.";
  return {
    status: "completed",
    executionId: command.executionId,
    providerReceiptId: `host-input-rejected:${command.executionId}`,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: command.callId,
      output: JSON.stringify({
        resultJson: JSON.stringify({ error: error.message, hint }),
      }),
      isError: true,
      artifactRef: null,
    },
  };
}
