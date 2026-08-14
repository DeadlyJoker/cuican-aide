import type { CapabilitySummaryView, KnowledgeView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandKind,
} from "../composer/composerSlashCommands";
import { readControlCapabilityCatalog } from "./controlCapabilityCatalog";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_CAPABILITIES = 24;
const MAX_KNOWLEDGE_REFERENCES = 4;

export type ControlKnowledgeSelection = Readonly<{
  reference: Readonly<{
    contentDigest: string;
    knowledgeId: string;
  }>;
  sourceId: string;
  title: string;
}>;

export type ControlComposerResourceDiscovery = Readonly<{
  releaseId: string;
  knowledgeSelections: ControlKnowledgeSelection[];
  slashCommands: ComposerSlashCommand[];
}>;

export async function discoverControlComposerResources(
  client: Pick<
    ControlApiClient,
    "getActiveAgentVersionCatalog" | "listActiveCapabilities" | "listKnowledge"
  >,
): Promise<ControlComposerResourceDiscovery> {
  const [catalog, knowledge] = await Promise.all([
    readControlCapabilityCatalog({
      client,
      maxItems: MAX_CAPABILITIES,
      maxPages: MAX_PAGES,
      pageSize: PAGE_SIZE,
    }),
    collectKnowledge(client).catch(() => []),
  ]);
  return {
    releaseId: catalog.releaseId,
    knowledgeSelections: knowledge.map(knowledgeSelection),
    slashCommands: catalog.capabilities.map((item) =>
      capabilityCommand(item, catalog.releaseId),
    ),
  };
}

async function collectKnowledge(
  client: Pick<ControlApiClient, "listKnowledge">,
): Promise<KnowledgeView[]> {
  return collectPages(
    (query) => client.listKnowledge(query),
    MAX_KNOWLEDGE_REFERENCES,
    "Knowledge",
  );
}

function knowledgeSelection(item: KnowledgeView): ControlKnowledgeSelection {
  return {
    reference: {
      contentDigest: item.contentDigest,
      knowledgeId: item.knowledgeId,
    },
    sourceId: item.sourceId,
    title: item.title,
  };
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
