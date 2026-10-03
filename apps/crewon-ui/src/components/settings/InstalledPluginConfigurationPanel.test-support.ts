import { ControlApiClient } from "@crewon/control-client";
import type {
  GetExtensionConfigurationResponse,
  SaveExtensionConfigurationRequest,
} from "@crewon/contracts";
import type { WorkflowObjectSchema } from "@crewon/domain/workflow-schema";
import {
  settingsPackage,
  settingsSelection,
  type SettingsRequest,
} from "./InstalledPluginSettings.test-support";

export const configurationTestSchema: WorkflowObjectSchema = {
  type: "object",
  properties: { organization: { type: "string", maxLength: 256, enum: null } },
  required: ["organization"],
  additionalProperties: false,
};

/** Named fetch responses exercise the actual typed client and hook, not SQL/byte authority or installed execution. */
export class ConfigurationPanelFetchFixture {
  readonly requests: SettingsRequest[] = [];
  selection = settingsSelection();
  package = settingsPackage();
  schema = configurationTestSchema;
  catalogAvailable = true;
  configuration: GetExtensionConfigurationResponse["configuration"] = null;
  onRead?: (
    request: SettingsRequest,
  ) => Response | Promise<Response> | undefined;
  onMutation: (request: SettingsRequest) => Response | Promise<Response> = (
    request,
  ) => {
    const body = request.body as SaveExtensionConfigurationRequest;
    this.configuration = this.saved(
      body.parameters,
      body.expectedRevision + 1,
      body.credentialBindings,
    );
    return Response.json({
      disposition: "created",
      configuration: this.configuration,
    });
  };
  readonly client = new ControlApiClient({
    baseUrl: "https://named-configuration-panel.test",
    origin: "https://named-settings-ui.test",
    accessToken: "named-current-actor-token",
    csrfToken: "named-current-csrf-token",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      const request: SettingsRequest = {
        path: url.pathname,
        query: url.searchParams,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: init.body === undefined ? null : JSON.parse(String(init.body)),
        signal: init.signal,
      };
      this.requests.push(request);
      if (request.method !== "GET") return this.onMutation(request);
      const intercepted = this.onRead?.(request);
      if (intercepted !== undefined) return intercepted;
      if (request.path.startsWith("/api/v1/plugins/packages/"))
        return Response.json({ package: this.package });
      if (request.path.startsWith("/api/v1/plugins/selections/"))
        return Response.json({ selection: this.selection });
      if (request.path === "/api/v1/extensions")
        return Response.json({
          extensions: this.catalogAvailable
            ? [
                {
                  pluginId: this.selection.pluginId,
                  pluginVersion: this.package.version,
                  title: "具名配置夹具",
                  description: "表单协议测试",
                  inputSchema: {
                    type: "object",
                    properties: {},
                    required: [],
                    additionalProperties: false,
                  },
                  configurationSchema: this.schema,
                  credentialSlots: [],
                  resultViews: ["text"],
                },
              ]
            : [],
        });
      if (request.path.endsWith("/configuration"))
        return Response.json({ configuration: this.configuration });
      throw new Error(`unexpected_configuration_panel_route:${request.path}`);
    },
  });
  saved(
    parameters: SaveExtensionConfigurationRequest["parameters"],
    revision = 1,
    credentialBindings: SaveExtensionConfigurationRequest["credentialBindings"] = [],
  ): NonNullable<GetExtensionConfigurationResponse["configuration"]> {
    const digest = `sha256:${"a".repeat(64)}`;
    return {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: "fixture-tenant",
      spaceId: "fixture-space",
      pluginId: this.selection.pluginId,
      pluginVersion: this.package.version,
      revision,
      manifestDigest: digest,
      implementationDigest: digest,
      contentDigest: digest,
      parameters,
      credentialBindings,
      createdByActorId: "fixture-actor",
      createdAt: "2026-10-03T00:00:00.000Z",
    };
  }
  get mutations() {
    return this.requests.filter((request) => request.method !== "GET");
  }
}
