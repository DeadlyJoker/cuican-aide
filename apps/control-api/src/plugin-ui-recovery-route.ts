import {
  ApplicationError,
  PluginUiApplicationService,
} from "@crewon/application";
import {
  MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES,
  parsePluginControlEmptyQuery,
  parsePluginControlMountRef,
  parsePluginUiRecoveryHintsResponse,
  parsePluginUiRecoveryRequest,
  parseStagePluginUiRecoveryResponse,
} from "@crewon/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import { requestContext } from "./request-context.ts";

/** Explicit port assembly only; absent recovery has no route and no fallback to business actions. */
export function registerPluginUiRecoveryRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    service: PluginUiControlService;
  },
): void {
  const service = dependencies.service;
  if (
    service instanceof PluginUiApplicationService &&
    !service.recoveryAvailable
  )
    return;
  if (service.getRecovery === undefined && service.stageRecovery === undefined)
    return;
  if (service.getRecovery === undefined || service.stageRecovery === undefined)
    throw new Error("plugin_ui_recovery_routes_invalid");
  const get = service.getRecovery.bind(service),
    stage = service.stageRecovery.bind(service);
  const authenticated = dependencies.service.recoveryAuthenticatedRequest?.bind(
    dependencies.service,
  );
  app.get<{ Params: { mountRef: string }; Querystring: unknown }>(
    "/api/v1/plugins/ui/mounts/:mountRef/recovery",
    async (request, reply) => {
      headers(reply);
      parsePluginControlEmptyQuery(request.query);
      if (
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0") ||
        request.body !== undefined
      )
        throw new ApplicationError(
          "validation",
          "plugin_ui_recovery_get_body_invalid",
        );
      const context = requestContext(request),
        actor = await dependencies.identity.resolveActor(context);
      const input = {
        mountRef: parsePluginControlMountRef(request.params.mountRef),
      };
      const work = () => get(actor, input);
      const output =
        authenticated === undefined
          ? await work()
          : await authenticated(context, actor, undefined, work);
      return response(() => parsePluginUiRecoveryHintsResponse(output));
    },
  );
  app.post<{
    Params: { mountRef: string };
    Querystring: unknown;
    Body: unknown;
  }>(
    "/api/v1/plugins/ui/mounts/:mountRef/recovery",
    { bodyLimit: 24 * 1024 },
    async (request, reply) => {
      headers(reply);
      parsePluginControlEmptyQuery(request.query);
      if (
        request.headers["content-type"]
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new ApplicationError(
          "validation",
          "plugin_ui_recovery_content_type_invalid",
        );
      const context = requestContext(request),
        actor = await dependencies.identity.resolveActor(context);
      const body = parsePluginUiRecoveryRequest(request.body);
      const input = {
        ...body,
        mountRef: parsePluginControlMountRef(request.params.mountRef),
      };
      const work = () => stage(actor, input);
      const output =
        authenticated === undefined
          ? await work()
          : await authenticated(context, actor, undefined, work);
      return response(() => parseStagePluginUiRecoveryResponse(output, body));
    },
  );
}
function headers(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
}
function response<T>(parse: () => T): T {
  try {
    const value = parse();
    if (
      Buffer.byteLength(JSON.stringify(value)) >
      MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES
    )
      throw new Error("response_too_large");
    return value;
  } catch (error) {
    throw new ApplicationError(
      "internal",
      "plugin_ui_recovery_response_invalid",
      { cause: error },
    );
  }
}
