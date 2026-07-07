import type { NoticeState } from "../shared/noticeState";
import type { LibraryPanel, LibraryPanelField, ToolConfig } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { slugifySkillName } from "../shared/text";

type DraftPayloadResult<TPayload> =
  | { type: "ok"; payload: TPayload }
  | { type: "error"; message: string };

type McpDraftPayload = {
  serverName: string;
  serverConfig: {
    command: string;
    args: string[];
    env: Record<string, string>;
    enabled: false;
  };
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
  locale: Locale;
  serverName: string;
}): DraftPanelContent {
  const { locale, serverName } = params;
  return {
    title: locale === "zh" ? "新建 MCP" : "New MCP",
    subtitle:
      locale === "zh"
        ? "草稿 · 保存后写入 config.toml"
        : "Draft · saved to config.toml",
    body:
      locale === "zh"
        ? "填写 MCP server 名称、启动命令和参数。保存后会写入 MCP 配置并重载 MCP。"
        : "Fill in the MCP server name, command, and arguments. Saving writes MCP config and reloads MCP.",
    fields: [
      {
        id: "mcp-draft-name",
        label: locale === "zh" ? "服务器名称" : "Server name",
        value: serverName,
      },
      {
        id: "mcp-draft-command",
        label: locale === "zh" ? "启动命令" : "Command",
        value: "npx",
      },
      {
        id: "mcp-draft-args",
        label: locale === "zh" ? "参数 JSON 数组" : "Arguments JSON array",
        placeholder: '["-y", "@modelcontextprotocol/server-everything"]',
        value: '[\n  "-y",\n  "@modelcontextprotocol/server-everything"\n]',
      },
      {
        id: "mcp-draft-env",
        label: locale === "zh" ? "环境变量 JSON" : "Environment JSON",
        placeholder: "{\n}",
        value: "{}",
      },
    ],
    actions: [
      {
        id: "save-mcp-draft",
        label: locale === "zh" ? "保存 MCP" : "Save MCP",
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
    locale: Locale;
    serverName: string;
  },
): LibraryPanel | null {
  return patchDraftPanel(panel, buildMcpDraftPanelContent(params));
}

export function buildSkillDraftPanelContent(params: {
  cwd: string;
  locale: Locale;
  skillName: string;
}): DraftPanelContent {
  const { cwd, locale, skillName } = params;
  return {
    title: locale === "zh" ? "新建 Skill" : "New Skill",
    subtitle:
      locale === "zh"
        ? `${cwd} · 保存到 .crewon/skill`
        : `${cwd} · saved to .crewon/skill`,
    body:
      locale === "zh"
        ? "填写 Skill 名称、描述和工作流步骤。保存后会写入 SKILL.md 并注册 Skill root。"
        : "Fill in the skill name, description, and workflow steps. Saving writes SKILL.md and registers the skill root.",
    fields: [
      {
        id: "skill-draft-name",
        label: locale === "zh" ? "Skill 名称" : "Skill name",
        value: skillName,
      },
      {
        id: "skill-draft-description",
        label: locale === "zh" ? "描述" : "Description",
        value:
          locale === "zh"
            ? "从 Crewon UI 创建的可复用工作流。"
            : "A reusable workflow created from the Crewon UI.",
      },
      {
        id: "skill-draft-workflow",
        label: locale === "zh" ? "工作流步骤" : "Workflow steps",
        value:
          locale === "zh"
            ? "- 确认目标产物和受众。\n- 收集当前应用状态和后端证据。\n- 输出简洁结果和验证记录。"
            : "- Confirm the target deliverable and audience.\n- Gather the current app state and backend evidence.\n- Produce a concise result with verification notes.",
      },
    ],
    actions: [
      {
        id: "save-skill-draft",
        label: locale === "zh" ? "保存 Skill" : "Save Skill",
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
    locale: Locale;
    skillName: string;
  },
): LibraryPanel | null {
  return patchDraftPanel(panel, buildSkillDraftPanelContent(params));
}

export function skillDraftMissingWorkspaceMessage(locale: Locale): string {
  return locale === "zh"
    ? "当前没有工作区路径，无法创建本地 Skill"
    : "No workspace path is available for creating a local skill";
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
  const command = panelFieldValue(fields, "mcp-draft-command");
  const rawArgs = panelFieldValue(fields, "mcp-draft-args") || "[]";
  const rawEnv = panelFieldValue(fields, "mcp-draft-env") || "{}";

  if (!serverName || !command) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "服务器名称和启动命令不能为空"
          : "Server name and command are required",
    };
  }

  let args: unknown;
  let env: unknown;
  try {
    args = JSON.parse(rawArgs);
    env = JSON.parse(rawEnv);
  } catch (error) {
    return {
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : locale === "zh"
            ? "参数或环境变量 JSON 无效"
            : "Arguments or environment JSON is invalid",
    };
  }

  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "参数必须是字符串数组"
          : "Arguments must be an array of strings",
    };
  }

  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    !Object.values(env).every((value) => typeof value === "string")
  ) {
    return {
      type: "error",
      message:
        locale === "zh"
          ? "环境变量必须是字符串键值对象"
          : "Environment must be an object of string values",
    };
  }

  const parsedEnv = env as Record<string, string>;
  return {
    type: "ok",
    payload: {
      serverName,
      serverConfig: {
        command,
        args,
        env: parsedEnv,
        enabled: false,
      },
      toolRecord: {
        kind: "mcp",
        title: serverName,
        name: serverName,
        description:
          locale === "zh"
            ? "从 Crewon UI 创建的 MCP 草稿。"
            : "MCP draft created from the Crewon UI.",
        command,
        args,
        env: parsedEnv,
        enabled: false,
      },
    },
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
        ? `正在保存 MCP 配置：${serverName}`
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
        ? `${toolRecord.operation === "updated" ? "已更新" : "已保存"} MCP 草稿：${serverName}（后端记录：${toolRecord.filePath}）`
        : `${toolRecord.operation === "updated" ? "Updated" : "Saved"} MCP draft: ${serverName} (backend record: ${toolRecord.filePath})`,
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
      body: [`# ${name}`, "", description, "", "## Workflow", workflow, ""].join(
        "\n",
      ),
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
        ? `正在写入 Skill：${skillName}`
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
        ? `${toolRecord.operation === "updated" ? "已更新" : "已保存"} Skill：${skillName}（后端记录：${toolRecord.filePath}）`
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
