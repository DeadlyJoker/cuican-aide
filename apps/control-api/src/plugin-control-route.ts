import {
  ApplicationError,
  type PluginInstallationApplicationService,
  type PluginUiApplicationService,
  type ActorContext,
} from "@crewon/application";
import {
  parseGetPluginPackageResponse,
  parseGetPluginSelectionResponse,
  parseInstallPluginPackageRequest,
  parseInvokePluginUiActionRequest,
  parseInvokePluginUiActionResponse,
  parseOpenPluginUiMountRequest,
  parseOpenPluginUiMountResponse,
  parsePluginControlAssetPath,
  parsePluginControlEmptyQuery,
  parsePluginControlIdempotencyKey,
  parsePluginControlMountRef,
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
  parsePluginInstallationResponse,
  parsePluginPackageListQuery,
  parsePluginPackageListResponse,
  parsePluginSelectionListQuery,
  parsePluginSelectionListResponse,
  parsePluginSelectionResponse,
  parsePluginUiCatalogResponse,
  parsePluginSourceListQuery,
  parsePluginSourceListResponse,
  parseSelectPluginPackageRequest,
  parseValidatePluginUiMountResponse,
  type PluginPackageView,
  type PluginSelectionView,
  type PluginSourceListQuery,
  type PluginSourceListResponse,
} from "@crewon/contracts";
import type { InstalledPluginPackage, PluginSelection } from "@crewon/domain";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";

export type PluginControlRouteDependencies = Readonly<{
  identity: ControlApiIdentityPort;
  pluginInstallation?: PluginInstallationControlService | null;
  pluginSources?: PluginSourceControlService | null;
  pluginUi?: PluginUiControlService | null;
}>;

export type PluginInstallationControlService = Pick<
  PluginInstallationApplicationService,
  | "getPackage"
  | "getSelection"
  | "listPackages"
  | "listSelections"
  | "install"
  | "select"
>;
export type PluginSourceControlService = Readonly<{
  listSources(
    actor: ActorContext,
    query: PluginSourceListQuery,
  ): Promise<PluginSourceListResponse>;
}>;

export type PluginUiControlService = Pick<
  PluginUiApplicationService,
  | "catalog"
  | "openMount"
  | "validateMount"
  | "readAsset"
  | "closeMount"
  | "invoke"
>;

/** Installed packages use the existing request identity; references and metadata never authorize use. */
export function registerPluginControlRoutes(
  app: FastifyInstance,
  dependencies: PluginControlRouteDependencies,
): void {
  if (dependencies.pluginSources != null) {
    const sources = dependencies.pluginSources;
    app.get<{ Querystring: unknown }>(
      "/api/v1/plugins/sources",
      async (request, reply) => {
        pluginHeaders(reply);
        const actor = await dependencies.identity.resolveActor(
          requestContext(request),
        );
        const query = parsePluginSourceListQuery(request.query);
        const result = await sources.listSources(actor, query);
        return checkedResponse(() =>
          parsePluginSourceListResponse(result, query),
        );
      },
    );
  }
  if (dependencies.pluginInstallation != null)
    registerInstallationRoutes(app, {
      identity: dependencies.identity,
      service: dependencies.pluginInstallation,
    });
  if (dependencies.pluginUi != null)
    registerUiRoutes(app, {
      identity: dependencies.identity,
      service: dependencies.pluginUi,
    });
}

function registerInstallationRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    identity: ControlApiIdentityPort;
    service: PluginInstallationControlService;
  }>,
): void {
  app.get<{ Querystring: unknown }>(
    "/api/v1/plugins/packages",
    async (request, reply) => {
      pluginHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parsePluginPackageListQuery(request.query);
      const result = await dependencies.service.listPackages(actor, query);
      return checkedResponse(() =>
        parsePluginPackageListResponse(
          { packages: result.packages.map(projectPackage), next: result.next },
          query,
        ),
      );
    },
  );
  app.get<{ Params: { packageDigest: string }; Querystring: unknown }>(
    "/api/v1/plugins/packages/:packageDigest",
    async (request, reply) => {
      pluginHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parsePluginControlEmptyQuery(request.query);
      const query = {
        packageDigest: parsePluginControlPackageDigest(
          request.params.packageDigest,
        ),
      };
      const result = await dependencies.service.getPackage(actor, query);
      return checkedResponse(() =>
        parseGetPluginPackageResponse(
          { package: result === null ? null : projectPackage(result) },
          query,
        ),
      );
    },
  );
  app.get<{ Querystring: unknown }>(
    "/api/v1/plugins/selections",
    async (request, reply) => {
      pluginHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parsePluginSelectionListQuery(request.query);
      const result = await dependencies.service.listSelections(actor, query);
      return checkedResponse(() =>
        parsePluginSelectionListResponse(
          {
            selections: result.selections.map(projectSelection),
            next: result.next,
          },
          query,
        ),
      );
    },
  );
  app.get<{ Params: { pluginId: string }; Querystring: unknown }>(
    "/api/v1/plugins/selections/:pluginId",
    async (request, reply) => {
      pluginHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parsePluginControlEmptyQuery(request.query);
      const query = {
        pluginId: parsePluginControlPluginId(request.params.pluginId),
      };
      const result = await dependencies.service.getSelection(actor, query);
      return checkedResponse(() =>
        parseGetPluginSelectionResponse(
          { selection: result === null ? null : projectSelection(result) },
          query,
        ),
      );
    },
  );
  app.post<{ Body: unknown; Querystring: unknown }>(
    "/api/v1/plugins/installations",
    async (request, reply) => {
      pluginHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parsePluginControlEmptyQuery(request.query);
      const body = parseInstallPluginPackageRequest(request.body);
      const result = await dependencies.service.install(actor, {
        ...body,
        idempotencyKey: parsePluginControlIdempotencyKey(
          request.headers["idempotency-key"],
        ),
      });
      return checkedResponse(() =>
        parsePluginInstallationResponse(
          {
            kind: result.kind,
            disposition: result.disposition,
            package: projectPackage(result.package),
            selection: projectSelection(result.selection),
          },
          body,
        ),
      );
    },
  );
  app.put<{
    Params: { pluginId: string };
    Body: unknown;
    Querystring: unknown;
  }>("/api/v1/plugins/selections/:pluginId", async (request, reply) => {
    pluginHeaders(reply);
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    parsePluginControlEmptyQuery(request.query);
    const pluginId = parsePluginControlPluginId(request.params.pluginId);
    const body = parseSelectPluginPackageRequest(request.body);
    const result = await dependencies.service.select(actor, {
      ...body,
      pluginId,
      idempotencyKey: parsePluginControlIdempotencyKey(
        request.headers["idempotency-key"],
      ),
    });
    return checkedResponse(() =>
      parsePluginSelectionResponse(
        {
          mutation: {
            kind: result.mutation.kind,
            disposition: result.mutation.disposition,
            selection: projectSelection(result.mutation.selection),
          },
          projection: result.projection,
        },
        { pluginId, request: body },
      ),
    );
  });
}

function registerUiRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    identity: ControlApiIdentityPort;
    service: PluginUiControlService;
  }>,
): void {
  app.get<{ Querystring: unknown }>(
    "/api/v1/plugins/ui/catalog",
    async (request, reply) => {
      pluginHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parsePluginSelectionListQuery(request.query);
      const result = await dependencies.service.catalog(actor, query);
      return checkedResponse(() => parsePluginUiCatalogResponse(result, query));
    },
  );
  app.post<{ Body: unknown; Querystring: unknown }>(
    "/api/v1/plugins/ui/mounts",
    async (request, reply) => {
      pluginHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parsePluginControlEmptyQuery(request.query);
      const body = parseOpenPluginUiMountRequest(request.body);
      const lease = await dependencies.service.openMount(actor, body);
      return checkedResponse(() => parseOpenPluginUiMountResponse(lease, body));
    },
  );
  app.get<{ Params: { mountRef: string }; Querystring: unknown }>(
    "/api/v1/plugins/ui/mounts/:mountRef",
    async (request, reply) => {
      pluginHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parsePluginControlEmptyQuery(request.query);
      const query = {
        mountRef: parsePluginControlMountRef(request.params.mountRef),
      };
      const lease = await dependencies.service.validateMount(actor, query);
      return checkedResponse(() =>
        parseValidatePluginUiMountResponse(lease, query),
      );
    },
  );
  app.delete<{
    Params: { mountRef: string };
    Body: unknown;
    Querystring: unknown;
  }>("/api/v1/plugins/ui/mounts/:mountRef", async (request, reply) => {
    pluginHeaders(reply);
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    parsePluginControlEmptyQuery(request.query);
    if (request.body !== undefined && request.body !== null)
      parsePluginControlEmptyQuery(request.body);
    const mountRef = parsePluginControlMountRef(request.params.mountRef);
    try {
      await dependencies.service.closeMount(actor, { mountRef });
    } catch (error) {
      // Closing an absent reference is complete for this caller; foreign owners remain untouched.
      if (
        !(error instanceof ApplicationError) ||
        error.category !== "notFound" ||
        error.code !== "plugin_ui_mount_unavailable"
      )
        throw error;
    }
    return { closed: true as const };
  });
  app.post<{
    Params: { mountRef: string };
    Body: unknown;
    Querystring: unknown;
  }>("/api/v1/plugins/ui/mounts/:mountRef/actions", async (request, reply) => {
    pluginHeaders(reply);
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    parsePluginControlEmptyQuery(request.query);
    const output = await dependencies.service.invoke(actor, {
      ...parseInvokePluginUiActionRequest(request.body),
      mountRef: parsePluginControlMountRef(request.params.mountRef),
    });
    return checkedResponse(() => parseInvokePluginUiActionResponse({ output }));
  });
  app.get<{
    Params: { "mountRef": string; "*": string };
    Querystring: unknown;
  }>("/api/v1/plugins/ui/mounts/:mountRef/assets/*", async (request, reply) => {
    pluginHeaders(reply);
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    parsePluginControlEmptyQuery(request.query);
    const asset = await dependencies.service.readAsset(actor, {
      mountRef: parsePluginControlMountRef(request.params.mountRef),
      path: parsePluginControlAssetPath(request.params["*"]),
    });
    return reply.type(asset.contentType).send(Buffer.from(asset.bytes));
  });
}

function projectPackage(value: InstalledPluginPackage): PluginPackageView {
  return {
    pluginId: value.pluginId,
    version: value.version,
    publisherId: value.publisherId,
    packageDigest: value.packageDigest,
    installedAt: value.installedAt,
  };
}
function projectSelection(value: PluginSelection): PluginSelectionView {
  return {
    pluginId: value.pluginId,
    publisherId: value.publisherId,
    revision: value.revision,
    state: value.state,
    selectedPackageDigest: value.selectedPackageDigest,
    updatedAt: value.updatedAt,
  };
}
function pluginHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
  reply.header("cross-origin-resource-policy", "same-origin");
}
function checkedResponse<T>(read: () => T): T {
  try {
    return read();
  } catch (cause) {
    throw new ApplicationError("internal", "plugin_control_response_invalid", {
      cause,
    });
  }
}
