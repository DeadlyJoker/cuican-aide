import type {
  DomainStore,
  WorkflowRunSchedulerStore,
  WorkflowSchedulerInput,
  WorkItemClaim,
} from "@crewon/application";
import type { RuntimeWorkerOutcome } from "./runtime-worker.ts";

/** Internal scheduler shared by experiments and explicitly configured PostgreSQL deployments; never enabled by default. */
export class ExperimentalWorkflowScheduler {
  readonly #store: DomainStore;
  readonly #workflow: WorkflowRunSchedulerStore;
  constructor(store: DomainStore, workflow: WorkflowRunSchedulerStore) {
    this.#store = store;
    this.#workflow = workflow;
  }

  async executeIfWorkflow(
    claim: WorkItemClaim,
    options: {
      signal: AbortSignal;
      leaseDurationMs: number;
      retryAfterMs: number;
    },
  ): Promise<RuntimeWorkerOutcome | null> {
    const run = await this.#store.loadRun({
      tenantId: claim.workItem.tenantId,
      runId: claim.workItem.runId,
    });
    if (run?.purpose !== "workflow") return null;
    const lease = {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    };
    try {
      options.signal.throwIfAborted();
      if (!run.workflowVersionBinding) throw Error("workflow_binding_missing");
      const operation = claim.workItem.payload.schedulerOperationId;
      if (typeof operation !== "string")
        throw Error("workflow_scheduler_payload_invalid");
      const input: WorkflowSchedulerInput = {
        tenantId: run.tenantId,
        runId: run.runId,
        binding: run.workflowVersionBinding,
        schedulerOperationId: operation,
        lease,
      };
      const prepared = await this.#workflow.prepareWorkflowRun(input);
      options.signal.throwIfAborted();
      if (!["completed", "failed", "canceled"].includes(prepared.status)) {
        if (prepared.cancelRequested)
          await this.#workflow.propagateWorkflowCancellation(input);
        else
          await this.#workflow.admitWorkflowNodes({
            ...input,
            leaseDurationMs: Math.min(300_000, options.leaseDurationMs),
          });
        options.signal.throwIfAborted();
      }
      const result = await this.#workflow.finishWorkflowSchedulerPass(input);
      switch (result.kind) {
        case "waiting":
          return {
            kind: "workflowWaiting",
            runId: run.runId,
            children: result.children,
            humanGates: result.humanGates,
          };
        case "ready":
          return {
            kind: "retried",
            runId: run.runId,
            code: "workflow_scheduler_ready",
          };
        case "terminal":
          if (result.run.status === "completed")
            return { kind: "completed", runId: run.runId };
          if (result.run.status === "canceled")
            return { kind: "canceled", runId: run.runId };
          return {
            kind: "failed",
            runId: run.runId,
            code: result.run.failure?.code ?? "workflow_node_failed",
          };
      }
    } catch (error) {
      const code = options.signal.aborted
        ? "workflow_scheduler_interrupted"
        : errorCode(error);
      if (code === "stale_lease" || code === "lease_expired")
        return { kind: "leaseLost", runId: run.runId };
      // Never use the ordinary model retry/cancel path: children may still have unknown effects.
      // This only updates the original queue row and leaves all committed history untouched.
      try {
        await this.#store.retryWorkItem({
          ...lease,
          retryAfterMs: Math.min(
            300_000,
            Math.max(1_000, options.retryAfterMs),
          ),
          reasonCode: code,
        });
      } catch (retryError) {
        const retryCode = errorCode(retryError);
        if (retryCode === "stale_lease" || retryCode === "lease_expired")
          return { kind: "leaseLost", runId: run.runId };
        throw retryError;
      }
      return { kind: "retried", runId: run.runId, code };
    }
  }
}

function errorCode(error: unknown): string {
  const code =
    error instanceof Error && "code" in error
      ? error.code
      : error instanceof Error
        ? error.message
        : null;
  return typeof code === "string" && /^[a-z0-9_]{1,128}$/.test(code)
    ? code
    : "workflow_scheduler_recovery_required";
}
