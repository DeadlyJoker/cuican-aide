import { ControlApiClient } from "@crewon/control-client";
import type {
  PluginPackageView,
  PluginSelectionView,
  PluginSourceView,
} from "@crewon/contracts";

export const SETTINGS_PLUGIN_ID = "fixture.independent-plugin";
export const SETTINGS_PUBLISHER_ID = "fixture.approved-publisher";
export function settingsSource(serial = 1): PluginSourceView {
  return {
    sourceId: `approved:${String(serial).padStart(3, "0")}`,
    pluginId: SETTINGS_PLUGIN_ID,
    publisherId: SETTINGS_PUBLISHER_ID,
    version: `${serial}.0.0`,
    title: "独立插件",
    description: "具名 fetch 夹具的批准来源；此测试不代表真实后端安装验收。",
    packageDigest: `sha256:${serial.toString(16).padStart(64, "0")}`,
  };
}
export function settingsPackage(serial = 1): PluginPackageView {
  const source = settingsSource(serial);
  return {
    pluginId: source.pluginId,
    publisherId: source.publisherId,
    version: source.version,
    packageDigest: source.packageDigest,
    installedAt: "2026-10-03T00:00:00.000Z",
  };
}
export function settingsSelection(
  revision = 1,
  state: PluginSelectionView["state"] = "disabled",
  serial = 1,
): PluginSelectionView {
  return {
    pluginId: SETTINGS_PLUGIN_ID,
    publisherId: SETTINGS_PUBLISHER_ID,
    revision,
    state,
    selectedPackageDigest:
      state === "uninstalled" ? null : settingsPackage(serial).packageDigest,
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
}
export type SettingsRequest = Readonly<{
  path: string;
  query: URLSearchParams;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null | undefined;
}>;
export function settingsHttpError(status: number): Response {
  return Response.json(
    {
      error: {
        category: status === 409 ? "conflict" : "internal",
        code:
          status === 409
            ? "plugin_installation_revision_conflict"
            : "fixture_internal",
        requestId: "named-settings-fetch-fixture",
      },
    },
    { status },
  );
}
export function settingsInstallReceipt(
  serial: number,
  selection: PluginSelectionView,
  disposition: "committed" | "replayed" = "committed",
): Response {
  return Response.json({
    kind: "install",
    disposition,
    package: settingsPackage(serial),
    selection,
  });
}
export function settingsSelectionReceipt(
  selection: PluginSelectionView,
  projection: "applied" | "pending" | "unchanged" = "applied",
): Response {
  return Response.json({
    mutation: {
      kind: "select",
      disposition: projection === "unchanged" ? "replayed" : "committed",
      selection,
    },
    projection:
      projection === "pending"
        ? { outcome: "pending", reasonCode: "plugin_projection_pending" }
        : { outcome: projection },
  });
}
export function settingsDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function settleSettings() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Deterministic HTTP response fixture behind the actual typed Control client, not a Store/server substitute. */
export class SettingsFetchFixture {
  readonly requests: SettingsRequest[] = [];
  sources: readonly PluginSourceView[] = [settingsSource(1), settingsSource(2)];
  selections: readonly PluginSelectionView[] = [];
  packages: readonly PluginPackageView[] = [];
  onRead?: (
    request: SettingsRequest,
  ) => Response | Promise<Response> | undefined;
  onMutation: (request: SettingsRequest) => Response | Promise<Response> =
    () => {
      throw new Error("unexpected_settings_fixture_mutation");
    };
  readonly client = new ControlApiClient({
    baseUrl: "https://named-settings-fetch.test",
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
      if (request.path === "/api/v1/plugins/sources")
        return page(
          this.sources,
          request.query,
          "afterSourceId",
          (item) => item.sourceId,
          "sources",
        );
      if (request.path === "/api/v1/plugins/selections")
        return page(
          this.selections,
          request.query,
          "afterPluginId",
          (item) => item.pluginId,
          "selections",
        );
      if (request.path === `/api/v1/plugins/selections/${SETTINGS_PLUGIN_ID}`)
        return Response.json({
          selection:
            this.selections.find(
              (item) => item.pluginId === SETTINGS_PLUGIN_ID,
            ) ?? null,
        });
      if (request.path === "/api/v1/plugins/packages") {
        const pluginId = request.query.get("pluginId");
        return page(
          this.packages.filter(
            (item) => pluginId === null || item.pluginId === pluginId,
          ),
          request.query,
          "afterPackageDigest",
          (item) => item.packageDigest,
          "packages",
        );
      }
      throw new Error(`unexpected_settings_fixture_route:${request.path}`);
    },
  });
  get mutations() {
    return this.requests.filter((request) => request.method !== "GET");
  }
}

function page<T>(
  values: readonly T[],
  query: URLSearchParams,
  cursorName: string,
  key: (value: T) => string,
  field: string,
): Response {
  const after = query.get(cursorName);
  const limit = Number(query.get("limit"));
  const remaining = [...values]
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .filter((item) => after === null || key(item) > after);
  const current = remaining.slice(0, limit);
  return Response.json({
    [field]: current,
    next: remaining.length > limit ? key(current.at(-1)!) : null,
  });
}
