import type { ControlApiClient } from "@crewon/control-client";
import { readControlCapabilityCatalog } from "../control-runtime/controlCapabilityCatalog";
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
import { listControlKnowledge } from "../knowledge/controlKnowledgeLibrary";
import { listControlAutomationLibraryItems } from "../automation/controlAutomationLibrary";
import { controlAutomationCollectionContent } from "./libraryCollectionPanels";
import { libraryTitle } from "./libraryPanelFormatters";

type SetLibraryPanel = (
  panel:
    | LibraryPanel
    | null
    | ((current: LibraryPanel | null) => LibraryPanel | null),
) => void;

const CONTROL_CAPABILITY_PAGE_SIZE = 100;
const CONTROL_CAPABILITY_MAX_PAGES = 5;
const CONTROL_CAPABILITY_MAX_ITEMS = 500;
const CONTROL_OFFICE_PAGE_SIZE = 100;
const CONTROL_OFFICE_MAX_PAGES = 5;
const CONTROL_OFFICE_MAX_ITEMS = 500;

export async function openControlLibraryAction(params: {
  client: ControlApiClient;
  kind: LibraryKind;
  locale: Locale;
  selectedThreadId: string | null;
  setLibraryPanel: SetLibraryPanel;
  isCurrent?: () => boolean;
}): Promise<void> {
  const { kind, locale } = params;
  const setLibraryPanel: SetLibraryPanel = (next) => {
    if (params.isCurrent?.() ?? true) params.setLibraryPanel(next);
  };
  const guardedParams = { ...params, setLibraryPanel };
  setLibraryPanel({
    kind,
    title: libraryTitle(kind, locale),
    subtitle:
      locale === "zh" ? "正在读取 Control API..." : "Reading Control API...",
    items: [],
  });

  if (kind === "tools") {
    await openControlCapabilityCatalog(guardedParams);
    return;
  }

  if (kind === "knowledge") {
    await openControlKnowledge(guardedParams);
    return;
  }

  if (kind === "office") {
    await openControlOffices(guardedParams);
    return;
  }

  if (kind === "automation") {
    await openControlAutomations(guardedParams);
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
      catalogMode: "controlKnowledge",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function openControlAutomations(params: {
  client: ControlApiClient;
  locale: Locale;
  setLibraryPanel: SetLibraryPanel;
}): Promise<void> {
  try {
    const content = controlAutomationCollectionContent({
      items: await listControlAutomationLibraryItems(
        params.client,
        params.locale,
      ),
      locale: params.locale,
    });
    params.setLibraryPanel({
      ...content,
      kind: "automation",
      title: libraryTitle("automation", params.locale),
    });
  } catch (error) {
    params.setLibraryPanel(
      controlReadFailure("automation", error, params.locale),
    );
  }
}

async function openControlKnowledge(params: {
  client: ControlApiClient;
  locale: Locale;
  setLibraryPanel: SetLibraryPanel;
}): Promise<void> {
  try {
    const response = await listControlKnowledge(params.client);
    const memories = response.data.filter(({ kind }) => kind === "memory");
    const sources = response.data.filter(({ kind }) => kind === "source");
    params.setLibraryPanel({
      kind: "knowledge",
      catalogMode: "controlKnowledge",
      title: libraryTitle("knowledge", params.locale),
      subtitle:
        params.locale === "zh"
          ? `${memories.length} 条记忆 · ${sources.length} 个知识源${response.truncated ? "（仅显示前 500 条）" : ""}`
          : `${memories.length} memories · ${sources.length} sources${response.truncated ? " (first 500 shown)" : ""}`,
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
    knowledgeId: item.knowledgeId,
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
    knowledgeId: item.knowledgeId,
    name: item.title,
    glyph: ["▦", "▤", "◍", "◎"][index % 4],
    accent: (["green", "amber", "cyan", "slate"] as const)[index % 4],
    status: "stored" as const,
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
    const offices: ControlOffice[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let truncated = false;
    for (let page = 0; page < CONTROL_OFFICE_MAX_PAGES; page += 1) {
      const response = await params.client.listOffices(
        cursor === null
          ? { limit: CONTROL_OFFICE_PAGE_SIZE }
          : { cursor, limit: CONTROL_OFFICE_PAGE_SIZE },
      );
      const remaining = CONTROL_OFFICE_MAX_ITEMS - offices.length;
      offices.push(...response.data.slice(0, remaining));
      truncated = response.data.length > remaining;
      if (response.nextCursor === null) break;
      if (seenCursors.has(response.nextCursor)) {
        throw new Error("Control Office cursor repeated during pagination");
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
      if (
        offices.length === CONTROL_OFFICE_MAX_ITEMS ||
        page === CONTROL_OFFICE_MAX_PAGES - 1
      ) {
        truncated = true;
        break;
      }
    }
    params.setLibraryPanel({
      kind: "office",
      title: libraryTitle("office", params.locale),
      subtitle:
        params.locale === "zh"
          ? `${offices.length} 个办公室${truncated ? "（已截断）" : ""}`
          : `${offices.length} offices${truncated ? " (truncated)" : ""}`,
      body:
        params.locale === "zh"
          ? "办公室定义来自 Control authority。可在办公室页选择已发布 AgentVersion 创建办公室，并通过显式 Workflow 委派启动 canonical Run。"
          : "Office definitions come from Control authority. Create an office from published AgentVersions on the Offices page, then start a canonical Run through explicit Workflow delegation.",
      actions: [],
      items: offices.map((office, index) =>
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
    const { capabilities, releaseId, truncated } =
      await readControlCapabilityCatalog({
        client,
        maxItems: CONTROL_CAPABILITY_MAX_ITEMS,
        maxPages: CONTROL_CAPABILITY_MAX_PAGES,
        pageSize: CONTROL_CAPABILITY_PAGE_SIZE,
      });
    setLibraryPanel({
      kind: "tools",
      title: libraryTitle("tools", locale),
      catalogMode: "controlCapabilities",
      subtitle:
        locale === "zh"
          ? `${capabilities.length} 个已发布能力${truncated ? "（已截断）" : ""} · Control release ${releaseId}`
          : `${capabilities.length} released capabilities${truncated ? " (truncated)" : ""} · Control release ${releaseId}`,
      body:
        locale === "zh"
          ? `只读目录来自当前 active AgentVersion release 的 Tool metadata；不包含输入 schema、instructions、凭据或密钥。${truncated ? "为限制 renderer 资源占用，仅展示前 500 条。" : ""}`
          : `This read-only catalog contains Tool metadata from the active AgentVersion release; input schemas, instructions, credentials, and secrets are not exposed.${truncated ? " Renderer resource limits restrict this view to the first 500 entries." : ""}`,
      actions: [],
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
        ? `发布目录 ${catalog.releaseId}；版本来自 Control authority。`
        : `Release catalog ${catalog.releaseId}; versions come from Control authority.`,
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
        ? "此资源类别尚未接入 Control API，未执行任何操作。"
        : "This resource category is not available from Control API. No action was taken.",
  };
}
