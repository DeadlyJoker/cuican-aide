import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  Search,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { CommandWorkbenchCode } from "./CommandWorkbenchCode";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";

function itemLabel(label: string): string {
  return label.replace(/^\s*>\s*/, "").trim();
}

function fileName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

export function workbenchFileContent(panel: CapabilityPanel | null): string {
  const body = panel?.body ?? "";
  const blocks = body.split("\n\n");
  if (/^(类型|Type):\s/m.test(blocks[0] ?? "")) {
    blocks.shift();
  }
  if (/^(已加入输入框|Added to the composer)/.test(blocks[0] ?? "")) {
    blocks.shift();
  }
  return blocks.join("\n\n");
}

function FileBreadcrumbs({
  disabled,
  path,
  onPanelItem,
}: {
  disabled: boolean;
  path: string;
  onPanelItem: (item: CapabilityPanelItem) => void;
}) {
  const normalized = path.replace(/\\/g, "/");
  const pieces = normalized.split("/").filter(Boolean);
  const absolute = normalized.startsWith("/");
  return (
    <nav aria-label="File breadcrumb" className="command-file-breadcrumbs">
      {pieces.map((piece, index) => {
        const piecePath = `${absolute ? "/" : ""}${pieces.slice(0, index + 1).join("/")}`;
        const current = index === pieces.length - 1;
        return (
          <span key={piecePath}>
            {index > 0 ? <ChevronRight aria-hidden="true" /> : null}
            <button
              disabled={disabled || current}
              type="button"
              onClick={() =>
                onPanelItem({
                  kind: "directory",
                  label: piece,
                  path: piecePath,
                })
              }
            >
              {piece}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function FilePreview({
  locale,
  panel,
}: {
  locale: Locale;
  panel: CapabilityPanel | null;
}) {
  const content = workbenchFileContent(panel);
  if (!panel || panel.items) {
    return (
      <div className="command-file-empty">
        <FolderOpen aria-hidden="true" />
        <strong>{locale === "zh" ? "打开文件" : "Open a file"}</strong>
        <span>
          {locale === "zh"
            ? "从右侧工作区中选择文件"
            : "Choose a file from the workspace tree"}
        </span>
      </div>
    );
  }
  if (panel.error) {
    return <p className="command-workbench-error">{panel.error}</p>;
  }
  return (
    <CommandWorkbenchCode
      content={content}
      path={panel.subtitle ?? panel.title}
    />
  );
}

export function CommandWorkbenchFiles({
  busyToolId,
  disabled,
  explorerPanel,
  locale,
  panel,
  onPanelItem,
}: {
  busyToolId: ToolId | null;
  disabled: boolean;
  explorerPanel: CapabilityPanel | null;
  locale: Locale;
  panel: CapabilityPanel | null;
  onPanelItem: (item: CapabilityPanelItem) => void;
}) {
  const [filter, setFilter] = useState("");
  const explorerPath = explorerPanel?.subtitle ?? "";
  const currentPath = panel?.subtitle ?? explorerPath;
  const [rootPath, setRootPath] = useState(explorerPath);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(explorerPath ? [explorerPath] : []),
  );
  const [treeEntries, setTreeEntries] = useState<
    Record<string, CapabilityPanelItem[]>
  >(() => (explorerPath ? { [explorerPath]: explorerPanel?.items ?? [] } : {}));
  const query = filter.trim().toLocaleLowerCase();
  const previewPath = panel && !panel.items ? (panel.subtitle ?? "") : "";

  useEffect(() => {
    if (!explorerPath) {
      return;
    }
    setRootPath((currentRoot) => {
      if (!currentRoot || currentRoot.startsWith(`${explorerPath}/`)) {
        return explorerPath;
      }
      if (!explorerPath.startsWith(`${currentRoot}/`)) {
        return explorerPath;
      }
      return currentRoot;
    });
    setTreeEntries((current) => ({
      ...current,
      [explorerPath]: explorerPanel?.items ?? [],
    }));
    setExpandedPaths((current) => new Set(current).add(explorerPath));
  }, [explorerPanel?.items, explorerPath]);

  function treePathHasMatch(path: string): boolean {
    return (treeEntries[path] ?? []).some((item) => {
      if (itemLabel(item.label).toLocaleLowerCase().includes(query)) {
        return true;
      }
      return item.kind === "directory" && item.path
        ? treePathHasMatch(item.path)
        : false;
    });
  }

  function renderTree(path: string, depth: number) {
    return (treeEntries[path] ?? [])
      .filter(
        (item) =>
          !query ||
          itemLabel(item.label).toLocaleLowerCase().includes(query) ||
          (item.kind === "directory" && item.path
            ? treePathHasMatch(item.path)
            : false),
      )
      .map((item) => {
        const itemPath = item.path ?? item.label;
        const directory = item.kind === "directory";
        const expanded = directory && expandedPaths.has(itemPath);
        return (
          <Fragment key={`${item.kind ?? "item"}:${itemPath}`}>
            <button
              aria-expanded={directory ? expanded : undefined}
              className={`command-file-row${item.path === previewPath ? " is-active" : ""}`}
              disabled={disabled || (!item.path && !item.action)}
              role="treeitem"
              style={{ paddingLeft: `${7 + depth * 14}px` }}
              title={item.path ?? item.label}
              type="button"
              onClick={() => {
                if (!directory || !item.path) {
                  onPanelItem(item);
                  return;
                }
                if (treeEntries[item.path]) {
                  setExpandedPaths((current) => {
                    const next = new Set(current);
                    if (next.has(item.path!)) {
                      next.delete(item.path!);
                    } else {
                      next.add(item.path!);
                    }
                    return next;
                  });
                  return;
                }
                setExpandedPaths((current) => new Set(current).add(item.path!));
                onPanelItem(item);
              }}
            >
              {directory ? (
                expanded ? (
                  <ChevronDown aria-hidden="true" />
                ) : (
                  <ChevronRight aria-hidden="true" />
                )
              ) : (
                <span className="command-file-row-spacer" />
              )}
              {directory ? (
                <Folder aria-hidden="true" />
              ) : (
                <File aria-hidden="true" />
              )}
              <span>{itemLabel(item.label)}</span>
            </button>
            {directory && item.path && (expanded || query)
              ? renderTree(item.path, depth + 1)
              : null}
          </Fragment>
        );
      });
  }

  return (
    <div className="command-file-workbench">
      <div className="command-file-toolbar">
        {currentPath ? (
          <FileBreadcrumbs
            disabled={disabled}
            path={currentPath}
            onPanelItem={onPanelItem}
          />
        ) : null}
        <div className="command-file-toolbar-actions">
          <button
            aria-label={locale === "zh" ? "复制路径" : "Copy path"}
            disabled={!currentPath}
            title={locale === "zh" ? "复制路径" : "Copy path"}
            type="button"
            onClick={() => void navigator.clipboard.writeText(currentPath)}
          >
            <Copy aria-hidden="true" />
          </button>
          <button
            disabled={!previewPath}
            type="button"
            onClick={() =>
              window.open(
                `vscode://file${encodeURI(previewPath)}`,
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            <ExternalLink aria-hidden="true" />
            {locale === "zh" ? "打开" : "Open"}
          </button>
        </div>
      </div>
      <div className="command-file-layout">
        <main className="command-file-preview">
          {busyToolId === "files" && !explorerPanel ? (
            <div className="command-file-empty" aria-live="polite">
              {locale === "zh" ? "正在读取工作区…" : "Reading workspace…"}
            </div>
          ) : (
            <FilePreview locale={locale} panel={panel} />
          )}
        </main>
        <aside className="command-file-explorer">
          <label className="command-file-filter">
            <Search aria-hidden="true" />
            <input
              aria-label={locale === "zh" ? "筛选文件" : "Filter files"}
              disabled={disabled}
              placeholder={locale === "zh" ? "筛选文件…" : "Filter files…"}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          {rootPath ? (
            <button
              aria-expanded={expandedPaths.has(rootPath)}
              className="command-file-root"
              type="button"
              onClick={() =>
                setExpandedPaths((current) => {
                  const next = new Set(current);
                  if (next.has(rootPath)) {
                    next.delete(rootPath);
                  } else {
                    next.add(rootPath);
                  }
                  return next;
                })
              }
            >
              {expandedPaths.has(rootPath) ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
              <strong>{fileName(rootPath)}</strong>
            </button>
          ) : null}
          <div className="command-file-tree" role="tree">
            {rootPath && expandedPaths.has(rootPath)
              ? renderTree(rootPath, 0)
              : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
