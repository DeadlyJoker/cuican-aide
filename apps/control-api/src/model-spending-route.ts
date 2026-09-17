import type { FastifyInstance } from "fastify";
import {
  ApplicationError,
  type ModelSpendingApplicationService,
} from "@crewon/application";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
export function registerModelSpendingRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    modelSpending?: ModelSpendingApplicationService | null;
  },
) {
  const service = () => {
    if (dependencies.modelSpending == null)
      throw new ApplicationError("internal", "model_spending_unavailable");
    return dependencies.modelSpending;
  };
  type Params = { threadId: string; goalId: string };
  const path = "/api/v1/threads/:threadId/goals/:goalId/model-spending";
  app.get<{ Params: Params }>(path, async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    return {
      account: await service().get(
        actor,
        request.params.threadId,
        request.params.goalId,
      ),
    };
  });
  app.put<{ Params: Params; Body: unknown }>(path, async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    return {
      account: await service().set(
        actor,
        request.params.threadId,
        request.params.goalId,
        request.body,
      ),
    };
  });
}
