import { ControlApiClient } from "@crewon/control-client";
import type { PluginUiCatalogItem } from "@crewon/contracts";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import { vi } from "vitest";
import { uiLease } from "./pluginUiLoader.test-support";

export function controlUiItem(
  lease: PluginUiLease = uiLease(),
): PluginUiCatalogItem {
  return {
    descriptor: lease.descriptor,
    publicAssets: lease.publicAssets,
    selectionRevision: lease.selectionRevision,
    packageDigest: lease.packageDigest,
  };
}
export function controlUiClient(
  handler: (url: URL, init: RequestInit) => Promise<Response> | Response,
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input)), init ?? {}),
  );
  const client = new ControlApiClient({
    baseUrl: location.origin,
    accessToken: "captured-user-token",
    csrfToken: "captured-csrf-token",
    fetch,
  });
  return { client, fetch };
}
export function controlUiResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
