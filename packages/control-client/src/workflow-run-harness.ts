import type {
  RunEventView,
  RunView,
  StartWorkflowRunRequest,
} from "@crewon/contracts";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { streamRunEvents } from "./run-event-stream.ts";

export type WorkflowRunTerminalHarnessResult = Readonly<{
  started: RunView;
  terminalEvent: RunEventView;
  terminal: RunView;
}>;

/**
 * Drives the public Control boundary used by packaged acceptance: start over
 * HTTP, wait for a durable terminal SSE event, then re-read canonical Run
 * state. It deliberately has no Store or Worker shortcuts.
 */
export async function startWorkflowRunAndWaitForTerminal(
  client: ControlApiClient,
  input: {
    request: StartWorkflowRunRequest;
    idempotencyKey: string;
    signal?: AbortSignal;
  },
): Promise<WorkflowRunTerminalHarnessResult> {
  const mutation = await client.startWorkflowRun(
    input.request,
    input.idempotencyKey,
    { signal: input.signal },
  );
  const started = mutation.run;
  assertWorkflowBinding(started, input.request.workflowVersionId);

  let terminalEvent: RunEventView | null = null;
  for await (const event of streamRunEvents(client, {
    runId: started.runId,
    afterSequence: started.lastSequence,
    view: "audit",
    signal: input.signal,
  })) {
    if (isTerminalEvent(event)) {
      terminalEvent = event;
      break;
    }
  }
  if (terminalEvent === null) {
    throw new ControlApiProtocolError(
      "control_client_workflow_terminal_event_missing",
    );
  }

  const terminal = (
    await client.getRun(started.runId, {
      signal: input.signal,
    })
  ).run;
  assertWorkflowBinding(terminal, input.request.workflowVersionId);
  if (!isTerminalStatus(terminal.status)) {
    throw new ControlApiProtocolError(
      "control_client_workflow_terminal_state_missing",
    );
  }
  if (terminal.lastSequence < terminalEvent.sequence) {
    throw new ControlApiProtocolError(
      "control_client_workflow_terminal_sequence_invalid",
    );
  }
  return { started, terminalEvent, terminal };
}

function assertWorkflowBinding(run: RunView, workflowVersionId: string): void {
  if (
    run.purpose !== "workflow" ||
    run.workflowVersionBinding === null ||
    run.workflowVersionBinding.workflowVersionId !== workflowVersionId
  ) {
    throw new ControlApiProtocolError(
      "control_client_workflow_binding_invalid",
    );
  }
}

function isTerminalEvent(event: RunEventView): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.canceled"
  );
}

function isTerminalStatus(status: RunView["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
