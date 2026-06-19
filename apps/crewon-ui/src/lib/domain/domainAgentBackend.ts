import { isUnsupportedRpcError, type AppServerClient } from "../app-server/appServer";
import { withBackendWorkspace } from "../backend/backendWorkspace";
import type { AgentConfig, LibraryItem } from "./crewonDomain";
import {
  createDefaultAgentConfig,
  createMcpInventoryAgentOption,
  createSkillAgentOption,
} from "../agent-config/agentConfigDefaults";
import { loadMcpInventory } from "./domainCollaborationBackend";
import { agentConfigRecordsToLibraryItems } from "./domainLibraryItems";
import {
  type AgentConfigWriteResult,
  writeAgentConfigFile as writeStoredAgentConfigFile,
} from "./domainPersistence";
import type { Locale } from "../i18n";

export async function writeAgentConfig(
  client: AppServerClient,
  cwd: string,
  config: AgentConfig,
): Promise<AgentConfigWriteResult> {
  const existing = await client.readAgentConfig(cwd, {
    agentId: config.agentId ?? null,
    threadId: config.threadId ?? null,
    name: config.name,
  });
  if (existing.record) {
    return client.updateAgentConfig(cwd, existing.record.filePath, config);
  }
  return writeStoredAgentConfigFile(client, cwd, config);
}

export async function writeAppAgentConfig(params: {
  client: AppServerClient | null;
  config: AgentConfig;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AgentConfigWriteResult | null> {
  const { client, config, resolveBackendCwd } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: ({ client, cwd }) => writeAgentConfig(client, cwd, config),
  });
}

export async function loadAgentLibraryItems(
  client: AppServerClient,
  cwd: string,
  locale: Locale,
): Promise<{ items: LibraryItem[] }> {
  try {
    const response = await client.listAgentConfigs(cwd);
    return {
      items: agentConfigRecordsToLibraryItems(response.data, locale),
    };
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return { items: [] };
  }
}

export async function loadAppAgentLibraryItems(params: {
  client: AppServerClient | null;
  cwd: string;
  locale: Locale;
}): Promise<{ items: LibraryItem[] }> {
  const { client, cwd, locale } = params;
  if (!client) {
    return { items: [] };
  }
  return loadAgentLibraryItems(client, cwd, locale);
}

export async function createBackendAgentConfig(
  client: AppServerClient,
  params: {
    cwd: string | null | undefined;
    locale: Locale;
    threadId?: string | null;
  },
): Promise<AgentConfig> {
  const fallback = createDefaultAgentConfig(params.locale);
  const [mcpInventory, skillsResponse, modelsResponse, permissionsResponse] =
    await Promise.all([
      loadMcpInventory(client, params.threadId ?? undefined, params.cwd),
      client.listSkills(params.cwd ?? undefined),
      client.listModels(),
      client.listPermissionProfiles(params.cwd ?? undefined),
    ]);

  const mcp = mcpInventory.servers.map((server, index) =>
    createMcpInventoryAgentOption(server, params.locale, index),
  );
  const skills = (skillsResponse.data ?? [])
    .flatMap((entry) => entry.skills)
    .map((skill, index) => createSkillAgentOption(skill, params.locale, index));
  const models = modelsResponse.data
    .map((model) => model.model)
    .filter(Boolean);
  const defaultModel =
    modelsResponse.data.find((model) => model.isDefault)?.model ?? models[0];
  const permissions = permissionsResponse.data
    .map((permission) => permission.id)
    .filter(Boolean);

  return {
    ...fallback,
    role:
      params.locale === "zh"
        ? "后端能力智能体 · 可招募"
        : "Backend-capable agent · recruitable",
    systemPrompt:
      params.locale === "zh"
        ? "你是办公室中的自定义智能体。你的模型、权限、MCP 和 Skill 来自当前 app-server。先理解目标，再列出计划，必要时调用已授权工具，并把结果沉淀为可复用交付物。"
        : "You are a custom agent in an office. Your model, permission profile, MCP connectors, and skills come from the current app-server. Understand the goal, outline a plan, use authorized tools when needed, and turn results into reusable deliverables.",
    model:
      defaultModel && models.includes(defaultModel)
        ? defaultModel
        : fallback.model,
    models: models.length > 0 ? models : fallback.models,
    permission: permissions[0] ?? fallback.permission,
    permissions: permissions.length > 0 ? permissions : fallback.permissions,
    mcp: mcp.length > 0 ? mcp : fallback.mcp,
    skills: skills.length > 0 ? skills : fallback.skills,
  };
}

export async function createAppBackendAgentConfig(params: {
  client: AppServerClient | null | undefined;
  currentCwd: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
  selectedThreadId: string | null;
}): Promise<AgentConfig> {
  const fallback = createDefaultAgentConfig(params.locale);
  if (!params.isConnected || !params.client) {
    return fallback;
  }

  const effectiveCwd = params.isDemoPreview
    ? await params.resolveBackendCwd()
    : params.currentCwd;
  const effectiveThreadId = params.isDemoPreview
    ? undefined
    : (params.selectedThreadId ?? undefined);

  return createBackendAgentConfig(params.client, {
    cwd: effectiveCwd,
    locale: params.locale,
    threadId: effectiveThreadId,
  });
}
