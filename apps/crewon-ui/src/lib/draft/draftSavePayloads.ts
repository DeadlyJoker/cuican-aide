import type { JsonValue } from "@crewon-ui-model/serde_json/JsonValue";

import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  LibraryPanelField,
  ToolConfig,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { slugifySkillName } from "../shared/text";

type DraftPayloadResult<TPayload> =
  | { type: "ok"; payload: TPayload }
  | { type: "error"; message: string };

type McpDraftPayload = {
  serverName: string;
  serverConfig: Record<string, JsonValue>;
  toolRecord: ToolConfig;
};

type SkillDraftPayload = {
  cwd: string;
  name: string;
  description: string;
  body: string;
};

type ToolRecordSaveSummary = {
  filePath: string;
  operation: "created" | "updated";
};

type DraftPanelContent = Pick<
  LibraryPanel,
  "actions" | "body" | "error" | "fields" | "items" | "subtitle" | "title"
>;

export function draftTimestampName(prefix: string, timestamp: string): string {
  return slugifySkillName(`${prefix}-${timestamp}`);
}

export function buildMcpDraftPanelContent(params: {
  config?: Record<string, JsonValue>;
  description?: string;
  locale: Locale;
  mode?: "create" | "edit";
  serverName: string;
  sourceUrl?: string;
}): DraftPanelContent {
  const {
    config = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
      enabled: false,
    },
    description,
    locale,
    mode = "create",
    serverName,
    sourceUrl,
  } = params;
  const editing = mode === "edit";
  return {
    title:
      locale === "zh"
        ? editing
          ? `编辑服务 · ${serverName}`
          : "添加服务"
        : editing
          ? `Edit MCP · ${serverName}`
          : "Add MCP service",
    subtitle:
      locale === "zh"
        ? "保存后写入 config.toml 并重载服务"
        : "Saved to config.toml and reloaded",
    body: [
      description ||
        (locale === "zh"
          ? "编辑标准服务配置（MCP）。命令型服务填写 command/args/env，远程服务填写 url；默认保持停用，确认配置后再启用。"
          : "Edit standard MCP config. Use command/args/env for stdio or url for remote servers; presets stay disabled until reviewed."),
      sourceUrl
        ? `${locale === "zh" ? "配置来源" : "Config source"}: ${sourceUrl}`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    fields: [
      {
        id: "mcp-draft-name",
        label: locale === "zh" ? "服务名称" : "MCP name",
        value: serverName,
      },
      {
        id: "mcp-draft-config",
        label:
          locale === "zh"
            ? "服务配置 JSON（MCP，环境变量值会写入本机配置）"
            : "MCP config JSON (environment values are stored locally)",
        placeholder:
          '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-everything"],\n  "enabled": false\n}',
        value: JSON.stringify(config, null, 2),
      },
    ],
    actions: [
      {
        id: editing ? "save-mcp-config" : "save-mcp-draft",
        label:
          locale === "zh"
            ? editing
              ? "保存更改"
              : "添加服务"
            : editing
              ? "Save changes"
              : "Add MCP",
        tone: "primary",
      },
      {
        id: "reload-tools",
        label: locale === "zh" ? "返回并刷新工具" : "Back and refresh tools",
      },
    ],
    items: [],
    error: undefined,
  };
}

export function buildMcpDraftPanel(
  panel: LibraryPanel | null,
  params: {
    config?: Record<string, JsonValue>;
    description?: string;
    locale: Locale;
    mode?: "create" | "edit";
    serverName: string;
    sourceUrl?: string;
  },
): LibraryPanel | null {
  const content = buildMcpDraftPanelContent(params);
  return panel
    ? patchDraftPanel(panel, content)
    : { kind: "tools", ...content };
}

export function buildSkillDraftPanelContent(params: {
  cwd: string;
  description?: string;
  locale: Locale;
  skillName: string;
  workflow?: string;
}): DraftPanelContent {
  const { cwd, description, locale, skillName, workflow } = params;
  return {
    title: locale === "zh" ? "新建技能" : "New Skill",
    subtitle:
      locale === "zh"
        ? `${cwd} · 保存到 .crewon/skill`
        : `${cwd} · saved to .crewon/skill`,
    body:
      locale === "zh"
        ? "填写技能名称、描述和工作流步骤。保存后会写入 SKILL.md 并注册技能目录。"
        : "Fill in the skill name, description, and workflow steps. Saving writes SKILL.md and registers the skill root.",
    fields: [
      {
        id: "skill-draft-name",
        label: locale === "zh" ? "技能名称" : "Skill name",
        value: skillName,
      },
      {
        id: "skill-draft-description",
        label: locale === "zh" ? "描述" : "Description",
        value:
          description ??
          (locale === "zh"
            ? "从 CrewON 创建的可复用工作流。"
            : "A reusable workflow created from CrewON."),
      },
      {
        id: "skill-draft-workflow",
        label: locale === "zh" ? "工作流步骤" : "Workflow steps",
        value:
          workflow ??
          (locale === "zh"
            ? "- 确认目标产物和受众。\n- 收集当前应用状态和后端证据。\n- 输出简洁结果和验证记录。"
            : "- Confirm the target deliverable and audience.\n- Gather the current app state and backend evidence.\n- Produce a concise result with verification notes."),
      },
    ],
    actions: [
      {
        id: "save-skill-draft",
        label: locale === "zh" ? "保存技能" : "Save Skill",
        tone: "primary",
      },
      {
        id: "reload-tools",
        label: locale === "zh" ? "返回并刷新工具" : "Back and refresh tools",
      },
    ],
    items: [],
    error: undefined,
  };
}

export function buildSkillDraftPanel(
  panel: LibraryPanel | null,
  params: {
    cwd: string;
    description?: string;
    locale: Locale;
    skillName: string;
    workflow?: string;
  },
): LibraryPanel | null {
  const content = buildSkillDraftPanelContent(params);
  return panel
    ? patchDraftPanel(panel, content)
    : { kind: "tools", ...content };
}

export function skillDraftMissingWorkspaceMessage(locale: Locale): string {
  return locale === "zh"
    ? "当前没有工作区路径，无法创建技能"
    : "No workspace path is available for creating a skill";
}

export function skillDraftMissingWorkspacePanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchDraftPanel(panel, {
    error: skillDraftMissingWorkspaceMessage(locale),
  });
}

export function buildMcpDraftPayload(
  fields: LibraryPanelField[] | null | undefined,
  locale: Locale,
): DraftPayloadResult<McpDraftPayload> {
  const rawName = panelFieldValue(fields, "mcp-draft-name");
  const serverName = slugifySkillName(rawName);
  const rawConfig = panelFieldValue(fields, "mcp-draft-config");

  if (!serverName || !rawConfig) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "服务名称和配置不能为空"
          : "MCP name and config are required",
    };
  }

  let config: unknown;
  try {
    config = JSON.parse(rawConfig);
  } catch (error) {
    return {
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : locale === "zh"
            ? "服务配置 JSON 无效"
            : "MCP config JSON is invalid",
    };
  }

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "服务配置必须是 JSON 对象"
          : "MCP config must be a JSON object",
    };
  }

  const serverConfig = config as Record<string, JsonValue>;
  const placeholders = JSON.stringify(serverConfig).match(/<[^<>]+>/g) ?? [];
  if (placeholders.length > 0) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? `请先替换服务配置占位符：${[...new Set(placeholders)].join("、")}`
          : `Replace MCP config placeholders first: ${[
              ...new Set(placeholders),
            ].join(", ")}`,
    };
  }
  const command =
    typeof serverConfig.command === "string" ? serverConfig.command : "";
  const url = typeof serverConfig.url === "string" ? serverConfig.url : "";
  const args = serverConfig.args;
  const env = serverConfig.env;
  if (!command && !url) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "服务配置必须包含 command 或 url"
          : "MCP config must include command or url",
    };
  }
  if (
    args &&
    (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
  ) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "args 必须是字符串数组"
          : "args must be an array of strings",
    };
  }
  if (
    env &&
    (typeof env !== "object" ||
      Array.isArray(env) ||
      !Object.values(env).every((value) => typeof value === "string"))
  ) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "env 必须是字符串键值对象"
          : "env must be an object of string values",
    };
  }

  const parsedArgs = (args ?? []) as string[];
  const parsedEnv = (env ?? {}) as Record<string, string>;
  const enabled = serverConfig.enabled === true;
  const bearerTokenEnvVar =
    typeof serverConfig.bearer_token_env_var === "string"
      ? serverConfig.bearer_token_env_var
      : undefined;
  return {
    type: "ok",
    payload: {
      serverName,
      serverConfig,
      toolRecord: {
        kind: "mcp",
        title: serverName,
        name: serverName,
        description:
          locale === "zh"
            ? `服务配置（MCP）：${command || url}`
            : `MCP service config: ${command || url}`,
        command: command || undefined,
        url: url || undefined,
        args: parsedArgs.length > 0 ? parsedArgs : undefined,
        env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
        bearerTokenEnvVar,
        enabled,
      },
    },
  };
}

export function buildSkillEditPanelContent(params: {
  body: string;
  locale: Locale;
  path: string;
  skillName: string;
}): DraftPanelContent {
  const { body, locale, path, skillName } = params;
  return {
    title:
      locale === "zh" ? `编辑技能 · ${skillName}` : `Edit Skill · ${skillName}`,
    subtitle: path,
    body:
      locale === "zh"
        ? "直接编辑 SKILL.md。保存后会写回原文件并刷新能力库。"
        : "Edit SKILL.md directly. Saving writes the original file and refreshes the library.",
    fields: [
      {
        id: "skill-edit-body",
        label: "SKILL.md",
        value: body,
      },
    ],
    actions: [
      {
        id: "save-skill-edit",
        label: locale === "zh" ? "保存更改" : "Save changes",
        skillName,
        skillPath: path,
        tone: "primary",
      },
      {
        id: "reload-tools",
        label: locale === "zh" ? "取消并返回" : "Cancel and return",
      },
    ],
    items: [],
    error: undefined,
  };
}

export function draftPayloadErrorPanel(
  panel: LibraryPanel | null,
  message: string,
): LibraryPanel | null {
  return patchDraftPanel(panel, { error: message });
}

export function mcpDraftSavingPanel(
  panel: LibraryPanel | null,
  serverName: string,
  locale: Locale,
): LibraryPanel | null {
  return patchDraftPanel(panel, {
    body:
      locale === "zh"
        ? `正在保存服务配置：${serverName}`
        : `Saving MCP config: ${serverName}`,
    error: undefined,
  });
}

export function mcpDraftSavedNotice(params: {
  locale: Locale;
  serverName: string;
  toolRecord: ToolRecordSaveSummary;
}): NoticeState {
  const { locale, serverName, toolRecord } = params;
  return {
    text:
      locale === "zh"
        ? `${toolRecord.operation === "updated" ? "已更新" : "已添加"}服务：${serverName}（配置记录：${toolRecord.filePath}）`
        : `${toolRecord.operation === "updated" ? "Updated" : "Added"} MCP: ${serverName} (config record: ${toolRecord.filePath})`,
    tone: "success",
  };
}

export function buildSkillDraftPayload(
  fields: LibraryPanelField[] | null | undefined,
  cwd: string | null | undefined,
  locale: Locale,
): DraftPayloadResult<SkillDraftPayload> {
  const name = slugifySkillName(panelFieldValue(fields, "skill-draft-name"));
  const description = panelFieldValue(fields, "skill-draft-description");
  const workflow = panelFieldValue(fields, "skill-draft-workflow");

  if (!cwd || !name || !description || !workflow) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "工作区、名称、描述和工作流步骤都不能为空"
          : "Workspace, name, description, and workflow steps are required",
    };
  }

  return {
    type: "ok",
    payload: {
      cwd,
      name,
      description,
      body: [
        `# ${name}`,
        "",
        description,
        "",
        "## Workflow",
        workflow,
        "",
      ].join("\n"),
    },
  };
}

export function skillDraftSavingPanel(
  panel: LibraryPanel | null,
  skillName: string,
  locale: Locale,
): LibraryPanel | null {
  return patchDraftPanel(panel, {
    body:
      locale === "zh"
        ? `正在写入技能：${skillName}`
        : `Writing skill: ${skillName}`,
    error: undefined,
  });
}

export function skillDraftSavedNotice(params: {
  locale: Locale;
  skillName: string;
  toolRecord: ToolRecordSaveSummary;
}): NoticeState {
  const { locale, skillName, toolRecord } = params;
  return {
    text:
      locale === "zh"
        ? `${toolRecord.operation === "updated" ? "已更新" : "已保存"}技能：${skillName}（后端记录：${toolRecord.filePath}）`
        : `${toolRecord.operation === "updated" ? "Updated" : "Saved"} skill: ${skillName} (backend record: ${toolRecord.filePath})`,
    tone: "success",
  };
}

function panelFieldValue(
  fields: LibraryPanelField[] | null | undefined,
  fieldId: string,
): string {
  return fields?.find((field) => field.id === fieldId)?.value.trim() ?? "";
}

function patchDraftPanel(
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
