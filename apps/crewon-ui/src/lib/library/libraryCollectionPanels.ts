import type { ExternalAgentConfigMigrationItem } from "@crewon-protocol/v2/ExternalAgentConfigMigrationItem";

import type {
  KnowledgeData,
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
  LibraryKind,
} from "../domain/crewonDomain";
import { externalAgentMigrationSummary } from "../external-agent/externalAgentMigrationText";
import type { Locale } from "../i18n";
import { libraryTitle } from "./libraryPanelFormatters";

export type LibraryCollectionContent = Pick<
  LibraryPanel,
  "actions" | "body" | "error" | "items" | "subtitle"
>;

export function libraryLoadingPanel(
  kind: LibraryKind,
  locale: Locale,
): LibraryPanel {
  return {
    kind,
    title: libraryTitle(kind, locale),
    subtitle:
      locale === "zh"
        ? "正在读取本地 app-server..."
        : "Reading from local app-server...",
    items: [],
  };
}

export function libraryDisconnectedPanel(
  kind: LibraryKind,
  connectionHint: string,
  locale: Locale,
): LibraryPanel {
  return {
    kind,
    title: libraryTitle(kind, locale),
    subtitle: connectionHint,
    items: [],
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function libraryCollectionPanel(
  kind: LibraryKind,
  content: LibraryCollectionContent,
  locale: Locale,
): LibraryPanel {
  return {
    kind,
    title: libraryTitle(kind, locale),
    ...content,
  };
}

export function knowledgeLibraryPanel(
  knowledge: KnowledgeData,
  locale: Locale,
): LibraryPanel {
  return {
    kind: "knowledge",
    title: libraryTitle("knowledge", locale),
    subtitle:
      locale === "zh"
        ? `${knowledge.memories.length} 条记忆 · ${knowledge.sources.length} 个知识源`
        : `${knowledge.memories.length} memories · ${knowledge.sources.length} sources`,
    items: [],
    knowledge,
    error:
      knowledge.memories.length === 0 && knowledge.sources.length === 0
        ? locale === "zh"
          ? "当前没有工作区路径，无法读取知识库。"
          : "No workspace path is available for reading knowledge."
        : undefined,
  };
}

export function libraryLoadFailurePanel(
  kind: LibraryKind,
  error: unknown,
  locale: Locale,
): LibraryPanel {
  return {
    kind,
    title: libraryTitle(kind, locale),
    subtitle: locale === "zh" ? "读取失败" : "Unable to load",
    items: [],
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取失败"
          : "Unable to load",
  };
}

export function backendOfficeCollectionContent(params: {
  items: LibraryItem[];
  listUnsupported: boolean;
  locale: Locale;
}): LibraryCollectionContent {
  const { items, listUnsupported, locale } = params;
  return {
    subtitle:
      locale === "zh"
        ? `${items.length} 个办公室`
        : items.length === 1
          ? "1 office"
          : `${items.length} offices`,
    body:
      locale === "zh"
        ? "这里显示当前工作空间中已保存的办公室。请在团队页填写名称、目标和真实成员后创建。"
        : "Saved offices in the current workspace appear here. Create one from Team after defining its name, goal, and real members.",
    actions: [],
    items:
      items.length > 0
        ? [
            {
              title: locale === "zh" ? "办公室" : "Offices",
              meta:
                locale === "zh"
                  ? `${items.length} 个已创建`
                  : `${items.length} created`,
              description:
                locale === "zh"
                  ? "打开办公室后可以继续群聊协作。"
                  : "Open an office to continue group-chat work.",
              section: true,
            },
            ...items,
          ]
        : [
            {
              title: locale === "zh" ? "暂无办公室" : "No offices yet",
              meta: locale === "zh" ? "当前工作空间" : "Current workspace",
              description:
                locale === "zh"
                  ? "前往团队页创建办公室；不会自动生成默认名称、目标或成员。"
                  : "Create an Office from Team; no default name, goal, or members will be generated.",
              glyph: "◷",
              accent: "slate",
            },
          ],
    error: listUnsupported
      ? locale === "zh"
        ? "当前版本暂时无法读取办公室，请升级后重试。"
        : "This version cannot load offices yet. Upgrade and try again."
      : undefined,
  };
}

export function backendAutomationCollectionContent(params: {
  items: LibraryItem[];
  listUnsupported: boolean;
  locale: Locale;
}): LibraryCollectionContent {
  const { items, listUnsupported, locale } = params;
  return {
    subtitle:
      locale === "zh"
        ? `${items.length} 条后端自动化`
        : `${items.length} backend automations`,
    body:
      locale === "zh"
        ? "自动化来自 app-server automation/list，运行历史来自 automation/runs/list。"
        : "Automations are loaded from app-server automation/list, with run history from automation/runs/list.",
    actions: [
      collectionAction(
        "create-automation",
        locale === "zh" ? "新建自动化" : "New automation",
      ),
    ],
    items:
      items.length > 0
        ? [
            {
              title: locale === "zh" ? "后端自动化" : "Backend automations",
              meta:
                locale === "zh"
                  ? `${items.length} 条记录`
                  : `${items.length} records`,
              description:
                locale === "zh"
                  ? "这些自动化来自 app-server automation/list，可打开后再次运行。"
                  : "These automations come from app-server automation/list and can be run again.",
              section: true,
            },
            ...items,
          ]
        : [
            {
              title:
                locale === "zh" ? "暂无后端自动化" : "No backend automations",
              meta: "automation/list",
              description:
                locale === "zh"
                  ? "点击新建自动化写入后端记录，运行后会生成 automation/run 记录。"
                  : "Create an automation to write a backend record; running it creates automation/run history.",
              glyph: "◷",
              accent: "slate",
            },
          ],
    error: listUnsupported
      ? locale === "zh"
        ? "当前 app-server 不支持 automation/list，无法读取后端自动化。"
        : "The current app-server does not support automation/list."
      : undefined,
  };
}

export function controlAutomationCollectionContent(params: {
  items: LibraryItem[];
  locale: Locale;
}): LibraryCollectionContent {
  const { items, locale } = params;
  return {
    subtitle:
      locale === "zh"
        ? `${items.length} 条手动自动化`
        : items.length === 1
          ? "1 manual automation"
          : `${items.length} manual automations`,
    body:
      locale === "zh"
        ? "自动化由 Control API 管理，仅支持手动立即运行；这里不提供定时、启停或编辑伪兼容。"
        : "Automations are managed by Control API and run manually. Scheduling, toggles, and compatibility edits are not offered here.",
    actions: [],
    items:
      items.length > 0
        ? [
            {
              title: locale === "zh" ? "Control 自动化" : "Control automations",
              meta:
                locale === "zh"
                  ? `${items.length} 条不可变定义`
                  : items.length === 1
                    ? "1 immutable definition"
                    : `${items.length} immutable definitions`,
              description:
                locale === "zh"
                  ? "打开后可通过 Control authority 立即运行。"
                  : "Open an automation to run it through Control authority.",
              section: true,
            },
            ...items,
          ]
        : [
            {
              title:
                locale === "zh" ? "暂无手动自动化" : "No manual automations",
              meta: "Control API",
              description:
                locale === "zh"
                  ? "当前 Control authority 中没有可运行的自动化。"
                  : "The current Control authority has no runnable automations.",
              glyph: "◷",
              accent: "slate",
            },
          ],
  };
}

export function backendAgentCollectionContent(params: {
  detectedItems: ExternalAgentConfigMigrationItem[];
  storedItems: LibraryItem[];
  locale: Locale;
}): LibraryCollectionContent {
  const { detectedItems, storedItems, locale } = params;
  const externalItems = externalAgentImportItems(detectedItems, locale);
  return {
    subtitle:
      locale === "zh"
        ? `${storedItems.length} 个后端智能体 · ${detectedItems.length} 个可导入项`
        : `${storedItems.length} backend agents · ${detectedItems.length} importable items`,
    body:
      locale === "zh"
        ? "智能体来自 app-server agent/list。新建只会打开配置草稿，填写真实名称和职责并保存后才写入后端。"
        : "Agents are loaded from app-server agent/list. Creating one opens a draft; the backend is written only after a real name and role are saved.",
    actions: [
      collectionAction(
        "create-agent",
        locale === "zh" ? "新建智能体" : "New agent",
      ),
    ],
    items:
      storedItems.length > 0 || externalItems.length > 0
        ? [
            ...(storedItems.length > 0
              ? [
                  {
                    title: locale === "zh" ? "后端智能体" : "Backend agents",
                    meta:
                      locale === "zh"
                        ? `${storedItems.length} 个已保存`
                        : `${storedItems.length} saved`,
                    description:
                      locale === "zh"
                        ? "这些智能体来自 app-server agent/list，可继续调整配置。"
                        : "These agents come from app-server agent/list and can be adjusted.",
                    section: true,
                  },
                  ...storedItems,
                ]
              : []),
            ...(externalItems.length > 0
              ? [
                  {
                    title: locale === "zh" ? "外部配置" : "External configs",
                    meta:
                      locale === "zh"
                        ? `${detectedItems.length} 个可导入项`
                        : `${detectedItems.length} importable items`,
                    description:
                      locale === "zh"
                        ? "可从已有 Agent 配置迁移，导入后加入智能体库。"
                        : "Migrate existing agent configs into the agent library.",
                    section: true,
                  },
                  ...externalItems,
                ]
              : []),
          ]
        : [
            {
              title: locale === "zh" ? "暂无后端智能体" : "No backend agents",
              meta: "agent/list",
              description:
                locale === "zh"
                  ? "点击新建智能体，从当前 app-server 读取模型、权限、MCP 和 Skill 后保存。"
                  : "Create an agent to load models, permissions, MCP, and Skills from the current app-server.",
              glyph: "◷",
              accent: "slate",
            },
          ],
  };
}

function externalAgentImportItems(
  items: ExternalAgentConfigMigrationItem[],
  locale: Locale,
): LibraryItem[] {
  return items.map((item) => ({
    title: item.description,
    meta: item.itemType,
    description: externalAgentMigrationSummary(item, locale),
    action: {
      type: "external-agent-import",
      item,
    },
  }));
}

function collectionAction(
  id: LibraryPanelAction["id"],
  label: string,
): LibraryPanelAction {
  return {
    id,
    label,
    tone: "primary",
  };
}
