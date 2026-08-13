import type {
  ListWorkflowVersionsResponse,
  RunEventView,
  RunView,
  StartWorkflowRunRequest,
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
    signal?: AbortSignal;
  }): Promise<RunView>;
  readRun(runId: string, signal?: AbortSignal): Promise<RunView>;
  cancel(run: RunView, signal?: AbortSignal): Promise<RunView>;
  events(input: {
    runId: string;
    afterSequence: number;
    signal?: AbortSignal;
  }): AsyncIterable<RunEventView>;
}>;

export function createControlWorkflowAdapter(
  client: ControlApiClient,
  idempotencyKey: (operation: string) => string = (operation) =>
    `${operation}:${globalThis.crypto.randomUUID()}`,
): ControlWorkflowAdapter {
  return {
    discover: (input) =>
      client.listWorkflowVersions(
        { cursor: input.cursor, limit: input.limit },
        { signal: input.signal },
      ),
    async readVersion(workflowVersionId, signal) {
      return (
        await client.getWorkflowVersion(workflowVersionId, { signal })
      ).workflowVersion;
    },
    async start(input) {
      const run = (
        await client.startWorkflowRun(
          {
            workflowVersionId: input.workflowVersionId,
            threadId: input.threadId,
            input: input.value,
          },
          idempotencyKey("workflow.start"),
          { signal: input.signal },
        )
      ).run;
      assertWorkflowRun(run, input.workflowVersionId);
      return run;
    },
    async readRun(runId, signal) {
      return (await client.getRun(runId, { signal })).run;
    },
    async cancel(run, signal) {
      const canceled = (
        await client.cancelRun(
          run.runId,
          { expectedRevision: run.revision },
          idempotencyKey("workflow.cancel"),
          { signal },
        )
      ).run;
      assertWorkflowRun(
        canceled,
        run.workflowVersionBinding?.workflowVersionId ?? "",
      );
      return canceled;
    },
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
