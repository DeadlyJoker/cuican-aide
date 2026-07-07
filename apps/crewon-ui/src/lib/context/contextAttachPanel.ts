import type { CapabilityPanel, CapabilityPanelItem } from "../capability/capabilityPanelTypes";
import { filePanelSearchControls } from "../capability/capabilityPanelText";
import type { Locale } from "../i18n";
import { joinPath, resolveSearchPath } from "../shared/pathUtils";

type AttachContextSearchFile = {
  match_type: "directory" | "file";
  path: string;
  root: string;
};

type AttachContextSearchResponse = {
  files?: AttachContextSearchFile[] | null;
};

type AttachContextMetadata = {
  isDirectory?: boolean;
};

export const ATTACH_CONTEXT_QUERIES = [
  "AGENTS.md",
  "README.md",
  "knowledge.md",
  "memory.md",
] as const;

export function attachContextDemoPanel(locale: Locale): CapabilityPanel {
  return {
    title: attachContextTitle(locale),
    subtitle: locale === "zh" ? "演示模式" : "Demo mode",
    body:
      locale === "zh"
        ? "演示模式下不会读取真实文件。连接 app-server 后，这里会搜索 README、AGENTS 和知识库文件。"
        : "Demo mode does not read real files. With app-server connected, this searches README, AGENTS, and knowledge files.",
  };
}

export function attachContextLoadingPanel(
  contextCwd: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: attachContextTitle(locale),
    subtitle: contextCwd,
    body:
      locale === "zh"
        ? "正在从工作区搜索可添加的上下文..."
        : "Searching workspace context...",
  };
}

export function attachContextResultsPanel(params: {
  contextCwd: string;
  items: CapabilityPanelItem[];
  locale: Locale;
}): CapabilityPanel {
  const { contextCwd, items, locale } = params;
  return {
    title: attachContextTitle(locale),
    subtitle: contextCwd,
    body:
      locale === "zh"
        ? "选择一个文件加入当前对话上下文。这里读取的是 app-server 的真实工作区搜索结果。"
        : "Choose a file to inspect for the current conversation context. These are live app-server workspace search results.",
    ...filePanelSearchControls(
      locale,
      contextCwd,
      ATTACH_CONTEXT_QUERIES.join(" "),
    ),
    items:
      items.length > 0
        ? items
        : [
            {
              label:
                locale === "zh"
                  ? "没有找到可添加的上下文文件"
                  : "No context files found",
            },
          ],
  };
}

export function attachContextErrorPanel(params: {
  contextCwd: string;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { contextCwd, error, locale } = params;
  return {
    title: attachContextTitle(locale),
    subtitle: contextCwd,
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "搜索上下文失败"
          : "Unable to search context",
  };
}

export async function buildAttachContextItems(params: {
  contextCwd: string;
  getMetadata: (path: string) => Promise<AttachContextMetadata | null | undefined>;
  limit?: number;
  searchFiles: (
    query: string,
    roots: string[],
  ) => Promise<AttachContextSearchResponse | null | undefined>;
}): Promise<CapabilityPanelItem[]> {
  const { contextCwd, getMetadata, limit = 12, searchFiles } = params;
  const searchResults = await Promise.allSettled(
    ATTACH_CONTEXT_QUERIES.map((query) => searchFiles(query, [contextCwd])),
  );
  const files = searchResults.flatMap((result) =>
    result.status === "fulfilled" ? (result.value?.files ?? []) : [],
  );
  const seenPaths = new Set<string>();
  const items = searchFilesToAttachContextItems({
    files,
    limit,
    seenPaths,
  });

  for (const path of attachContextFallbackPaths(contextCwd)) {
    if (items.length >= limit || seenPaths.has(path)) {
      continue;
    }
    try {
      const metadata = await getMetadata(path);
      if (!metadata || metadata.isDirectory) {
        continue;
      }
      seenPaths.add(path);
      items.push(fallbackPathToAttachContextItem(path, contextCwd));
    } catch {
      // Missing optional context files are fine.
    }
  }

  return items;
}

export function attachContextFallbackPaths(contextCwd: string): string[] {
  return [
    joinPath(contextCwd, "AGENTS.md"),
    joinPath(contextCwd, "README.md"),
    joinPath(joinPath(contextCwd, ".crewon"), "knowledge.md"),
    joinPath(joinPath(contextCwd, ".crewon"), "memory.md"),
  ];
}

function attachContextTitle(locale: Locale): string {
  return locale === "zh" ? "添加上下文" : "Attach context";
}

function searchFilesToAttachContextItems(params: {
  files: AttachContextSearchFile[];
  limit: number;
  seenPaths: Set<string>;
}): CapabilityPanelItem[] {
  const { files, limit, seenPaths } = params;
  const items: CapabilityPanelItem[] = [];
  for (const file of files) {
    if (items.length >= limit) {
      break;
    }
    const path = resolveSearchPath(file.root, file.path);
    if (seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    items.push({
      label: `${file.match_type === "directory" ? ">" : " "} ${file.path}`,
      path,
      kind: file.match_type === "directory" ? "directory" : "file",
      intent: "attach-context",
    });
  }
  return items;
}

function fallbackPathToAttachContextItem(
  path: string,
  contextCwd: string,
): CapabilityPanelItem {
  const prefix = `${contextCwd}/`;
  return {
    label: `  ${path.startsWith(prefix) ? path.slice(prefix.length) : path}`,
    path,
    kind: "file",
    intent: "attach-context",
  };
}
