import {
  PROJECT_CAPABILITIES_TOOL_NAME,
  PROJECT_PROPOSE_TOOL_NAME,
  captureProjectPlanningRuntimePort,
  type ProjectPlanningRuntimePort,
  type ProjectPlanningRequestedTool,
  type ProjectPlanningToolResult,
  type RunExecutionService,
  type WorkItemClaim,
  type ProjectPlanningToolName,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type { ToolDefinition } from "@crewon/tool-broker";

const capabilityId = {
  type: "string",
  pattern: "^sha256:[a-f0-9]{64}$",
};
const definitions: readonly ToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: PROJECT_CAPABILITIES_TOOL_NAME,
    description:
      "Read the current approved project-planning capabilities available to this conversation. This does not load plugin Node code, create a project, start a Run, or authorize a plan. Availability is checked again before the user uses an entry.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: PROJECT_PROPOSE_TOOL_NAME,
    description:
      "Propose a bounded text-creation project using a current capability returned by crewon_project_capabilities. The result is only a suggestion for the user to review in the actual plugin workbench. It creates no project, conversation, plan, Run, or delegation. Default adoption is manual; whenUnchanged remains only a suggestion until the user explicitly confirms it in the workbench.",
    execution: "serial",
    inputSchema: {
      type: "object",
      properties: {
        capabilityId,
        title: { type: "string", minLength: 1, maxLength: 128 },
        briefText: { type: "string", minLength: 1, maxLength: 4096 },
        instruction: { type: "string", minLength: 1, maxLength: 2048 },
        start: { type: "string", enum: ["brief", "outline"] },
        target: { type: "string", enum: ["brief", "outline", "script"] },
        episodeCount: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: 16 },
            { type: "null" },
          ],
        },
        adoption: { type: "string", enum: ["manual", "whenUnchanged"] },
      },
      required: [
        "capabilityId",
        "title",
        "briefText",
        "instruction",
        "start",
        "target",
        "episodeCount",
        "adoption",
      ],
      additionalProperties: false,
    },
  },
];

/** Publication gate only; the deployment port still verifies actual current identity and metadata on every call. */
export function projectPlanningRuntimeToolsForRun(
  run: RunState,
  publication: Readonly<{
    configured: boolean;
    executionAuthority: "crewonKernel" | "providerAgent";
    installedPluginAdmission: "none" | "present";
  }>,
): readonly ToolDefinition[] {
  return publication.configured &&
    publication.executionAuthority === "crewonKernel" &&
    publication.installedPluginAdmission === "none" &&
    run.collaborationMode === "default" &&
    (run.purpose ?? "turn") === "turn" &&
    (run.origin ?? null) === null
    ? structuredClone(definitions)
    : [];
}

export function isProjectPlanningToolCall(call: {
  kind: "function" | "custom";
  name: string;
}): call is { kind: "function"; name: ProjectPlanningToolName } {
  return (
    call.kind === "function" &&
    (call.name === PROJECT_CAPABILITIES_TOOL_NAME ||
      call.name === PROJECT_PROPOSE_TOOL_NAME)
  );
}

/** Own every physical metadata read even when the original Worker Store scope has already closed. */
export class ProjectPlanningRuntimeToolsOwner {
  readonly #port: ProjectPlanningRuntimePort;
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<ProjectPlanningToolResult>>();
  #close: Promise<void> | null = null;

  constructor(port: ProjectPlanningRuntimePort) {
    this.#port = captureProjectPlanningRuntimePort(port);
  }

  canPublish(run: RunState): boolean {
    return (
      !this.#controller.signal.aborted &&
      this.#port.canPublish(Object.freeze(structuredClone(run))) === true
    );
  }

  execute(
    input: Readonly<{
      execution: RunExecutionService;
      claim: WorkItemClaim;
      requested: ProjectPlanningRequestedTool;
      signal: AbortSignal;
      assertClaimCurrent(): void;
    }>,
  ): Promise<ProjectPlanningToolResult> {
    const signal = AbortSignal.any([input.signal, this.#controller.signal]);
    const task = (async () => {
      const result = await input.execution.executeProjectPlanningTool(
        input.claim,
        input.requested,
        {
          port: this.#port,
          signal,
          assertClaimCurrent: input.assertClaimCurrent,
        },
      );
      await result.assertCurrent();
      result.assertActive();
      return result;
    })();
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task)).catch(() => {});
    return task;
  }

  close(): Promise<void> {
    if (this.#close !== null) return this.#close;
    this.#controller.abort("project_planning_runtime_closing");
    this.#close = Promise.allSettled([...this.#pending]).then(() => {});
    return this.#close;
  }
}
