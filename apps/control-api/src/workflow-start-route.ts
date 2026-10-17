import type { FastifyInstance } from "fastify";
import {
  parseStartWorkflowRunRequest,
  parseIdempotencyKey,
  WORKFLOW_RECOVERY_CONTEXT_HEADER,
  type RunMutationResponse,
  type JsonValue,
} from "@crewon/contracts";
import type { ControlApiDependencies } from "./control-api.ts";
import {
  assertWorkflowRecoveryContext,
  requireWorkflowRecoveryContext,
} from "./workflow-recovery-context.ts";
import { WorkspaceControlUnavailableError } from "./control-api-errors.ts";
import { requestContext } from "./request-context.ts";
import { projectRun } from "./run-projection.ts";
import { wakeOutbox } from "./outbox-wakeup.ts";

export function registerWorkflowStartRoute(
  app: FastifyInstance,
  dependencies: Pick<
    ControlApiDependencies,
    "identity" | "workflowRuns" | "workflowRecoveryContext" | "outboxWakeup"
  >,
): void {
  for (const { path, checkContext } of [
    {
      path: "/api/v1/workflow-runs",
      checkContext: assertWorkflowRecoveryContext,
    },
    {
      path: "/api/v1/workflow-runs:admit-v1",
      checkContext: requireWorkflowRecoveryContext,
    },
  ])
    app.post<{ Body: unknown }>(path, async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      checkContext({
        context: dependencies.workflowRecoveryContext,
        actor,
        expected: request.headers[WORKFLOW_RECOVERY_CONTEXT_HEADER],
      });
      const body = parseStartWorkflowRunRequest(request.body);
      if (dependencies.workflowRuns == null)
        throw new WorkspaceControlUnavailableError();
      const result = await dependencies.workflowRuns.startWorkflowRun(actor, {
        kind: "workflowRun.start",
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        workflowVersionId: body.workflowVersionId,
        threadId: body.threadId,
        input: body.input as JsonValue,
      });
      wakeOutbox(dependencies.outboxWakeup);
      const response: RunMutationResponse = {
        disposition: result.run.disposition,
        run: projectRun(result.run.state),
      };
      return reply
        .code(result.run.disposition === "committed" ? 201 : 200)
        .send(response);
    });
}
