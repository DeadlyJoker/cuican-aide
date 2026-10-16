import {
  parseWorkflowGateLocator,
  parseDecideWorkflowHumanGateRequest,
  parseWorkflowRunSnapshotResponse,
  parseWorkflowHumanGateResponse,
  parseWorkflowHumanGateMutationResponse,
  MAX_WORKFLOW_RUN_SNAPSHOT_BYTES,
  MAX_WORKFLOW_GATE_RESPONSE_BYTES,
  parseRunId,
  parseWorkflowExecutionCapability,
  type WorkflowExecutionCapability,
  type WorkflowGateLocator,
  type WorkflowRunSnapshotResponse,
  type WorkflowHumanGateResponse,
  type WorkflowHumanGateMutationResponse,
  type DecideWorkflowHumanGateRequest,
} from "@crewon/contracts";
import { ControlApiProtocolError } from "./control-api-errors.ts";
import type { ControlApiRequestOptions } from "./control-api-client.ts";

type WorkflowJsonRequest = (
  method: "GET" | "POST",
  path: string,
  body: unknown,
  options: ControlApiRequestOptions & {
    requireCsrf?: boolean;
    expectedStatuses: readonly number[];
    maximumResponseBytes: number;
  },
) => Promise<unknown>;

/** Reuses the authenticated transport; does not retry writes or own execution state. */
export class WorkflowControlClient {
  readonly #request: WorkflowJsonRequest;
  constructor(request: WorkflowJsonRequest) {
    this.#request = request;
  }
  async getWorkflowExecutionCapability(
    options: ControlApiRequestOptions = {},
  ): Promise<WorkflowExecutionCapability> {
    options.signal?.throwIfAborted();
    const value = await this.#request(
      "GET",
      "/api/v1/capabilities/workflow-execution-v1",
      null,
      { ...options, expectedStatuses: [200], maximumResponseBytes: 1024 },
    );
    options.signal?.throwIfAborted();
    try {
      return parseWorkflowExecutionCapability(value);
    } catch {
      throw new ControlApiProtocolError(
        "control_client_workflow_capability_invalid",
      );
    }
  }
  async getWorkflowRunSnapshot(
    runId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<WorkflowRunSnapshotResponse> {
    const signal = options.signal;
    signal?.throwIfAborted();
    parseRunId(runId);
    const value = await this.#request(
      "GET",
      `/api/v1/workflow-runs/${encodeURIComponent(runId)}`,
      null,
      {
        ...options,
        expectedStatuses: [200],
        maximumResponseBytes: MAX_WORKFLOW_RUN_SNAPSHOT_BYTES,
      },
    );
    signal?.throwIfAborted();
    try {
      return parseWorkflowRunSnapshotResponse(value, runId);
    } catch {
      throw new ControlApiProtocolError(
        "control_client_workflow_snapshot_invalid",
      );
    }
  }

  async getWorkflowHumanGate(
    input: WorkflowGateLocator,
    options: ControlApiRequestOptions = {},
  ): Promise<WorkflowHumanGateResponse> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const locator = parseWorkflowGateLocator(input);
    const value = await this.#request("GET", workflowGatePath(locator), null, {
      ...options,
      expectedStatuses: [200],
      maximumResponseBytes: MAX_WORKFLOW_GATE_RESPONSE_BYTES,
    });
    signal?.throwIfAborted();
    try {
      return parseWorkflowHumanGateResponse(value, locator);
    } catch {
      throw new ControlApiProtocolError("control_client_workflow_gate_invalid");
    }
  }

  async decideWorkflowHumanGate(
    input: WorkflowGateLocator,
    body: DecideWorkflowHumanGateRequest,
    options: ControlApiRequestOptions = {},
  ): Promise<WorkflowHumanGateMutationResponse> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const locator = parseWorkflowGateLocator(input),
      command = parseDecideWorkflowHumanGateRequest(body);
    const value = await this.#request(
      "POST",
      `${workflowGatePath(locator)}/decisions`,
      command,
      {
        ...options,
        requireCsrf: true,
        expectedStatuses: [200],
        maximumResponseBytes: MAX_WORKFLOW_GATE_RESPONSE_BYTES,
      },
    );
    signal?.throwIfAborted();
    try {
      return parseWorkflowHumanGateMutationResponse(value, locator, command);
    } catch {
      throw new ControlApiProtocolError(
        "control_client_workflow_gate_decision_invalid",
      );
    }
  }
}

function workflowGatePath(locator: WorkflowGateLocator): string {
  return `/api/v1/workflow-runs/${encodeURIComponent(locator.runId)}/nodes/${encodeURIComponent(locator.nodeId)}/gates/${encodeURIComponent(locator.gateRequestId)}`;
}
