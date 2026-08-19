import { validateThreadState, type ThreadState } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";
import type {
  SpaceScopedThreadStore,
  ThreadStore,
} from "./thread-store-port.ts";
import {
  validateWorkspaceOperationPreparationResult,
  type WorkspaceListOperationPhase,
  type WorkspaceOperationPreparationResult,
  type WorkspaceOperationStore,
} from "./workspace-operation-store-port.ts";
import { mapStoreError } from "./workspace-list-command-validation.ts";
type WorkspaceApplicationStore = ThreadStore &
  SpaceScopedThreadStore &
  WorkspaceOperationStore;
export class WorkspaceListReadCoordinator {
  readonly store: WorkspaceApplicationStore;

  constructor(store: WorkspaceApplicationStore) {
    this.store = store;
  }
  async loadReceipt(
    actor: ActorContext,
    phase: WorkspaceListOperationPhase,
    idempotency: IdempotencyDescriptor,
  ): Promise<WorkspaceOperationPreparationResult | null> {
    const result = await this.storeCall(() =>
      this.store.loadWorkspaceOperationReceipt({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        phase,
        idempotency,
      }),
    );
    if (result === null) return null;
    try {
      return validateWorkspaceOperationPreparationResult(result);
    } catch (error) {
      throw new ApplicationError(
        "internal",
        "workspace_operation_result_invalid",
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async loadThread(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadState> {
    const thread = await this.storeCall(() =>
      this.store.loadThreadInSpace({
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
    } catch (error) {
      throw new ApplicationError("internal", "thread_state_invalid", {
        cause: error,
      });
    }
    return thread;
  }

  async storeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}
