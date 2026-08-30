import {
  validateWorkspaceOperationEvent,
  validateWorkspaceOperationListPage,
  validateWorkspaceOperationMutationResult,
  validateWorkspaceOperationRecord,
  validateWorkspaceOperationSnapshot,
  type WorkspaceOperationEvent,
  type WorkspaceOperationListPage,
  type WorkspaceOperationListQuery as InternalWorkspaceOperationListQuery,
  type WorkspaceOperationMutationResult,
  type WorkspaceOperationRecord,
  type WorkspaceOperationSnapshot,
} from "@crewon/application";
import {
  parseGetWorkspaceOperationResponse,
  parseListWorkspaceOperationsResponse,
  parseWorkspaceOperationEventView,
  parseWorkspaceOperationMutationResponse,
  parseWorkspaceOperationView,
  type GetWorkspaceOperationResponse,
  type ListWorkspaceOperationsResponse,
  type WorkspaceOperationEventView,
  type WorkspaceOperationListQuery,
  type WorkspaceOperationMutationResponse,
  type WorkspaceOperationView,
} from "@crewon/contracts";

export function projectWorkspaceOperation(
  input: WorkspaceOperationRecord,
): WorkspaceOperationView {
  return projection(() => {
    const operation = validateWorkspaceOperationRecord(input);
    const common = {
      threadId: operation.threadId,
      executionId: operation.executionId,
      revision: operation.revision,
    };
    switch (operation.status) {
      case "prepared":
        return parseWorkspaceOperationView({
          ...common,
          status: "pending",
          result: null,
        });
      case "completed":
        if (operation.resolution?.status !== "completed") {
          throw new Error("workspace_operation_resolution_invalid");
        }
        return parseWorkspaceOperationView({
          ...common,
          status: "completed",
          result: {
            status: "completed",
            entries: operation.resolution.entries.map(({ name, kind }) => ({
              name,
              kind,
            })),
            truncated: operation.resolution.truncated,
          },
        });
      case "failed":
        if (operation.resolution?.status !== "failed") {
          throw new Error("workspace_operation_resolution_invalid");
        }
        return parseWorkspaceOperationView({
          ...common,
          status: "failed",
          result: {
            status: "failed",
            code: operation.resolution.code,
            retryable: operation.resolution.retryable,
          },
        });
      case "canceled":
      case "unknownOutcome":
        return parseWorkspaceOperationView({
          ...common,
          status: operation.status,
          result: null,
        });
    }
  });
}

export function projectWorkspaceOperationMutation(
  input: WorkspaceOperationMutationResult,
): WorkspaceOperationMutationResponse {
  return projection(() => {
    const result = validateWorkspaceOperationMutationResult(input);
    return parseWorkspaceOperationMutationResponse(
      {
        disposition: result.disposition,
        eventSequence: result.operation.revision,
        operation: projectWorkspaceOperation(result.operation),
      },
      {
        threadId: result.operation.threadId,
        executionId: result.operation.executionId,
      },
    );
  });
}

export function projectWorkspaceOperationSnapshot(
  input: WorkspaceOperationSnapshot,
): GetWorkspaceOperationResponse {
  return projection(() => {
    const snapshot = validateWorkspaceOperationSnapshot(input);
    return parseGetWorkspaceOperationResponse(
      {
        operation: projectWorkspaceOperation(snapshot.operation),
        eventSequence: snapshot.eventSequence,
      },
      {
        threadId: snapshot.operation.threadId,
        executionId: snapshot.operation.executionId,
      },
    );
  });
}

export function projectWorkspaceOperationList(
  input: WorkspaceOperationListPage,
  query: InternalWorkspaceOperationListQuery,
): ListWorkspaceOperationsResponse {
  return projection(() => {
    const page = validateWorkspaceOperationListPage(input, query);
    const publicQuery: WorkspaceOperationListQuery = {
      afterExecutionId: query.afterExecutionId,
      limit: query.limit,
    };
    return parseListWorkspaceOperationsResponse(
      {
        data: page.operations.map(projectWorkspaceOperation),
        nextAfterExecutionId: page.nextAfterExecutionId,
      },
      { threadId: query.threadId, query: publicQuery },
    );
  });
}

export function projectWorkspaceOperationEvent(
  input: WorkspaceOperationEvent,
  expected: Readonly<{
    threadId: string;
    executionId: string;
    afterSequence: number;
  }>,
): WorkspaceOperationEventView {
  return projection(() => {
    const event = validateWorkspaceOperationEvent(input);
    return parseWorkspaceOperationEventView(
      {
        schemaVersion: "crewon.workspace-operation-event.v0",
        threadId: event.operation.threadId,
        executionId: event.operation.executionId,
        sequence: event.sequence,
        type: "workspace.operation.replaced",
        data: { operation: projectWorkspaceOperation(event.operation) },
      },
      expected,
    );
  });
}

function projection<T>(project: () => T): T {
  try {
    return project();
  } catch (error) {
    throw new Error("workspace_operation_projection_invalid", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
