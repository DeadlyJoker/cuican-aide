import type {
  ActiveAgentVersionCatalogResponse,
  CapabilitySummaryView,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandKind,
} from "../composer/composerSlashCommands";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_CAPABILITIES = 24;

export type ControlComposerResourceDiscovery = Readonly<{
  releaseId: string;
  slashCommands: ComposerSlashCommand[];
}>;

export async function discoverControlComposerResources(
  client: Pick<
    ControlApiClient,
    "getActiveAgentVersionCatalog" | "listActiveCapabilities"
  >,
): Promise<ControlComposerResourceDiscovery> {
  const agentCatalog = await client.getActiveAgentVersionCatalog();
  const capabilities = await collectCapabilities(client, agentCatalog);
  return {
    releaseId: agentCatalog.releaseId,
    slashCommands: capabilities.map((item) =>
      capabilityCommand(item, agentCatalog.releaseId),
    ),
  };
}

async function collectCapabilities(
  client: Pick<ControlApiClient, "listActiveCapabilities">,
  catalog: ActiveAgentVersionCatalogResponse,
): Promise<CapabilitySummaryView[]> {
  const versions = new Map(
    catalog.data.map((version) => [
      version.agentVersionId,
      version.contentDigest,
    ]),
  );
  return collectPages(
    async (query) => {
      const page = await client.listActiveCapabilities(query);
      if (page.releaseId !== catalog.releaseId) {
        throw new Error(
          "Control capability release does not match active catalog",
        );
      }
      if (
        page.data.some(
          (item) =>
            versions.get(item.agentVersionId) !== item.agentVersionDigest,
        )
      ) {
        throw new Error(
          "Control capability is outside the active AgentVersion catalog",
        );
      }
      return page;
    },
    MAX_CAPABILITIES,
    "capability",
  );
}

async function collectPages<T>(
  readPage: (query: { cursor?: string; limit: number }) => Promise<{
    data: T[];
    nextCursor: string | null;
  }>,
  maxItems: number,
  resourceName: string,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await readPage(
      cursor === undefined
        ? { limit: PAGE_SIZE }
        : { cursor, limit: PAGE_SIZE },
    );
    items.push(...page.data.slice(0, maxItems - items.length));
    if (items.length === maxItems || page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(
        `Control ${resourceName} cursor repeated during pagination`,
      );
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return items;
}

function capabilityCommand(
  capability: CapabilitySummaryView,
  releaseId: string,
): ComposerSlashCommand {
  const kind = capabilityKind(capability.name);
  return {
    id: `control:${releaseId}:${capability.agentVersionId}:${capability.name}`,
    kind,
    label: capability.name,
    meta: kind === "skill" ? "Skill" : kind === "mcp" ? "MCP" : "Tool",
    description: capability.description,
    token: `$${capability.name.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
    selection: "promptToken",
  };
}

function capabilityKind(name: string): ComposerSlashCommandKind {
  const normalized = name.toLowerCase();
  if (/^(skill:|skills[._:]|skills__)/.test(normalized)) return "skill";
  if (/^(mcp:|mcp[._:]|mcp__)/.test(normalized)) return "mcp";
  return "tool";
}
