import { capabilityAccents } from "./agentConfigDefaults";
import type {
  KnowledgeData,
  KnowledgeEntry,
  KnowledgeSource,
  LibraryAccent,
  LibraryKind,
  LibraryPanel,
} from "./crewonDomain";
import type { Locale } from "./i18n";

// Keep backend knowledge cards visually aligned with curated demo data when
// the backend omits presentation fields.
const MEMORY_GLYPHS = ["◆", "★", "✓", "▣", "◐"];
const SOURCE_GLYPHS = ["▦", "▤", "◍", "◎", "▥"];

export function normalizeKnowledgeData(data: unknown): KnowledgeData {
  const value = data as
    | { memories?: unknown; sources?: unknown }
    | null
    | undefined;
  const memories = Array.isArray(value?.memories) ? value.memories : [];
  const sources = Array.isArray(value?.sources) ? value.sources : [];
  return {
    memories: memories
      .filter((entry) => Boolean(entry))
      .map((entry, index): KnowledgeEntry => {
        const memory = entry as Partial<KnowledgeEntry>;
        return {
          title:
            typeof memory.title === "string" && memory.title.trim()
              ? memory.title
              : `Memory ${index + 1}`,
          glyph:
            typeof memory.glyph === "string" && memory.glyph.trim()
              ? memory.glyph
              : MEMORY_GLYPHS[index % MEMORY_GLYPHS.length],
          accent: normalizeLibraryAccent(memory.accent, index),
          kind:
            typeof memory.kind === "string" && memory.kind.trim()
              ? memory.kind
              : "Workspace memory",
          preview: typeof memory.preview === "string" ? memory.preview : "",
          meta: typeof memory.meta === "string" ? memory.meta : "",
          path: typeof memory.path === "string" ? memory.path : undefined,
          threadId:
            typeof memory.threadId === "string" ? memory.threadId : undefined,
          pinned: Boolean(memory.pinned),
        };
      }),
    sources: sources
      .filter((source) => Boolean(source))
      .map((source, index): KnowledgeSource => {
        const knowledgeSource = source as Partial<KnowledgeSource>;
        return {
          name:
            typeof knowledgeSource.name === "string" &&
            knowledgeSource.name.trim()
              ? knowledgeSource.name
              : `Source ${index + 1}`,
          glyph:
            typeof knowledgeSource.glyph === "string" &&
            knowledgeSource.glyph.trim()
              ? knowledgeSource.glyph
              : SOURCE_GLYPHS[index % SOURCE_GLYPHS.length],
          accent: normalizeLibraryAccent(knowledgeSource.accent, index + 1),
          status: normalizeKnowledgeSourceStatus(knowledgeSource.status),
          meta:
            typeof knowledgeSource.meta === "string"
              ? knowledgeSource.meta
              : "",
          path:
            typeof knowledgeSource.path === "string"
              ? knowledgeSource.path
              : undefined,
          isDirectory: Boolean(knowledgeSource.isDirectory),
        };
      }),
  };
}

function normalizeLibraryAccent(
  accent: unknown,
  index: number,
): LibraryAccent {
  const accents = capabilityAccents();
  return typeof accent === "string" &&
    accents.includes(accent as LibraryAccent)
    ? (accent as LibraryAccent)
    : accents[index % accents.length];
}

function normalizeKnowledgeSourceStatus(
  status: unknown,
): KnowledgeSource["status"] {
  return status === "indexing" || status === "needs-auth" ? status : "indexed";
}

export function libraryTitle(kind: LibraryKind, locale: Locale): string {
  if (locale === "zh") {
    return kind === "plugins"
      ? "插件"
      : kind === "tools"
        ? "工具"
        : kind === "agents"
          ? "智能体"
          : kind === "office"
            ? "办公室"
            : kind === "knowledge"
              ? "知识库"
              : "自动化";
  }

  return kind === "plugins"
    ? "Plugins"
    : kind === "tools"
      ? "Tools"
      : kind === "agents"
        ? "Agents"
        : kind === "office"
          ? "Office"
          : kind === "knowledge"
            ? "Knowledge"
            : "Automations";
}

export function libraryLoadingFallbackPanel(
  kind: LibraryKind,
  locale: Locale,
): LibraryPanel {
  const title = libraryTitle(kind, locale);
  return {
    kind,
    title,
    subtitle:
      locale === "zh"
        ? "正在读取本地 app-server..."
        : "Reading from local app-server...",
    body:
      locale === "zh"
        ? "后端响应较慢，正在等待真实数据。这里不会显示示例项目，避免把 demo 内容误当成后端记录。"
        : "The backend is responding slowly. Waiting for real data; demo items are not shown in connected mode.",
    items: [
      {
        title: locale === "zh" ? "读取中" : "Loading",
        meta: "app-server",
        description:
          locale === "zh"
            ? "正在从本地后端读取当前页面数据。"
            : "Reading this page from the local backend.",
        glyph: "◷",
        accent: "blue",
      },
    ],
  };
}
