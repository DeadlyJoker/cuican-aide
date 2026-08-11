import type {
  GetThreadResponse,
  WorkspaceOperationEventView,
  WorkspaceOperationView,
} from "@crewon/contracts";
import { ControlApiClient, ControlApiClientError } from "@crewon/control-client";

export const PAGE_SIZE = 100;
export const MAX_LIST_PAGES = 100;

export type ControlWorkspaceStatus =
  | "available"
  | "unavailable"
  | "loading"
  | "live"
  | "mutating"
  | "conflict"
  | "error";

export type ControlWorkspaceState = Readonly<{
  status: ControlWorkspaceStatus;
  threadId: string | null;
  threadRevision: number | null;
  threadStatus: "active" | "archived" | "deleted" | null;
  operations: readonly WorkspaceOperationView[];
  eventSequences: Readonly<Record<string, number>>;
}>;

export type WorkspaceOperationEventStream = (
  client: ControlApiClient,
  input: {
    threadId: string;
    executionId: string;
    afterSequence?: number;
    reconnectDelayMs?: number;
    signal?: AbortSignal;
  },
) => AsyncIterable<WorkspaceOperationEventView>;

export type Selection = {
  generation: number;
  threadId: string;
  threadRevision: number;
  threadStatus: "active" | "archived" | "deleted";
  controller: AbortController;
  operations: Map<string, WorkspaceOperationView>;
  eventSequences: Map<string, number>;
  streams: Map<string, OperationStream>;
};

export type OperationStream = {
  generation: number;
  controller: AbortController;
};

export function isGenerationCurrent(
  closed: boolean,
  currentGeneration: number,
  generation: number,
  controller: AbortController,
): boolean {
  return (
      !closed &&
      generation === currentGeneration &&
      !controller.signal.aborted
    );
}

export function requireWorkspaceClient(
  client: ControlApiClient | null,
  closed: boolean,
): ControlApiClient {
  if (client === null || closed) {
    throw new Error("control_workspace_unavailable");
  }
  return client;
}

export function validateThreadSnapshot<Snapshot extends CanonicalThreadSnapshot>(
  response: Snapshot,
  threadId: string,
): Snapshot {
  if (
    response.thread.threadId !== threadId ||
    !Number.isSafeInteger(response.thread.revision) ||
    response.thread.revision < 1 ||
    !["active", "archived", "deleted"].includes(response.thread.status)
  ) {
    throw new Error("control_workspace_thread_snapshot_invalid");
  }
  return response;
}

type CanonicalThreadSnapshot = Readonly<{
  thread: GetThreadResponse["thread"];
}>;

export function isUnknownNetwork(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof ControlApiClientError &&
      error.category === "unknownOutcome")
  );
}

export function isConflict(error: unknown): boolean {
  return error instanceof ControlApiClientError && error.status === 409;
}

export function isStreamableOperation(operation: WorkspaceOperationView): boolean {
  return (
    operation.status === "pending" || operation.status === "unknownOutcome"
  );
}

export function emptyState(
  status: "available" | "unavailable",
): ControlWorkspaceState {
  return {
    status,
    threadId: null,
    threadRevision: null,
    threadStatus: null,
    operations: [],
    eventSequences: {},
  };
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index]! - rightBytes[index]!;
    }
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

export function buildWorkspaceState(
  selection: Selection,
  status: ControlWorkspaceStatus,
): ControlWorkspaceState {
  const operations = [...selection.operations.values()].sort((left, right) =>
    compareUtf8(left.executionId, right.executionId),
  );
  return {
    status,
    threadId: selection.threadId,
    threadRevision: selection.threadRevision,
    threadStatus: selection.threadStatus,
    operations: structuredClone(operations),
    eventSequences: Object.fromEntries(
      operations.map((operation) => [
        operation.executionId,
        selection.eventSequences.get(operation.executionId) ??
          operation.revision,
      ]),
    ),
  };
}
