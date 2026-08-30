import type { FsGetMetadataResponse } from "@crewon/app-server-protocol/v2/FsGetMetadataResponse";

import type { NoticeState } from "../shared/noticeState";
import { fileMetadataText } from "../capability/capabilityPanelText";
import type {
  LibraryItem,
  LibraryItemAction,
  LibraryPanel,
  LibraryPanelAction,
  SkillFileAction,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { buildSkillEditPanelContent } from "../draft/draftSavePayloads";

type LibraryActionId = LibraryPanelAction["id"];
type McpOauthLoginResult = { authorizationUrl?: string | null } | null;
type PluginInstallSummary = {
  authPolicy: string;
  appsNeedingAuth: readonly unknown[];
};
type PluginSkillAction = Extract<LibraryItemAction, { type: "plugin-skill" }>;
type SkillToolRecordSummary = { filePath: string } | null;

type LibraryDraftActionId =
  | "create-office"
  | "create-agent"
  | "create-automation"
  | "create-mcp"
  | "create-skill"
  | "recruit-agent";
type DemoBackendDeferredActionId = "install-plugin" | "reload-tools";

type LibraryDraftActionPresentation = {
  body: string;
  item: LibraryItem;
};

export function isLibraryDraftAction(
  actionId: LibraryActionId,
): actionId is LibraryDraftActionId {
  return (
    actionId === "create-office" ||
    actionId === "create-agent" ||
    actionId === "create-automation" ||
    actionId === "create-mcp" ||
    actionId === "create-skill" ||
    actionId === "recruit-agent"
  );
}

export function libraryDraftActionPresentation(
  actionId: LibraryDraftActionId,
  locale: Locale,
): LibraryDraftActionPresentation {
  const title = libraryDraftActionTitle(actionId, locale);
  return {
    body:
      locale === "zh"
        ? `${title}已进入草稿状态。后端接入后这里会打开真实创建流程，现在用于展示入口、状态和下一步。`
        : `${title} is now in draft state. Once the backend is connected, this opens the real creation flow; for the demo it shows entry, status, and next step.`,
    item: {
      title,
      meta:
        locale === "zh"
          ? actionId === "recruit-agent"
            ? "待选择角色 · 可加入当前办公室"
            : "草稿 · 等待后端保存"
          : actionId === "recruit-agent"
            ? "Choose role · can join current office"
            : "Draft · waiting for backend save",
      description: libraryDraftActionDescription(actionId, locale),
    },
  };
}

export function libraryDraftActionPanel(
  panel: LibraryPanel | null,
  actionId: LibraryDraftActionId,
  locale: Locale,
): LibraryPanel | null {
  const presentation = libraryDraftActionPresentation(actionId, locale);
  return panel
    ? {
        ...panel,
        body: presentation.body,
        items: [presentation.item, ...panel.items],
        error: undefined,
      }
    : panel;
}

export function libraryDemoBackendDeferredPatch(
  actionId: DemoBackendDeferredActionId,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    body:
      actionId === "install-plugin"
        ? locale === "zh"
          ? "演示模式：市场浏览和安装会在接入后端后开启。这里展示已打包的服务与技能。"
          : "Demo mode: marketplace browse and install open once the backend is connected. Shown here are bundled MCP connectors and skills."
        : locale === "zh"
          ? "演示模式：工具列表为内置示例，接入 app-server 后会显示真实的运行态服务和技能。"
          : "Demo mode: the tool list shows built-in samples. Connect the app-server to see live MCP and skills.",
    error: undefined,
  };
}

export function libraryDemoBackendDeferredPanel(
  panel: LibraryPanel | null,
  actionId: DemoBackendDeferredActionId,
  locale: Locale,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...libraryDemoBackendDeferredPatch(actionId, locale),
      }
    : panel;
}

export function libraryActionProgressText(
  actionId: LibraryActionId,
  locale: Locale,
): string {
  switch (actionId) {
    case "install-plugin":
      return locale === "zh" ? "正在安装插件..." : "Installing plugin...";
    case "reload-tools":
      return locale === "zh" ? "正在刷新工具..." : "Refreshing tools...";
    case "reload-plugins":
      return locale === "zh" ? "正在刷新插件..." : "Refreshing plugins...";
    case "login-mcp-oauth":
      return locale === "zh"
        ? "正在打开服务授权..."
        : "Opening MCP authorization...";
    case "run-automation":
      return locale === "zh" ? "正在运行自动化..." : "Running automation...";
    case "open-knowledge-file":
      return locale === "zh"
        ? "正在读取知识文件..."
        : "Reading knowledge file...";
    case "read-mcp-resource":
      return locale === "zh"
        ? "正在读取服务资源..."
        : "Reading MCP resource...";
    case "call-mcp-tool":
      return locale === "zh" ? "正在调用服务工具..." : "Calling MCP tool...";
    case "toggle-skill":
      return locale === "zh"
        ? "正在更新技能配置..."
        : "Updating skill config...";
    case "delete-config-file":
      return locale === "zh"
        ? "正在删除后端记录..."
        : "Deleting backend record...";
    case "delete-mcp-config":
      return locale === "zh" ? "正在删除服务配置..." : "Deleting MCP config...";
    default:
      return locale === "zh" ? "正在卸载插件..." : "Uninstalling plugin...";
  }
}

export function libraryActionProgressPanel(
  panel: LibraryPanel | null,
  actionId: LibraryActionId,
  locale: Locale,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        body: libraryActionProgressText(actionId, locale),
        error: undefined,
      }
    : panel;
}

export function libraryActionFallbackErrorText(
  actionId: LibraryActionId,
  locale: Locale,
): string {
  switch (actionId) {
    case "install-plugin":
      return locale === "zh" ? "安装插件失败" : "Unable to install plugin";
    case "reload-tools":
      return locale === "zh" ? "刷新工具失败" : "Unable to refresh tools";
    case "read-mcp-resource":
      return locale === "zh"
        ? "读取服务资源失败"
        : "Unable to read MCP resource";
    case "toggle-skill":
      return locale === "zh"
        ? "更新技能配置失败"
        : "Unable to update skill config";
    default:
      return locale === "zh" ? "卸载插件失败" : "Unable to uninstall plugin";
  }
}

export function libraryActionFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  actionId: LibraryActionId,
  locale: Locale,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        error:
          error instanceof Error
            ? error.message
            : libraryActionFallbackErrorText(actionId, locale),
      }
    : panel;
}

export function libraryOpenThreadUnavailableNotice(
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? "没有可打开的后端线程"
        : "No backend thread is available to open",
    tone: "warning",
  };
}

export function libraryOpenThreadOpenedNotice(
  title: string,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? `已打开后端线程：${title}`
        : `Opened backend thread: ${title}`,
    tone: "success",
  };
}

export function libraryOpenThreadFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "打开后端线程失败"
          : "Unable to open backend thread",
    tone: "warning",
  };
}

export function knowledgeFilePanelBody({
  metadata,
  text,
  locale,
}: {
  metadata: FsGetMetadataResponse | null | undefined;
  text: string;
  locale: Locale;
}): string {
  return [
    locale === "zh"
      ? "已从 app-server 后端工作区读取知识文件。"
      : "Knowledge file loaded from the backend workspace.",
    fileMetadataText(metadata ?? null, locale),
    text.length > 16000 ? `${text.slice(0, 16000)}\n...` : text,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function knowledgeFilePanelActions(
  knowledgePath: string,
  locale: Locale,
): LibraryPanelAction[] {
  return [
    {
      id: "open-path",
      label: locale === "zh" ? "右栏打开路径" : "Open path in sidebar",
      pathToOpen: knowledgePath,
      pathKind: "file",
    },
    {
      id: "refresh-knowledge",
      label: locale === "zh" ? "返回知识库" : "Back to knowledge",
    },
  ];
}

export function knowledgeFilePanel(
  panel: LibraryPanel | null,
  params: {
    metadata: FsGetMetadataResponse | null | undefined;
    path: string;
    text: string;
    title: string;
    locale: Locale;
  },
): LibraryPanel | null {
  const { metadata, path, text, title, locale } = params;
  return panel?.knowledge
    ? {
        ...panel,
        title,
        subtitle: path,
        body: knowledgeFilePanelBody({
          metadata,
          text,
          locale,
        }),
        actions: knowledgeFilePanelActions(path, locale),
        error: undefined,
      }
    : panel;
}

export function mcpOauthLoginPanelBody(
  response: McpOauthLoginResult | undefined,
  locale: Locale,
): string {
  if (response?.authorizationUrl) {
    return `${locale === "zh" ? "打开以下链接完成服务授权" : "Open this URL to finish MCP authorization"}\n${response.authorizationUrl}`;
  }
  return locale === "zh" ? "服务授权已启动" : "MCP authorization started";
}

export function mcpOauthLoginPanel(
  panel: LibraryPanel | null,
  response: McpOauthLoginResult | undefined,
  locale: Locale,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        body: mcpOauthLoginPanelBody(response, locale),
        error: undefined,
      }
    : panel;
}

export function pluginInstallPanelBody(
  response: PluginInstallSummary | null | undefined,
  locale: Locale,
): string {
  const authSummary = response
    ? `${locale === "zh" ? "授权策略" : "Auth policy"}: ${response.authPolicy}\n${
        locale === "zh" ? "需要授权的应用" : "Apps needing auth"
      }: ${response.appsNeedingAuth.length}`
    : "";
  return [locale === "zh" ? "插件已安装" : "Plugin installed", authSummary]
    .filter(Boolean)
    .join("\n");
}

export function pluginInstallResultPanel(
  panel: LibraryPanel | null,
  response: PluginInstallSummary | null | undefined,
  locale: Locale,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        body: pluginInstallPanelBody(response, locale),
        error: undefined,
      }
    : panel;
}

export function skillToggleNoticeText({
  skillName,
  wasEnabled,
  syncedToolRecord,
  locale,
}: {
  skillName: string | null | undefined;
  wasEnabled: boolean | undefined;
  syncedToolRecord: SkillToolRecordSummary;
  locale: Locale;
}): string {
  const name = skillName ?? (locale === "zh" ? "技能" : "Skill");
  if (locale === "zh") {
    return `${name} 已${wasEnabled ? "停用" : "启用"}${
      syncedToolRecord ? `（工具记录：${syncedToolRecord.filePath}）` : ""
    }`;
  }

  return `${name} ${wasEnabled ? "disabled" : "enabled"}${
    syncedToolRecord ? ` (tool record: ${syncedToolRecord.filePath})` : ""
  }`;
}

export function skillToggleNoticeState(params: {
  skillName: string | null | undefined;
  wasEnabled: boolean | undefined;
  syncedToolRecord: SkillToolRecordSummary;
  locale: Locale;
}): NoticeState {
  return {
    text: skillToggleNoticeText(params),
    tone: "success",
  };
}

export function domainConfigDeletedNoticeState(
  path: string,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? `已删除后端记录：${path}`
        : `Deleted backend record: ${path}`,
    tone: "success",
  };
}

export function mcpConfigDeletedNoticeState(params: {
  deletedToolRecord: string | null;
  locale: Locale;
  serverName: string;
}): NoticeState {
  const { deletedToolRecord, locale, serverName } = params;
  return {
    text:
      locale === "zh"
        ? `已删除服务配置：${serverName}${
            deletedToolRecord ? `（工具库记录：${deletedToolRecord}）` : ""
          }`
        : `Deleted MCP config: ${serverName}${
            deletedToolRecord
              ? ` (tool-library record: ${deletedToolRecord})`
              : ""
          }`,
    tone: "success",
  };
}

export function skillDetailLoadingPatch(locale: Locale): Partial<LibraryPanel> {
  return {
    body: locale === "zh" ? "正在读取技能..." : "Reading skill...",
    error: undefined,
  };
}

export function skillDetailLoadingPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchLibraryPanel(panel, skillDetailLoadingPatch(locale));
}

export function skillFileDetailPatch(params: {
  action: SkillFileAction;
  body: string;
  locale: Locale;
}): Partial<LibraryPanel> {
  const { action, body, locale } = params;
  const editor = buildSkillEditPanelContent({
    body,
    locale,
    path: action.path,
    skillName: action.skillName,
  });
  return {
    title: editor.title,
    subtitle: editor.subtitle,
    body: editor.body,
    fields: editor.fields,
    actions: [
      ...(editor.actions?.filter((item) => item.id === "save-skill-edit") ??
        []),
      ...skillFileDetailActions(action, locale),
    ],
    items: [],
  };
}

export function skillFileDetailPanel(
  panel: LibraryPanel | null,
  params: {
    action: SkillFileAction;
    body: string;
    locale: Locale;
  },
): LibraryPanel | null {
  return patchLibraryPanel(panel, skillFileDetailPatch(params));
}

export function pluginSkillDetailPatch(params: {
  action: PluginSkillAction;
  contents: string | null | undefined;
  fallbackTitle: string;
  locale: Locale;
}): Partial<LibraryPanel> {
  const { contents, fallbackTitle, locale } = params;
  return {
    title: fallbackTitle,
    subtitle: locale === "zh" ? "技能详情" : "Skill details",
    body: contents ?? (locale === "zh" ? "暂无内容" : "No contents"),
  };
}

export function pluginSkillDetailPanel(
  panel: LibraryPanel | null,
  params: {
    action: PluginSkillAction;
    contents: string | null | undefined;
    fallbackTitle: string;
    locale: Locale;
  },
): LibraryPanel | null {
  return patchLibraryPanel(panel, pluginSkillDetailPatch(params));
}

export function skillDetailFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取技能失败"
          : "Unable to read skill",
  };
}

export function skillDetailFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return patchLibraryPanel(panel, skillDetailFailurePatch(error, locale));
}

function patchLibraryPanel(
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

function skillFileDetailActions(
  action: SkillFileAction,
  locale: Locale,
): LibraryPanelAction[] {
  return [
    {
      id: "open-path",
      label: locale === "zh" ? "右栏打开源文件" : "Open source in sidebar",
      pathToOpen: action.path,
      pathKind: "file",
    },
    {
      id: "toggle-skill",
      label:
        action.enabled === false
          ? locale === "zh"
            ? "启用技能"
            : "Enable skill"
          : locale === "zh"
            ? "停用技能"
            : "Disable skill",
      skillEnabled: action.enabled !== false,
      skillName: action.skillName,
      skillPath: action.path,
      skillConfigPath: action.configPath,
      tone: action.enabled === false ? "primary" : undefined,
    },
    ...(action.configPath
      ? [
          {
            id: "open-path" as const,
            label: locale === "zh" ? "打开后端记录" : "Open backend record",
            pathToOpen: action.configPath,
            pathKind: "file" as const,
          },
          {
            id: "delete-config-file" as const,
            label: locale === "zh" ? "删除后端记录" : "Delete backend record",
            pathToOpen: action.configPath,
            pathKind: "file" as const,
            domainConfigKind: "tool" as const,
            tone: "danger" as const,
          },
        ]
      : []),
  ];
}

function libraryDraftActionTitle(
  actionId: LibraryDraftActionId,
  locale: Locale,
): string {
  switch (actionId) {
    case "create-office":
      return locale === "zh" ? "新建办公室" : "New office";
    case "create-agent":
      return locale === "zh" ? "新建智能体" : "New agent";
    case "create-automation":
      return locale === "zh" ? "新建自动化" : "New automation";
    case "create-mcp":
      return locale === "zh" ? "新建服务" : "New MCP";
    case "create-skill":
      return locale === "zh" ? "新建技能" : "New Skill";
    case "recruit-agent":
      return locale === "zh" ? "招募智能体" : "Recruit agent";
  }
}

function libraryDraftActionDescription(
  actionId: LibraryDraftActionId,
  locale: Locale,
): string {
  switch (actionId) {
    case "create-office":
      return locale === "zh"
        ? "填写名称、目标、成员和默认工具后创建办公室。"
        : "Name it, set goals, members, and default tools.";
    case "create-agent":
      return locale === "zh"
        ? "配置职责、模型、权限、默认工具和可加入办公室。"
        : "Configure role, model, permissions, default tools, and offices.";
    case "create-automation":
      return locale === "zh"
        ? "选择触发器、目标办公室、执行智能体和失败通知。"
        : "Choose trigger, target office, execution agent, and failure routing.";
    case "recruit-agent":
      return locale === "zh"
        ? "选择智能体、分配职责和工具权限，然后加入群聊协作。"
        : "Pick an agent, assign responsibilities and tool permissions, then join the group chat.";
    case "create-mcp":
    case "create-skill":
      return locale === "zh"
        ? "配置名称、权限、来源和可见范围，保存后进入工具库。"
        : "Configure name, permissions, source, and visibility before saving.";
  }
}
