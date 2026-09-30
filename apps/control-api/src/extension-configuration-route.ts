import type { FastifyInstance } from "fastify";
import type { ExtensionConfigurationApplicationService } from "@crewon/application";
import {
  parseExtensionPluginId,
  parseExtensionIdempotencyKey,
  parseExtensionConfigurationQuery,
  parseExtensionEmptyQuery,
  parseSaveExtensionConfigurationRequest,
  parseSetExtensionActivationRequest,
  type ExtensionConfigurationMutationResponse,
  type ExtensionActivationMutationResponse,
  type GetExtensionConfigurationResponse,
  type GetExtensionActivationResponse,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";

/** Explicit opt-in routes; all identity still comes from the existing authenticated Control boundary. */
export function registerExtensionConfigurationRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    extensions: ExtensionConfigurationApplicationService;
  },
): void {
  app.get<{ Params: { pluginId: string }; Querystring: unknown }>(
    "/api/v1/extensions/:pluginId/configuration",
    async (request): Promise<GetExtensionConfigurationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const configuration = await dependencies.extensions.getConfiguration(
        actor,
        {
          pluginId: parseExtensionPluginId(request.params.pluginId),
          ...parseExtensionConfigurationQuery(request.query),
        },
      );
      return {
        configuration:
          configuration === null ? null : projectConfiguration(configuration),
      };
    },
  );
  app.put<{
    Params: { pluginId: string };
    Body: unknown;
    Querystring: unknown;
  }>(
    "/api/v1/extensions/:pluginId/configuration",
    async (request): Promise<ExtensionConfigurationMutationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseExtensionEmptyQuery(request.query);
      const result = await dependencies.extensions.saveConfiguration(actor, {
        ...parseSaveExtensionConfigurationRequest(request.body),
        pluginId: parseExtensionPluginId(request.params.pluginId),
        idempotencyKey: parseExtensionIdempotencyKey(
          request.headers["idempotency-key"],
        ),
      });
      return {
        disposition: result.disposition,
        configuration: projectConfiguration(result.configuration),
      };
    },
  );
  app.get<{ Params: { pluginId: string }; Querystring: unknown }>(
    "/api/v1/extensions/:pluginId/activation",
    async (request): Promise<GetExtensionActivationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseExtensionEmptyQuery(request.query);
      return {
        activation: await dependencies.extensions.getActivation(
          actor,
          parseExtensionPluginId(request.params.pluginId),
        ),
      };
    },
  );
  app.put<{
    Params: { pluginId: string };
    Body: unknown;
    Querystring: unknown;
  }>(
    "/api/v1/extensions/:pluginId/activation",
    async (request): Promise<ExtensionActivationMutationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseExtensionEmptyQuery(request.query);
      return dependencies.extensions.setActivation(actor, {
        ...parseSetExtensionActivationRequest(request.body),
        pluginId: parseExtensionPluginId(request.params.pluginId),
        idempotencyKey: parseExtensionIdempotencyKey(
          request.headers["idempotency-key"],
        ),
      });
    },
  );
}

function projectConfiguration(
  value: NonNullable<
    Awaited<
      ReturnType<ExtensionConfigurationApplicationService["getConfiguration"]>
    >
  >,
): ExtensionConfigurationMutationResponse["configuration"] {
  return {
    ...value,
    parameters: JSON.parse(JSON.stringify(value.parameters)),
    credentialBindings: value.credentialBindings.map((reference) => ({
      ...reference,
    })),
  };
}
