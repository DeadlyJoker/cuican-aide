import type {
  DecideToolApprovalRequest,
  ListWorkflowVersionsResponse,
  RunEventView,
  RunView,
  StartWorkflowRunRequest,
  ToolApprovalMutationResponse,
  ToolApprovalView,
  WorkflowVersionView,
} from "@crewon/contracts";
import {
  ControlApiProtocolError,
  streamRunEvents,
  type ControlApiClient,
} from "@crewon/control-client";

export type ControlWorkflowAdapter = Readonly<{
  discover(input: {
    cursor?: string | null;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ListWorkflowVersionsResponse>;
  readVersion(
    workflowVersionId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowVersionView>;
  start(input: {
    workflowVersionId: string;
    threadId: string;
    value: StartWorkflowRunRequest["input"];
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<RunView>;
  readRun(runId: string, signal?: AbortSignal): Promise<RunView>;
  readApproval(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ToolApprovalView>;
  decideApproval(input: {
    approvalId: string;
    body: DecideToolApprovalRequest;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ToolApprovalMutationResponse>;
  events(input: {
    runId: string;
    afterSequence: number;
    signal?: AbortSignal;
  }): AsyncIterable<RunEventView>;
}>;

export function createControlWorkflowAdapter(
  client: ControlApiClient,
): ControlWorkflowAdapter {
  return {
    discover: (input) =>
      client.listWorkflowVersions(
        { cursor: input.cursor, limit: input.limit },
        { signal: input.signal },
      ),
    async readVersion(workflowVersionId, signal) {
      return (await client.getWorkflowVersion(workflowVersionId, { signal }))
        .workflowVersion;
    },
    async start(input) {
      const run = (
        await client.startWorkflowRun(
          {
            workflowVersionId: input.workflowVersionId,
            threadId: input.threadId,
            input: input.value,
          },
          input.idempotencyKey,
          { signal: input.signal },
        )
      ).run;
      assertWorkflowRun(run, input.workflowVersionId);
      return run;
    },
    async readRun(runId, signal) {
      return (await client.getRun(runId, { signal })).run;
    },
    async readApproval(approvalId, signal) {
      return (await client.getToolApproval(approvalId, { signal })).approval;
    },
    decideApproval: (input) =>
      client.decideToolApproval(
        input.approvalId,
        input.body,
        input.idempotencyKey,
        { signal: input.signal },
      ),
    events: (input) =>
      streamRunEvents(client, {
        runId: input.runId,
        afterSequence: input.afterSequence,
        view: "client",
        signal: input.signal,
      }),
  };
}

function assertWorkflowRun(run: RunView, workflowVersionId: string): void {
  if (
    run.purpose !== "workflow" ||
    run.workflowVersionBinding?.workflowVersionId !== workflowVersionId
  ) {
    throw new ControlApiProtocolError("control_workflow_binding_invalid");
  }
}
