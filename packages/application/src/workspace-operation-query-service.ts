import { validateThreadState, type ThreadState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type { SpaceScopedThreadStore } from "./thread-store-port.ts";
import {
  WORKSPACE_OPERATION_EVENT_PAGE_MAX_LIMIT,
  WORKSPACE_OPERATION_LIST_PAGE_MAX_LIMIT,
  validateWorkspaceOperationEventPage,
  validateWorkspaceOperationListPage,
  validateWorkspaceOperationSnapshot,
  type WorkspaceOperationEvent,
  type WorkspaceOperationListPage,
  type WorkspaceOperationSnapshot,
  type WorkspaceOperationStore,
} from "./workspace-operation-store-port.ts";

export type GetWorkspaceOperationQuery = Readonly<{
  threadId: string;
  executionId: string;
}>;

export type ListWorkspaceOperationsQuery = Readonly<{
  threadId: string;
  afterExecutionId: string | null;
  limit: number;
}>;

export type ListWorkspaceOperationEventsQuery = Readonly<{
  threadId: string;
  executionId: string;
  afterSequence: number;
  limit: number;
}>;

type WorkspaceOperationReadStore = SpaceScopedThreadStore &
  Pick<
    WorkspaceOperationStore,
    | "listWorkspaceOperationEvents"
    | "listWorkspaceOperations"
    | "loadWorkspaceOperationSnapshot"
  >;

/** Authorized read-only access to Workspace operation heads and revision journals. */
export class WorkspaceOperationQueryService {
  readonly #store: WorkspaceOperationReadStore;
  readonly #authorization: AuthorizationPort;

  constructor(dependencies: {
    store: WorkspaceOperationReadStore;
    authorization: AuthorizationPort;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
  }

  async getSnapshot(
    actor: ActorContext,
    query: GetWorkspaceOperationQuery,
  ): Promise<WorkspaceOperationSnapshot> {
    validateActor(actor);
    validateGetQuery(query);
    await this.#authorize(actor, null);
    await this.#requireVisibleThread(actor, query.threadId);
    await this.#authorize(actor, query.threadId);
    return this.#loadSnapshotAuthority(actor, query);
  }

  async #loadSnapshotAuthority(
    actor: ActorContext,
    query: GetWorkspaceOperationQuery,
  ): Promise<WorkspaceOperationSnapshot> {
    const snapshot = await this.#storeCall(() =>
      this.#store.loadWorkspaceOperationSnapshot({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: query.threadId,
        executionId: query.executionId,
      }),
    );
    if (snapshot === null) {
      throw new ApplicationError("notFound", "workspace_operation_not_found");
    }
    try {
      const validated = validateWorkspaceOperationSnapshot(snapshot);
      requireOperationScope(actor, query, validated.operation);
      return validated;
    } catch (error) {
      throw invalidStoreResult(error);
    }
  }

  async listOperations(
    actor: ActorContext,
    query: ListWorkspaceOperationsQuery,
  ): Promise<WorkspaceOperationListPage> {
    validateActor(actor);
    validateListQuery(query);
    await this.#authorize(actor, null);
    await this.#requireVisibleThread(actor, query.threadId);
    await this.#authorize(actor, query.threadId);
    const storeQuery = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: query.threadId,
      afterExecutionId: query.afterExecutionId,
      limit: query.limit,
    };
    const page = await this.#storeCall(() =>
      this.#store.listWorkspaceOperations(storeQuery),
    );
    try {
      return validateWorkspaceOperationListPage(page, storeQuery);
    } catch (error) {
      throw invalidStoreResult(error);
    }
  }

  async listEvents(
    actor: ActorContext,
    query: ListWorkspaceOperationEventsQuery,
  ): Promise<readonly WorkspaceOperationEvent[]> {
    validateActor(actor);
    validateEventQuery(query);
    await this.#authorize(actor, null);
    await this.#requireVisibleThread(actor, query.threadId);
    await this.#authorize(actor, query.threadId);
    const snapshot = await this.#loadSnapshotAuthority(actor, query);
    if (query.afterSequence > snapshot.eventSequence) {
      throw new ApplicationError(
        "validation",
        "workspace_operation_event_cursor_invalid",
      );
    }
    const storeQuery = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: query.threadId,
      executionId: query.executionId,
      afterSequence: query.afterSequence,
      limit: query.limit,
    };
    const events = await this.#storeCall(() =>
      this.#store.listWorkspaceOperationEvents(storeQuery),
    );
    try {
      return validateWorkspaceOperationEventPage(events, storeQuery);
    } catch (error) {
      throw invalidStoreResult(error);
    }
  }

  async #requireVisibleThread(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadState> {
    const thread = await this.#storeCall(() =>
      this.#store.loadThreadInSpace({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId,
      }),
    );
    if (
      thread === null ||
      thread.tenantId !== actor.tenantId ||
      thread.spaceId !== actor.spaceId ||
      thread.threadId !== threadId ||
      thread.status === "deleted"
    ) {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    try {
      validateThreadState(thread);
      return structuredClone(thread);
    } catch (error) {
      throw new ApplicationError("internal", "thread_state_invalid", {
        cause: error,
      });
    }
  }

  async #authorize(
    actor: ActorContext,
    threadId: string | null,
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action: "thread:workspace:read",
        resource: {
          kind: "thread",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId,
        },
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }

  async #storeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "workspace_operation_store_failed";
      if (code === "workspace_operation_event_cursor_invalid") {
        throw new ApplicationError("validation", code, { cause: error });
      }
      throw new ApplicationError("internal", code, { cause: error });
    }
  }
}

function validateActor(actor: ActorContext): void {
  if (!hasExactKeys(actor, ["actorId", "principalId", "spaceId", "tenantId"])) {
    throw new ApplicationError("validation", "actor_invalid");
  }
  for (const value of [
    actor.principalId,
    actor.actorId,
    actor.tenantId,
    actor.spaceId,
  ]) {
    requireOpaqueId(value, "actor_invalid");
  }
}

function validateGetQuery(query: GetWorkspaceOperationQuery): void {
  if (!hasExactKeys(query, ["executionId", "threadId"])) {
    throw new ApplicationError("validation", "workspace_query_invalid");
  }
  requireOpaqueId(query.threadId, "workspace_query_invalid");
  requireOpaqueId(query.executionId, "workspace_query_invalid");
}

function validateListQuery(query: ListWorkspaceOperationsQuery): void {
  if (!hasExactKeys(query, ["afterExecutionId", "limit", "threadId"])) {
    throw new ApplicationError("validation", "workspace_query_invalid");
  }
  requireOpaqueId(query.threadId, "workspace_query_invalid");
  if (query.afterExecutionId !== null) {
    requireOpaqueId(query.afterExecutionId, "workspace_query_invalid");
  }
  requirePageLimit(
    query.limit,
    WORKSPACE_OPERATION_LIST_PAGE_MAX_LIMIT,
    "workspace_query_invalid",
  );
}

function validateEventQuery(query: ListWorkspaceOperationEventsQuery): void {
  if (
    !hasExactKeys(query, ["afterSequence", "executionId", "limit", "threadId"])
  ) {
    throw new ApplicationError("validation", "workspace_query_invalid");
  }
  requireOpaqueId(query.threadId, "workspace_query_invalid");
  requireOpaqueId(query.executionId, "workspace_query_invalid");
  if (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0) {
    throw new ApplicationError("validation", "workspace_query_invalid");
  }
  requirePageLimit(
    query.limit,
    WORKSPACE_OPERATION_EVENT_PAGE_MAX_LIMIT,
    "workspace_query_invalid",
  );
}

function requirePageLimit(input: number, maximum: number, code: string): void {
  if (!Number.isSafeInteger(input) || input < 1 || input > maximum) {
    throw new ApplicationError("validation", code);
  }
}

function requireOperationScope(
  actor: ActorContext,
  query: GetWorkspaceOperationQuery,
  operation: WorkspaceOperationSnapshot["operation"],
): void {
  if (
    operation.tenantId !== actor.tenantId ||
    operation.spaceId !== actor.spaceId ||
    operation.threadId !== query.threadId ||
    operation.executionId !== query.executionId
  ) {
    throw new ApplicationError(
      "internal",
      "workspace_operation_store_result_invalid",
    );
  }
}

function requireOpaqueId(
  input: unknown,
  code: string,
): asserts input is string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input)
  ) {
    throw new ApplicationError("validation", code);
  }
}

function invalidStoreResult(cause: unknown): ApplicationError {
  return new ApplicationError(
    "internal",
    "workspace_operation_store_result_invalid",
    { cause: cause instanceof Error ? cause : undefined },
  );
}

function hasExactKeys(
  input: unknown,
  expected: readonly string[],
): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const actual = Object.keys(input).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}
