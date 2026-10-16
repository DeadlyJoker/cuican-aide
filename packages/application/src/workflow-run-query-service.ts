import type { WorkflowRunSnapshotResponse } from "@crewon/contracts";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";

export interface WorkflowRunReadStore {
  /** Capture the frozen definition, root, nodes and children in one bounded read snapshot. */
  readWorkflowRunSnapshot(input: {
    tenantId: string;
    spaceId: string;
    runId: string;
    authorize(resource: { runId: string; threadId: string }): Promise<void>;
  }): Promise<WorkflowRunSnapshotResponse>;
}

export class WorkflowRunQueryService {
  private readonly dependencies: {
    store: WorkflowRunReadStore;
    authorization: AuthorizationPort;
  };
  constructor(dependencies: {
    store: WorkflowRunReadStore;
    authorization: AuthorizationPort;
  }) {
    this.dependencies = dependencies;
  }

  async getWorkflowRunSnapshot(
    actor: ActorContext,
    runId: string,
  ): Promise<WorkflowRunSnapshotResponse> {
    if (
      !actor ||
      Object.keys(actor).sort().join() !==
        "actorId,principalId,spaceId,tenantId" ||
      [
        actor.actorId,
        actor.principalId,
        actor.tenantId,
        actor.spaceId,
        runId,
      ].some(
        (value) =>
          typeof value !== "string" ||
          !value.trim() ||
          value.trim() !== value ||
          /[\u0000-\u001f\u007f]/u.test(value) ||
          new TextEncoder().encode(value).byteLength > 512,
      )
    )
      throw new ApplicationError("validation", "workflow_read_request_invalid");
    actor = Object.freeze({ ...actor });
    try {
      return await this.dependencies.store.readWorkflowRunSnapshot({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId,
        authorize: async (resource) => {
          for (const action of ["thread:read", "run:read"] as const) {
            const decision = await this.dependencies.authorization.authorize({
              actor,
              action,
              resource:
                action === "thread:read"
                  ? {
                      kind: "thread",
                      tenantId: actor.tenantId,
                      spaceId: actor.spaceId,
                      threadId: resource.threadId,
                    }
                  : {
                      kind: "run",
                      tenantId: actor.tenantId,
                      spaceId: actor.spaceId,
                      runId: resource.runId,
                      threadId: resource.threadId,
                    },
            });
            if (decision.outcome !== "allow")
              throw new ApplicationError(
                "authorization",
                "workflow_read_authorization_denied",
              );
          }
        },
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (
        error instanceof RunStoreError &&
        error.code === "workflow_run_not_found"
      )
        throw new ApplicationError("notFound", error.code, { cause: error });
      throw new ApplicationError("internal", "workflow_read_failed", {
        cause: error,
      });
    }
  }
}
