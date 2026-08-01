import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { ListMcpServerStatusResponse } from "@crewon-protocol/v2/ListMcpServerStatusResponse";
import type { SkillsListResponse } from "@crewon-protocol/v2/SkillsListResponse";

import { isMissingThreadError } from "../app-server/appServer";
import { listAppsForThreadOrGlobal } from "../app-server/appServerRequests";
import type { PendingComposerMention } from "../shared/composerMentions";
import { appMentionInfo } from "../shared/composerMentions";
import { appMentionSlug, promptPreview } from "../shared/text";

type ComposerSlashCommandClient = {
  listApps(threadId?: string): Promise<AppsListResponse>;
  listMcpServerStatus(
    threadId?: string,
    detail?: "full" | "toolsAndAuthOnly",
  ): Promise<ListMcpServerStatusResponse>;
  listSkills(cwd?: string): Promise<SkillsListResponse>;
};

export type ComposerSlashCommandKind = "app" | "mcp" | "skill";

export type ComposerSlashCommand = {
  id: string;
  kind: ComposerSlashCommandKind;
  label: string;
  meta: string;
  description: string;
  token: string;
  mention: PendingComposerMention;
  execution?: {
    kind: "localMcpTool";
    serverName: string;
    toolName: string;
  };
};

export type LoadComposerSlashCommandsParams = {
  client: ComposerSlashCommandClient | null | undefined;
  cwd: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  threadId: string | null;
};

const MAX_APP_COMMANDS = 6;
const MAX_MCP_TOOL_COMMANDS = 14;
const MAX_SKILL_COMMANDS = 10;

export function mcpMentionPath(serverName: string): string {
  return `mcp://${serverName}`;
}

function slashToken(label: string): string {
  return `$${appMentionSlug(label)}`;
}

async function listMcpStatusForThreadOrGlobal(
  client: ComposerSlashCommandClient,
  threadId: string | undefined,
): Promise<ListMcpServerStatusResponse> {
  try {
    return await client.listMcpServerStatus(threadId, "full");
  } catch (error) {
    if (threadId && isMissingThreadError(error)) {
      return client.listMcpServerStatus(undefined, "full");
    }
    throw error;
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function appSlashCommands(
  response: AppsListResponse | null,
): ComposerSlashCommand[] {
  return (response?.data ?? [])
    .filter((app) => app.isAccessible && app.isEnabled)
    .slice(0, MAX_APP_COMMANDS)
    .map((app) => {
      const mention = appMentionInfo(app.id, app.name);
      return {
        id: `app:${app.id}`,
        kind: "app",
        label: app.name,
        meta: "App",
        description: app.description ?? app.pluginDisplayNames.join(", "),
        token: mention.token,
        mention: {
          name: app.name,
          path: mention.path,
        },
      };
    });
}

function mcpSlashCommands(
  response: ListMcpServerStatusResponse | null,
): ComposerSlashCommand[] {
  const commands: ComposerSlashCommand[] = [];

  for (const server of response?.data ?? []) {
    if (server.authStatus === "notLoggedIn") {
      continue;
    }
    const tools = Object.values(server.tools).filter(
      (tool): tool is NonNullable<typeof tool> => Boolean(tool),
    );

    for (const tool of tools) {
      const label = tool.title || tool.name;
      commands.push({
        id: `mcp:${server.name}:${tool.name}`,
        kind: "mcp",
        label,
        meta: `MCP · ${server.name}`,
        description:
          tool.description ||
          server.serverInfo?.description ||
          `${server.name}.${tool.name}`,
        token: slashToken(`${server.name}-${label}`),
        mention: {
          name: `${server.name}.${tool.name}`,
          path: mcpMentionPath(server.name),
        },
        execution: {
          kind: "localMcpTool",
          serverName: server.name,
          toolName: tool.name,
        },
      });
    }
  }

  return commands.slice(0, MAX_MCP_TOOL_COMMANDS);
}

function skillSlashCommands(
  response: SkillsListResponse | null,
): ComposerSlashCommand[] {
  return (response?.data ?? [])
    .flatMap((entry) => entry.skills)
    .filter((skill) => skill.enabled)
    .slice(0, MAX_SKILL_COMMANDS)
    .map((skill) => ({
      id: `skill:${skill.path}`,
      kind: "skill",
      label: skill.name,
      meta: "Skill",
      description:
        promptPreview(skill.description || skill.shortDescription || skill.path) ||
        skill.path,
      token: slashToken(skill.name),
      mention: {
        kind: "skill",
        name: skill.name,
        path: skill.path,
      },
    }));
}

export async function loadComposerSlashCommands({
  client,
  cwd,
  isConnected,
  isDemoPreview,
  threadId,
}: LoadComposerSlashCommandsParams): Promise<ComposerSlashCommand[]> {
  if (!client || !isConnected) {
    return [];
  }

  const effectiveThreadId = isDemoPreview ? undefined : (threadId ?? undefined);
  const [apps, mcp, skills] = await Promise.allSettled([
    listAppsForThreadOrGlobal(client, effectiveThreadId),
    listMcpStatusForThreadOrGlobal(client, effectiveThreadId),
    client.listSkills(cwd || undefined),
  ]);

  return [
    ...appSlashCommands(settledValue(apps) ?? null),
    ...mcpSlashCommands(settledValue(mcp)),
    ...skillSlashCommands(settledValue(skills)),
  ];
}
