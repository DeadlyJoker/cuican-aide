import type { ControlApiClient } from "@crewon/control-client";
import type {
  ActiveAgentVersionCatalogResponse,
  KnowledgeView,
} from "@crewon/contracts";

import type {
  LibraryItem,
  LibraryKind,
  LibraryPanel,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { libraryTitle } from "./libraryPanelFormatters";

type SetLibraryPanel = (
  panel:
    | LibraryPanel
    | null
    | ((current: LibraryPanel | null) => LibraryPanel | null),
) => void;

export async function openControlLibraryAction(params: {
  client: ControlApiClient;
  kind: LibraryKind;
  locale: Locale;
  selectedThreadId: string | null;
  setLibraryPanel: SetLibraryPanel;
}): Promise<void> {
  const { kind, locale, setLibraryPanel } = params;
  setLibraryPanel({
    kind,
    title: libraryTitle(kind, locale),
    subtitle:
      locale === "zh" ? "正在读取 Control API..." : "Reading Control API...",
    items: [],
  });

  if (kind === "tools") {
    await openControlCapabilityCatalog(params);
    return;
  }

  if (kind === "knowledge") {
    await openControlKnowledge(params);
    return;
  }

  if (kind === "office") {
    await openControlOffices(params);
    return;
  }

  if (kind !== "agents") {
    setLibraryPanel(controlLibraryUnavailablePanel(kind, locale));
    return;
  }

  try {
    const catalog = await params.client.getActiveAgentVersionCatalog();
    setLibraryPanel(controlAgentCatalogPanel(catalog, locale));
  } catch (error) {
    setLibraryPanel({
      kind,
      title: libraryTitle(kind, locale),
      subtitle:
        locale === "zh" ? "Control API 读取失败" : "Control API read failed",
      items: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function openControlKnowledge(params: {
  client: ControlApiClient;
  locale: Locale;
  setLibraryPanel: SetLibraryPanel;
}): Promise<void> {
  try {
    const response = await params.client.listKnowledge({ limit: 100 });
    const memories = response.data.filter(({ kind }) => kind === "memory");
    const sources = response.data.filter(({ kind }) => kind === "source");
    params.setLibraryPanel({
      kind: "knowledge",
      title: libraryTitle("knowledge", params.locale),
      subtitle:
        params.locale === "zh"
          ? `${memories.length} 条记忆 · ${sources.length} 个知识源`
          : `${memories.length} memories · ${sources.length} sources`,
      items: [],
      knowledge: {
        memories: memories.map(controlKnowledgeMemory),
        sources: sources.map(controlKnowledgeSource),
      },
    });
  } catch (error) {
    params.setLibraryPanel(
      controlReadFailure("knowledge", error, params.locale),
    );
  }
}

function controlKnowledgeMemory(item: KnowledgeView, index: number) {
  return {
    title: item.title,
    glyph: ["◆", "★", "✓", "▣"][index % 4],
    accent: (["blue", "violet", "cyan", "slate"] as const)[index % 4],
    kind: "Control memory",
    preview: item.content,
    meta: `${item.sourceId} · ${new Date(item.createdAt).toLocaleDateString()}`,
    pinned: false,
  };
}

function controlKnowledgeSource(item: KnowledgeView, index: number) {
  return {
    name: item.title,
    glyph: ["▦", "▤", "◍", "◎"][index % 4],
    accent: (["green", "amber", "cyan", "slate"] as const)[index % 4],
    status: "indexed" as const,
    meta: item.sourceId,
    isDirectory: false,
  };
}

async function openControlOffices(params: {
  client: ControlApiClient;
  locale: Locale;
  setLibraryPanel: SetLibraryPanel;
}): Promise<void> {
  try {
    const response = await params.client.listOffices({ limit: 100 });
    params.setLibraryPanel({
      kind: "office",
      title: libraryTitle("office", params.locale),
      subtitle:
        params.locale === "zh"
          ? `${response.data.length} 个办公室`
          : `${response.data.length} offices`,
      body:
        params.locale === "zh"
          ? "办公室定义来自 Control authority。创建办公室需先选择已发布 AgentVersion；当前 UI 未提供创建。旧版消息投递、自动调度与内存交接未启用。"
          : "Office definitions come from Control authority. Creating one requires a published AgentVersion selection, which this UI does not yet provide. Legacy message delivery, auto-dispatch, and memory handoff are disabled.",
      actions: [],
      items: response.data.map((office, index) =>
        controlOfficeItem(office, index, params.locale),
      ),
    });
  } catch (error) {
    params.setLibraryPanel(controlReadFailure("office", error, params.locale));
  }
}

type ControlOffice = Awaited<
  ReturnType<ControlApiClient["listOffices"]>
>["data"][number];

function controlOfficeItem(
  office: ControlOffice,
  index: number,
  locale: Locale,
): LibraryItem {
  return {
    title: office.title,
    meta: `${office.members.length} ${locale === "zh" ? "名成员" : "members"} · r${office.revision}`,
    description: office.executionTargets.length
      ? `${office.executionTargets.length} ${locale === "zh" ? "个 Control 执行目标" : "Control execution targets"}`
      : locale === "zh"
        ? "尚未配置执行目标"
        : "No execution target configured",
    glyph: "办",
    accent: index % 2 === 0 ? "cyan" : "violet",
    badge: { label: "Control", tone: "planning" },
    tags: [office.officeId, office.officeVersionId],
  };
}

function controlReadFailure(
  kind: LibraryKind,
  error: unknown,
  locale: Locale,
): LibraryPanel {
  return {
    kind,
    title: libraryTitle(kind, locale),
    subtitle:
      locale === "zh" ? "Control API 读取失败" : "Control API read failed",
    items: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

async function openControlCapabilityCatalog(params: {
  client: ControlApiClient;
  locale: Locale;
  setLibraryPanel: SetLibraryPanel;
}): Promise<void> {
  const { client, locale, setLibraryPanel } = params;
  try {
    const firstPage = await client.listActiveCapabilities({ limit: 100 });
    const capabilities = [...firstPage.data];
    let cursor = firstPage.nextCursor;
    while (cursor !== null) {
      const page = await client.listActiveCapabilities({ cursor, limit: 100 });
      capabilities.push(...page.data);
      cursor = page.nextCursor;
    }
    setLibraryPanel({
      kind: "tools",
      title: libraryTitle("tools", locale),
      catalogMode: "controlCapabilities",
      subtitle:
        locale === "zh"
          ? `${capabilities.length} 个已发布能力 · Control release ${firstPage.releaseId}`
          : `${capabilities.length} released capabilities · Control release ${firstPage.releaseId}`,
      body:
        locale === "zh"
          ? "只读目录来自当前 active AgentVersion release 的 Tool metadata；不包含输入 schema、instructions、凭据或密钥。"
          : "This read-only catalog contains Tool metadata from the active AgentVersion release; input schemas, instructions, credentials, and secrets are not exposed.",
      actions: [
        {
          id: "create-skill",
          label:
            locale === "zh"
              ? "创建 Skill（未迁移）"
              : "Create Skill (not migrated)",
          disabled: true,
          disabledReason:
            locale === "zh"
              ? "Control 尚无 Skill mutation authority"
              : "Control has no Skill mutation authority",
        },
        {
          id: "create-mcp",
          label:
            locale === "zh"
              ? "创建 MCP（未迁移）"
              : "Create MCP (not migrated)",
          disabled: true,
          disabledReason:
            locale === "zh"
              ? "Control 尚无 MCP mutation authority"
              : "Control has no MCP mutation authority",
        },
      ],
      items: capabilities.map((capability, index) => ({
        title: capability.name,
        meta: `${capability.kind} · ${capability.execution} · ${capability.inputFormat}`,
        description: capability.description,
        glyph: capability.kind === "function" ? "ƒ" : "T",
        accent: index % 2 === 0 ? "cyan" : "violet",
        badge: {
          label:
            locale === "zh" ? "只读 released Tool" : "read-only released Tool",
          tone: "planning",
        },
        tags: [capability.agentVersionId],
      })),
      error:
        capabilities.length === 0
          ? locale === "zh"
            ? "当前 active release 未投影任何能力；未使用 legacy Skill/MCP/App 数据填充。"
            : "The active release projects no capabilities; legacy Skill/MCP/App data was not used."
          : undefined,
    });
  } catch (error) {
    setLibraryPanel({
      kind: "tools",
      title: libraryTitle("tools", locale),
      subtitle:
        locale === "zh" ? "Control API 读取失败" : "Control API read failed",
      items: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function controlAgentCatalogPanel(
  catalog: ActiveAgentVersionCatalogResponse,
  locale: Locale,
): LibraryPanel {
  const items: LibraryItem[] = catalog.data.map((agent, index) => ({
    title: agent.agentVersionId,
    meta:
      agent.agentVersionId === catalog.defaultAgentVersionId
        ? locale === "zh"
          ? "Control 默认版本"
          : "Control default version"
        : locale === "zh"
          ? "Control 活跃版本"
          : "Control active version",
    description: `${agent.model.adapterName} · ${agent.model.modelId}`,
    glyph: "A",
    accent: index % 2 === 0 ? "blue" : "violet",
    badge: {
      label: locale === "zh" ? "不可变版本" : "immutable version",
      tone: "planning",
    },
    tags: [agent.runtimeGeneration, agent.model.adapterVersion],
  }));
  return {
    kind: "agents",
    title: libraryTitle("agents", locale),
    subtitle:
      locale === "zh"
        ? `${items.length} 个 Control 活跃 Agent 版本`
        : `${items.length} active Control Agent versions`,
    body:
      locale === "zh"
        ? `发布目录 ${catalog.releaseId}；版本来自 Control authority，不读取本地 app-server。`
        : `Release catalog ${catalog.releaseId}; versions come from Control authority without the local app-server.`,
    items,
  };
}

function controlLibraryUnavailablePanel(
  kind: LibraryKind,
  locale: Locale,
): LibraryPanel {
  return {
    kind,
    title: libraryTitle(kind, locale),
    subtitle: locale === "zh" ? "Control authority" : "Control authority",
    items: [],
    error:
      locale === "zh"
        ? "此资源类别尚未接入 Control API；已阻止 legacy app-server 回退。"
        : "This resource category is not available from Control API; legacy app-server fallback is blocked.",
  };
}
