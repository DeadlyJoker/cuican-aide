import type { ExternalAgentConfigMigrationItem } from "@crewon/app-server-protocol/v2/ExternalAgentConfigMigrationItem";

import type { AgentConfig, LibraryPanel } from "../domain/crewonDomain";
import type { Locale } from "../i18n";

type ExternalAgentImportNotice = {
  text: string;
  tone: "success" | "warning";
};

export function externalAgentMigrationSummary(
  item: ExternalAgentConfigMigrationItem,
  locale: Locale,
): string {
  const details = item.details;
  const lines = [
    item.cwd
      ? `${locale === "zh" ? "范围" : "Scope"}: ${item.cwd}`
      : locale === "zh"
        ? "范围: Home"
        : "Scope: Home",
  ];

  if (!details) {
    return lines.join("\n");
  }

  const plugins = details.plugins.flatMap((plugin) =>
    plugin.pluginNames.map(
      (pluginName) => `${plugin.marketplaceName}/${pluginName}`,
    ),
  );
  const mcpServers = details.mcpServers.map((server) => server.name);
  const hooks = details.hooks.map((hook) => hook.name);
  const subagents = details.subagents.map((subagent) => subagent.name);
  const commands = details.commands.map((command) => command.name);
  const sessions = details.sessions.map(
    (session) => session.title || session.path,
  );

  if (plugins.length > 0) {
    lines.push(`Plugins: ${plugins.join(", ")}`);
  }
  if (mcpServers.length > 0) {
    lines.push(`MCP: ${mcpServers.join(", ")}`);
  }
  if (hooks.length > 0) {
    lines.push(`Hooks: ${hooks.join(", ")}`);
  }
  if (subagents.length > 0) {
    lines.push(`Subagents: ${subagents.join(", ")}`);
  }
  if (commands.length > 0) {
    lines.push(`Commands: ${commands.join(", ")}`);
  }
  if (sessions.length > 0) {
    lines.push(`Sessions: ${sessions.slice(0, 5).join(", ")}`);
  }

  return lines.join("\n");
}

export function externalAgentImportLoadingPatch(
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    body:
      locale === "zh"
        ? "正在导入 Agent 配置..."
        : "Importing agent config...",
    error: undefined,
  };
}

export function externalAgentImportLoadingPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchExternalAgentImportPanel(
    panel,
    externalAgentImportLoadingPatch(locale),
  );
}

export function importedExternalAgentConfig(params: {
  baseConfig: AgentConfig;
  item: ExternalAgentConfigMigrationItem;
  locale: Locale;
}): AgentConfig {
  const { baseConfig, item, locale } = params;
  return {
    ...baseConfig,
    name: importedExternalAgentName(item, locale),
    role:
      locale === "zh"
        ? `${item.itemType} · 可招募`
        : `${item.itemType} · recruitable`,
    systemPrompt: [
      locale === "zh"
        ? "这是从外部 Agent 配置迁移进 Crewon 的智能体。"
        : "This agent was migrated into Crewon from an external agent configuration.",
      externalAgentMigrationSummary(item, locale),
      baseConfig.systemPrompt,
    ].join("\n\n"),
  };
}

export function externalAgentImportThreadGoal(
  item: ExternalAgentConfigMigrationItem,
  locale: Locale,
): string {
  return locale === "zh"
    ? `导入外部智能体配置「${item.description}」，并作为办公室可招募角色使用。`
    : `Import external agent config "${item.description}" and make it recruitable by offices.`;
}

export function externalAgentImportTurnPrompt(params: {
  agentConfigPath: string | null | undefined;
  config: AgentConfig;
  item: ExternalAgentConfigMigrationItem;
  locale: Locale;
}): string {
  const { agentConfigPath, config, item, locale } = params;
  return [
    locale === "zh"
      ? `导入智能体：${config.name}`
      : `Import agent: ${config.name}`,
    `Source: ${item.itemType}`,
    item.cwd ? `CWD: ${item.cwd}` : "Scope: Home",
    "",
    externalAgentMigrationSummary(item, locale),
    agentConfigPath
      ? locale === "zh"
        ? `后端记录：${agentConfigPath}`
        : `Backend record: ${agentConfigPath}`
      : locale === "zh"
        ? "后端记录：已提交到 agent/create"
        : "Backend record: submitted to agent/create",
    locale === "zh"
      ? `后端智能体：${config.agentId ?? config.name}`
      : `Backend agent: ${config.agentId ?? config.name}`,
  ].join("\n");
}

export function externalAgentImportNotice(params: {
  config: AgentConfig;
  locale: Locale;
  threadCreated: boolean;
}): ExternalAgentImportNotice {
  const { config, locale, threadCreated } = params;
  return threadCreated
    ? {
        text:
          locale === "zh"
            ? `已导入并创建后端智能体：${config.name}`
            : `Imported and created backend agent: ${config.name}`,
        tone: "success",
      }
    : {
        text:
          locale === "zh"
            ? "外部配置已导入，但未创建智能体线程"
            : "External config imported, but no agent thread was created",
        tone: "warning",
      };
}

export function externalAgentImportFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "导入 Agent 配置失败"
          : "Unable to import agent config",
  };
}

export function externalAgentImportFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return patchExternalAgentImportPanel(
    panel,
    externalAgentImportFailurePatch(error, locale),
  );
}

function patchExternalAgentImportPanel(
  panel: LibraryPanel | null,
  patch: Partial<LibraryPanel>,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

function importedExternalAgentName(
  item: ExternalAgentConfigMigrationItem,
  locale: Locale,
): string {
  return locale === "zh"
    ? `导入智能体 · ${item.description}`
    : `Imported agent · ${item.description}`;
}
