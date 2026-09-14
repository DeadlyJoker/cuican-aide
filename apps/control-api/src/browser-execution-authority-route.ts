import type { FastifyInstance } from "fastify";
import type { RunApplicationService } from "@crewon/application";
import {
  ContractValidationError,
  parseBrowserExecutionAuthorityResponse,
  parseRunId,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";

/** Returns authorized Run facts without changing the existing public Run projection. */
export function registerBrowserExecutionAuthorityRoute(
  app: FastifyInstance,
  dependencies: {
    application: Pick<RunApplicationService, "getRun">;
    identity: ControlApiIdentityPort;
  },
): void {
  app.get<{ Params: { runId: string } }>(
    "/api/v1/runs/:runId/browser-execution-authority",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      if (
        !request.query ||
        typeof request.query !== "object" ||
        Array.isArray(request.query) ||
        Object.keys(request.query).length !== 0
      )
        throw new ContractValidationError(
          "browser_execution_authority_query_invalid",
        );
      const runId = parseRunId(request.params.runId);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId))
        throw new ContractValidationError(
          "browser_execution_authority_run_id_invalid",
        );
      const state = await dependencies.application.getRun(actor, runId);
      return parseBrowserExecutionAuthorityResponse(
        {
          schemaVersion: "crewon.browser-execution-authority.v1",
          runId: state.runId,
          threadId: state.threadId,
          workspaceBindingId: state.workspaceBindingId,
          status: state.status,
          cancelRequested: state.cancelRequested,
          revision: state.revision,
        },
        runId,
      );
    },
  );
}
