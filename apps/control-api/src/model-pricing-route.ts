import type { FastifyInstance } from "fastify";
import {
  ApplicationError,
  type ModelPricingApplicationService,
} from "@crewon/application";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
export function registerModelPricingRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    modelPricing?: ModelPricingApplicationService | null;
  },
) {
  const service = () => {
    if (dependencies.modelPricing == null)
      throw new ApplicationError("internal", "model_pricing_unavailable");
    return dependencies.modelPricing;
  };
  app.get<{ Params: { agentVersionId: string } }>(
    "/api/v1/agent-versions/:agentVersionId/token-pricing",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      return {
        pricing: await service().get(actor, request.params.agentVersionId),
      };
    },
  );
  app.put<{ Params: { agentVersionId: string }; Body: unknown }>(
    "/api/v1/agent-versions/:agentVersionId/token-pricing",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      return {
        pricing: await service().set(
          actor,
          request.params.agentVersionId,
          request.body,
        ),
      };
    },
  );
}
