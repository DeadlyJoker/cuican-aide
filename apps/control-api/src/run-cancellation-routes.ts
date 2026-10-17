import type { FastifyInstance } from "fastify";
import {
  WORKFLOW_RECOVERY_CONTEXT_HEADER,
  parseRunId,
  parseCancelRunRequest,
  parseIdempotencyKey,
  type RunMutationResponse,
} from "@crewon/contracts";
import type { ControlApiDependencies } from "./control-api.ts";
import {
  assertWorkflowRecoveryContext,
  requireWorkflowRecoveryContext,
} from "./workflow-recovery-context.ts";
import { requestContext } from "./request-context.ts";
import { wakeOutbox } from "./outbox-wakeup.ts";
import { projectRun } from "./run-projection.ts";

export function registerRunCancellationRoutes(
  app: FastifyInstance,
  dependencies: Pick<
    ControlApiDependencies,
    "identity" | "outboxWakeup" | "workflowRecoveryContext"
  > & {
    application: Pick<ControlApiDependencies["application"], "transitionRun">;
  },
): void {
  for (const { path, checkContext } of [
    {
      path: "/api/v1/runs/:runId([^:]+)::cancel",
      checkContext: assertWorkflowRecoveryContext,
    },
    {
      path: "/api/v1/runs/:runId([^:]+)::cancel-guarded-v1",
      checkContext: requireWorkflowRecoveryContext,
    },
  ])
    app.post<{ Params: { runId: string }; Body: unknown }>(
      path,
      async (request, reply) => {
        const actor = await dependencies.identity.resolveActor(
          requestContext(request),
        );
        checkContext({
          context: dependencies.workflowRecoveryContext,
          actor,
          expected: request.headers[WORKFLOW_RECOVERY_CONTEXT_HEADER],
        });
        const runId = parseRunId(request.params.runId),
          body = parseCancelRunRequest(request.body),
          idempotencyKey = parseIdempotencyKey(
            request.headers["idempotency-key"],
          );
        const result = await dependencies.application.transitionRun(actor, {
          kind: "run.requestCancel",
          runId,
          expectedRevision: body.expectedRevision,
          idempotencyKey,
        });
        wakeOutbox(dependencies.outboxWakeup);
        const response: RunMutationResponse = {
          disposition: result.disposition,
          run: projectRun(result.state),
        };
        return reply.code(200).send(response);
      },
    );
}
