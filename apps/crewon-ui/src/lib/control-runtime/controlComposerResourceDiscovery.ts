import type { CapabilitySummaryView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandKind,
} from "../composer/composerSlashCommands";
import { readControlCapabilityCatalog } from "./controlCapabilityCatalog";

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
  const catalog = await readControlCapabilityCatalog({
    client,
    maxItems: MAX_CAPABILITIES,
    maxPages: MAX_PAGES,
    pageSize: PAGE_SIZE,
  });
  return {
    releaseId: catalog.releaseId,
    slashCommands: catalog.capabilities.map((item) =>
      capabilityCommand(item, catalog.releaseId),
    ),
  };
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
