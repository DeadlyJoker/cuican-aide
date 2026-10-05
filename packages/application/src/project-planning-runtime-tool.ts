import {
  parseProjectPlanningCapabilities,
  parseProjectPlanningProposal,
  parseProjectPlanningProposalInput,
} from "@crewon/contracts/project-planning";
import {
  parseCanonicalAgentEvent,
  type CanonicalAgentEvent,
} from "@crewon/contracts";
import type { RunState } from "@crewon/domain";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import type { ProjectPlanningRuntimePort } from "./project-planning-runtime-port.ts";
import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";

export const PROJECT_CAPABILITIES_TOOL_NAME = "crewon_project_capabilities";
export const PROJECT_PROPOSE_TOOL_NAME = "crewon_project_propose";
export type ProjectPlanningToolName =
  | typeof PROJECT_CAPABILITIES_TOOL_NAME
  | typeof PROJECT_PROPOSE_TOOL_NAME;
export type ProjectPlanningRequestedTool = CanonicalAgentEvent &
  Readonly<{
    type: "tool.requested";
    data: Readonly<{
      callId: string;
      kind: "function";
      name: ProjectPlanningToolName;
      input: string;
    }>;
  }>;
export type ProjectPlanningToolResult = Readonly<{
  output: string;
  isError: boolean;
  assertActive(): void;
  assertCurrent(): Promise<void>;
}>;

/** A proposal is bounded data in the original Run stream, never a project or delegation mutation. */
export async function executeProjectPlanningRuntimeTool(
  input: Readonly<{
    claim: WorkItemClaim;
    requested: ProjectPlanningRequestedTool;
    port: ProjectPlanningRuntimePort;
    signal: AbortSignal;
    loadRun(): Promise<RunState>;
    assertClaimCurrent(): void;
  }>,
): Promise<ProjectPlanningToolResult> {
  const { port, signal } = input;
  const requested = Object.freeze(structuredClone(input.requested));
  Object.freeze(requested.data);
  const loadRun = input.loadRun.bind(input);
  const assertClaimCurrent = input.assertClaimCurrent.bind(input);
  parseCanonicalAgentEvent(requested);
  if (
    requested.type !== "tool.requested" ||
    requested.data.kind !== "function" ||
    ![PROJECT_CAPABILITIES_TOOL_NAME, PROJECT_PROPOSE_TOOL_NAME].includes(
      requested.data.name,
    )
  )
    throw new ApplicationError(
      "validation",
      "project_planning_tool_request_invalid",
    );
  const claim = Object.freeze(structuredClone(input.claim));
  Object.freeze(claim.workItem);
  Object.freeze(claim.lease);
  let original: RunState | undefined;
  const assertActive = () => {
    signal.throwIfAborted();
    assertClaimCurrent();
    port.assertActive();
  };
  async function assertCurrent() {
    assertActive();
    const run = Object.freeze(structuredClone(await loadRun()));
    assertActive();
    if (
      run.tenantId !== claim.workItem.tenantId ||
      run.runId !== claim.workItem.runId ||
      requested.runId !== run.runId ||
      (run.purpose ?? "turn") !== "turn" ||
      run.collaborationMode !== "default" ||
      (run.origin ?? null) !== null
    )
      throw new ApplicationError("validation", "project_planning_run_invalid");
    if (run.cancelRequested)
      throw new ApplicationError("conflict", "execution_cancel_pending");
    if (run.status !== "running")
      throw new ApplicationError("conflict", "run_not_running");
    if (original !== undefined)
      for (const field of [
        "tenantId",
        "spaceId",
        "threadId",
        "createdByActorId",
      ] as const)
        if (original[field] !== run[field])
          throw new ApplicationError(
            "conflict",
            "project_planning_run_changed",
          );
    original ??= run;
    if (port.canPublish(run) !== true)
      throw new ApplicationError(
        "authorization",
        "project_planning_runtime_unavailable",
      );
    await port.assertCurrent({ run, claim, signal });
    assertActive();
  }
  await assertCurrent();
  let argumentsValue: unknown;
  try {
    if (new TextEncoder().encode(requested.data.input).byteLength > 16 * 1024)
      throw new Error("input_limit");
    argumentsValue = JSON.parse(requested.data.input);
    if (requested.data.name === PROJECT_CAPABILITIES_TOOL_NAME) {
      if (
        argumentsValue === null ||
        typeof argumentsValue !== "object" ||
        Array.isArray(argumentsValue) ||
        Object.keys(argumentsValue).length !== 0
      )
        throw new Error("input_invalid");
    } else argumentsValue = parseProjectPlanningProposalInput(argumentsValue);
  } catch {
    return result({ error: "project_planning_arguments_invalid" }, true);
  }
  const capabilities = parseProjectPlanningCapabilities({
    schemaVersion: "crewon.project-planning-capabilities.v1",
    capabilities: await port.readCapabilities({
      run: original!,
      claim,
      signal,
    }),
  });
  await assertCurrent();
  if (requested.data.name === PROJECT_CAPABILITIES_TOOL_NAME)
    return result(capabilities, false);
  const proposalInput = parseProjectPlanningProposalInput(argumentsValue);
  const capability = capabilities.capabilities.find(
    (item) => item.capabilityId === proposalInput.capabilityId,
  );
  if (capability === undefined)
    return result({ error: "project_planning_capability_unavailable" }, true);
  const proposed = {
    schemaVersion: "crewon.project-planning-proposal.v1",
    kind: "newProject",
    capability,
    origin: {
      runId: original!.runId,
      threadId: original!.threadId,
      callId: requested.data.callId,
    },
    input: proposalInput,
  };
  if (new TextEncoder().encode(canonicalJson(proposed)).byteLength > 8 * 1024)
    return result({ error: "project_planning_result_too_large" }, true);
  return result(parseProjectPlanningProposal(proposed), false);

  function result(value: unknown, isError: boolean): ProjectPlanningToolResult {
    let output = canonicalJson(value);
    if (new TextEncoder().encode(output).byteLength > 8 * 1024) {
      output = canonicalJson({ error: "project_planning_result_too_large" });
      isError = true;
    }
    assertActive();
    return Object.freeze({ output, isError, assertActive, assertCurrent });
  }
}
