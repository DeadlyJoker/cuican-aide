import { ControlApiClient } from "@crewon/control-client";
import type {
  ExtensionCatalogEntry,
  GetExtensionConfigurationResponse,
  PluginPackageView,
  PluginSelectionView,
  SaveExtensionConfigurationRequest,
} from "@crewon/contracts";

export const CONFIG_PLUGIN_ID = "fixture.configurable";
export const CONFIG_PUBLISHER_ID = "fixture.publisher";
export const CONFIG_SCHEMA = {
  type: "object",
  properties: { organization: { type: "string", maxLength: 128, enum: null } },
  required: ["organization"],
  additionalProperties: false,
} as const;
export function configurationPackage(serial = 1): PluginPackageView {
  return {
    pluginId: CONFIG_PLUGIN_ID,
    publisherId: CONFIG_PUBLISHER_ID,
    version: `${serial}.0.0`,
    packageDigest: `sha256:${String(serial).padStart(64, "0")}`,
    installedAt: "2026-10-03T00:00:00.000Z",
  };
}
export function configurationSelection(
  serial = 1,
  revision = 1,
  state: PluginSelectionView["state"] = "disabled",
): PluginSelectionView {
  return {
    pluginId: CONFIG_PLUGIN_ID,
    publisherId: CONFIG_PUBLISHER_ID,
    revision,
    state,
    selectedPackageDigest:
      state === "uninstalled"
        ? null
        : configurationPackage(serial).packageDigest,
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
}
export function configurationValue(
  revision = 1,
  pluginVersion = "1.0.0",
  parameters: SaveExtensionConfigurationRequest["parameters"] = {
    organization: "Saved",
  },
): NonNullable<GetExtensionConfigurationResponse["configuration"]> {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    schemaVersion: "crewon.extension-configuration.v0",
    tenantId: "fixture-tenant",
    spaceId: "fixture-space",
    pluginId: CONFIG_PLUGIN_ID,
    revision,
    pluginVersion,
    manifestDigest: digest,
    implementationDigest: digest,
    parameters,
    credentialBindings: [],
    createdByActorId: "named-configuration-actor",
    createdAt: "2026-10-03T00:00:00.000Z",
    contentDigest: `sha256:${revision.toString(16).padStart(64, "0")}`,
  };
}
export type ConfigurationRequest = Readonly<{
  path: string;
  method: string;
  body: unknown;
  headers: Headers;
  signal?: AbortSignal | null;
}>;
export function configurationHttpError(status: number): Response {
  return Response.json(
    {
      error: {
        category: status === 409 ? "conflict" : "internal",
        code:
          status === 409
            ? "extension_revision_conflict"
            : "named_configuration_fixture_error",
        requestId: "named-configuration-fetch-fixture",
      },
    },
    { status },
  );
}
export function configurationDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function settleConfiguration() {
  for (let index = 0; index < 100; index++) await Promise.resolve();
}

/** Named HTTP responses behind the real ControlApiClient; this is not backend or authority evidence. */
export class ConfigurationFetchFixture {
  selection = configurationSelection();
  packages = [configurationPackage(), configurationPackage(2)];
  configuration: GetExtensionConfigurationResponse["configuration"] = null;
  schema: ExtensionCatalogEntry["configurationSchema"] = CONFIG_SCHEMA;
  credentialSlots: ExtensionCatalogEntry["credentialSlots"] = [];
  readonly requests: ConfigurationRequest[] = [];
  onRead?: (
    request: ConfigurationRequest,
  ) => Response | Promise<Response> | undefined;
  onSave?: (request: ConfigurationRequest) => Response | Promise<Response>;
  readonly client = new ControlApiClient({
    baseUrl: "https://named-configuration-fetch.test",
    origin: "https://named-configuration-ui.test",
    accessToken: "named-configuration-actor-token",
    csrfToken: "named-configuration-csrf-token",
    fetch: async (input, init = {}) => {
      const request: ConfigurationRequest = {
        path: new URL(String(input)).pathname,
        method: init.method ?? "GET",
        body: init.body === undefined ? null : JSON.parse(String(init.body)),
        headers: new Headers(init.headers),
        signal: init.signal,
      };
      this.requests.push(request);
      if (request.method === "PUT")
        return this.onSave ? this.onSave(request) : this.saveResponse(request);
      const intercepted = this.onRead?.(request);
      if (intercepted !== undefined) return intercepted;
      if (request.path === `/api/v1/plugins/selections/${CONFIG_PLUGIN_ID}`)
        return Response.json({ selection: this.selection });
      if (request.path.startsWith("/api/v1/plugins/packages/"))
        return Response.json({
          package:
            this.packages.find(
              (pkg) =>
                pkg.packageDigest ===
                decodeURIComponent(request.path.split("/").at(-1)!),
            ) ?? null,
        });
      if (request.path === "/api/v1/extensions") {
        const selected = this.packages.find(
          (pkg) => pkg.packageDigest === this.selection.selectedPackageDigest,
        );
        return Response.json({
          extensions: selected
            ? [
                {
                  pluginId: CONFIG_PLUGIN_ID,
                  pluginVersion: selected.version,
                  title: "Configured independent plugin",
                  description: "Named fetch fixture, no installed Node runtime",
                  configurationSchema: this.schema,
                  inputSchema: {
                    type: "object",
                    properties: {},
                    required: [],
                    additionalProperties: false,
                  },
                  credentialSlots: this.credentialSlots,
                  resultViews: ["text"],
                },
              ]
            : [],
        });
      }
      if (
        request.path === `/api/v1/extensions/${CONFIG_PLUGIN_ID}/configuration`
      )
        return Response.json({ configuration: this.configuration });
      throw new Error(
        `unexpected_configuration_fixture_request:${request.method}:${request.path}`,
      );
    },
  });
  saveResponse(
    request: ConfigurationRequest,
    disposition: "created" | "replayed" = "created",
  ) {
    const body = request.body as SaveExtensionConfigurationRequest;
    this.configuration = configurationValue(
      body.expectedRevision + 1,
      body.pluginVersion,
      body.parameters,
    );
    return Response.json({ disposition, configuration: this.configuration });
  }
  get saves() {
    return this.requests.filter((request) => request.method === "PUT");
  }
}
