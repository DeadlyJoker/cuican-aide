import type { CapabilityPanel, CapabilityPanelItem } from "../capability/capabilityPanelTypes";
import { filePanelSearchControls } from "../capability/capabilityPanelText";
import type { Locale } from "../i18n";
import { joinPath, pathDirName, resolveSearchPath } from "../shared/pathUtils";

type DirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
};

type SearchFile = {
  match_type: "directory" | "file";
  path: string;
  root: string;
};

export function filePanelTitle(locale: Locale): string {
  return locale === "zh" ? "文件" : "Files";
}

export function fileLoadingPanel(path: string, locale: Locale): CapabilityPanel {
  return {
    title: filePanelTitle(locale),
    subtitle: path,
    body: locale === "zh" ? "正在读取..." : "Reading...",
  };
}

export function demoDirectoryPanel(params: {
  label: string;
  locale: Locale;
  path?: string;
}): CapabilityPanel {
  const { label, locale, path } = params;
  const parentPath = path ?? label.trim();
  return {
    title: filePanelTitle(locale),
    subtitle: parentPath,
    body: locale === "zh" ? "目录 · 演示数据" : "directory · demo data",
    items: [
      {
        label: locale === "zh" ? "  （演示）crewon-ui" : "  (demo) crewon-ui",
        path: joinPath(parentPath, "crewon-ui"),
        kind: "directory",
      },
      {
        label: locale === "zh" ? "  （演示）README.md" : "  (demo) README.md",
        path: joinPath(parentPath, "README.md"),
        kind: "file",
      },
    ],
  };
}

export function demoFilePanel(params: {
  label: string;
  locale: Locale;
  path?: string;
}): CapabilityPanel {
  const { label, locale, path } = params;
  return {
    title: label.trim(),
    subtitle: path ?? "",
    body:
      locale === "zh"
        ? "演示模式下展示的是示例文件内容。接入本地 app-server 后，这里会读取真实文件。"
        : "Demo mode shows sample file contents. Connect the local app-server to read real files here.",
  };
}

export function fileErrorPanel(params: {
  error: unknown;
  fallback: string;
  locale: Locale;
  path: string;
}): CapabilityPanel {
  const { error, fallback, locale, path } = params;
  return {
    title: filePanelTitle(locale),
    subtitle: path,
    error: error instanceof Error ? error.message : fallback,
  };
}

export function directoryEntriesToPanelItems(
  entries: DirectoryEntry[] | null | undefined,
  parentPath: string,
  limit = 16,
): CapabilityPanelItem[] {
  return [...(entries ?? [])]
    .sort(
      (left, right) =>
        Number(right.isDirectory) - Number(left.isDirectory) ||
        left.fileName.localeCompare(right.fileName),
    )
    .slice(0, limit)
    .map((entry) => ({
      label: `${entry.isDirectory ? ">" : " "} ${entry.fileName}`,
      path: joinPath(parentPath, entry.fileName),
      kind: entry.isDirectory ? "directory" : "file",
    }));
}

export function emptyDirectoryPanelItem(locale: "en" | "zh"): CapabilityPanelItem {
  return { label: locale === "zh" ? "目录为空" : "Empty directory" };
}

export function directoryPanel(params: {
  bodyPrefix?: string | null;
  entries: CapabilityPanelItem[];
  includeCopyAction?: boolean;
  locale: Locale;
  metadataText: string;
  path: string;
}): CapabilityPanel {
  const { bodyPrefix, entries, includeCopyAction, locale, metadataText, path } =
    params;
  const controls = filePanelSearchControls(locale, path);
  return {
    title: filePanelTitle(locale),
    subtitle: path,
    body: [bodyPrefix, metadataText].filter(Boolean).join("\n\n"),
    ...controls,
    actions: [
      ...(includeCopyAction
        ? [
            {
              id: "copy-current-path",
              label: locale === "zh" ? "复制到 .copy" : "Copy to .copy",
            },
          ]
        : []),
      ...(controls.actions ?? []),
    ],
    items: entries.length > 0 ? entries : [emptyDirectoryPanelItem(locale)],
  };
}

export function searchFilesToPanelItems(files: SearchFile[]): CapabilityPanelItem[] {
  return files.slice(0, 24).map((file) => {
    const path = resolveSearchPath(file.root, file.path);
    return {
      label: `${file.match_type === "directory" ? ">" : " "} ${file.path}`,
      path,
      kind: file.match_type,
    };
  });
}

export function searchResultsPanel(params: {
  items: CapabilityPanelItem[];
  locale: Locale;
  query: string;
  root: string;
}): CapabilityPanel {
  const { items, locale, query, root } = params;
  return {
    title: filePanelTitle(locale),
    subtitle: root,
    body: `${locale === "zh" ? "搜索" : "Search"}: ${query}`,
    ...filePanelSearchControls(locale, root, query),
    items:
      items.length > 0
        ? items
        : [{ label: locale === "zh" ? "没有匹配结果" : "No matches" }],
  };
}

export function searchErrorPanel(params: {
  error: unknown;
  locale: Locale;
  query: string;
  root: string;
}): CapabilityPanel {
  const { error, locale, query, root } = params;
  return {
    ...fileErrorPanel({
      error,
      fallback: locale === "zh" ? "搜索失败" : "Search failed",
      locale,
      path: root,
    }),
    ...filePanelSearchControls(locale, root, query),
  };
}

export function fileReadPanel(params: {
  fileText: string;
  intent?: CapabilityPanelItem["intent"];
  label: string;
  locale: Locale;
  metadataText: string;
  path: string;
}): CapabilityPanel {
  const { fileText, intent, label, locale, metadataText, path } = params;
  return {
    title: label.trim(),
    subtitle: path,
    body: [
      metadataText,
      intent === "attach-context"
        ? locale === "zh"
          ? "已加入输入框，发送后会随请求进入后端 turn/start。"
          : "Added to the composer. It will be sent through backend turn/start."
        : null,
      fileText.length > 12000
        ? `${fileText.slice(0, 12000)}\n...`
        : fileText || (locale === "zh" ? "文件为空" : "Empty file"),
    ]
      .filter(Boolean)
      .join("\n\n"),
    actions: [
      ...(intent === "attach-context"
        ? [
            {
              id: "send-context-to-thread",
              label:
                locale === "zh"
                  ? "发送到后端会话"
                  : "Send to backend thread",
              tone: "primary" as const,
            },
          ]
        : []),
      {
        id: "copy-current-path",
        label: locale === "zh" ? "复制到 .copy" : "Copy to .copy",
      },
      ...(filePanelSearchControls(locale, pathDirName(path)).actions ?? []),
    ],
  };
}
