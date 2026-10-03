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
import { withInstalledPluginHttpRequest } from "./installed-plugin-request-owner.ts";

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
    async (request, reply): Promise<GetExtensionConfigurationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const input = {
        pluginId: parseExtensionPluginId(request.params.pluginId),
        ...parseExtensionConfigurationQuery(request.query),
      };
      const configuration = await withInstalledPluginHttpRequest(
        dependencies.extensions,
        request,
        reply,
        actor,
        () => dependencies.extensions.getConfiguration(actor, input),
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
    async (request, reply): Promise<ExtensionConfigurationMutationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseExtensionEmptyQuery(request.query);
      const input = {
        ...parseSaveExtensionConfigurationRequest(request.body),
        pluginId: parseExtensionPluginId(request.params.pluginId),
        idempotencyKey: parseExtensionIdempotencyKey(
          request.headers["idempotency-key"],
        ),
      };
      const result = await withInstalledPluginHttpRequest(
        dependencies.extensions,
        request,
        reply,
        actor,
        () => dependencies.extensions.saveConfiguration(actor, input),
      );
      return {
        disposition: result.disposition,
        configuration: projectConfiguration(result.configuration),
      };
    },
  );
  app.get<{ Params: { pluginId: string }; Querystring: unknown }>(
    "/api/v1/extensions/:pluginId/activation",
    async (request, reply): Promise<GetExtensionActivationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseExtensionEmptyQuery(request.query);
      const pluginId = parseExtensionPluginId(request.params.pluginId);
      return {
        activation: await withInstalledPluginHttpRequest(
          dependencies.extensions,
          request,
          reply,
          actor,
          () => dependencies.extensions.getActivation(actor, pluginId),
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
    async (request, reply): Promise<ExtensionActivationMutationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseExtensionEmptyQuery(request.query);
      const input = {
        ...parseSetExtensionActivationRequest(request.body),
        pluginId: parseExtensionPluginId(request.params.pluginId),
        idempotencyKey: parseExtensionIdempotencyKey(
          request.headers["idempotency-key"],
        ),
      };
      return withInstalledPluginHttpRequest(
        dependencies.extensions,
        request,
        reply,
        actor,
        () => dependencies.extensions.setActivation(actor, input),
      );
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
