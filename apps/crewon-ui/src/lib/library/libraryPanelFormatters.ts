import type { LibraryKind, LibraryPanel } from "../domain/crewonDomain";
import type { Locale } from "../i18n";

export function libraryTitle(kind: LibraryKind, locale: Locale): string {
  if (locale === "zh") {
    return kind === "plugins"
      ? "插件"
      : kind === "tools"
        ? "能力"
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
      ? "Capabilities"
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
