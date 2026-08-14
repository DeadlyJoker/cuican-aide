import type {
  ActiveAgentVersionCatalogResponse,
  CapabilitySummaryView,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

export type ControlCapabilityCatalog = Readonly<{
  capabilities: CapabilitySummaryView[];
  releaseId: string;
  truncated: boolean;
}>;

export async function readControlCapabilityCatalog(params: {
  client: Pick<
    ControlApiClient,
    "getActiveAgentVersionCatalog" | "listActiveCapabilities"
  >;
  maxItems: number;
  maxPages: number;
  pageSize: number;
}): Promise<ControlCapabilityCatalog> {
  const activeCatalog = await params.client.getActiveAgentVersionCatalog();
  return readCatalogPages(params, activeCatalog);
}

async function readCatalogPages(
  params: {
    client: Pick<ControlApiClient, "listActiveCapabilities">;
    maxItems: number;
    maxPages: number;
    pageSize: number;
  },
  activeCatalog: ActiveAgentVersionCatalogResponse,
): Promise<ControlCapabilityCatalog> {
  const activeVersions = new Map(
    activeCatalog.data.map((version) => [
      version.agentVersionId,
      version.contentDigest,
    ]),
  );
  const capabilities: CapabilitySummaryView[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;

  for (let pageIndex = 0; pageIndex < params.maxPages; pageIndex += 1) {
    const page = await params.client.listActiveCapabilities(
      cursor === undefined
        ? { limit: params.pageSize }
        : { cursor, limit: params.pageSize },
    );
    if (page.releaseId !== activeCatalog.releaseId) {
      throw new Error(
        "Control capability release does not match active catalog",
      );
    }
    if (
      page.data.some(
        (capability) =>
          activeVersions.get(capability.agentVersionId) !==
          capability.agentVersionDigest,
      )
    ) {
      throw new Error(
        "Control capability is outside the active AgentVersion catalog",
      );
    }

    const remaining = params.maxItems - capabilities.length;
    capabilities.push(...page.data.slice(0, remaining));
    truncated = page.data.length > remaining;
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Control capability cursor repeated during pagination");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (
      capabilities.length === params.maxItems ||
      pageIndex === params.maxPages - 1
    ) {
      truncated = true;
      break;
    }
  }

  return {
    capabilities,
    releaseId: activeCatalog.releaseId,
    truncated,
  };
}
