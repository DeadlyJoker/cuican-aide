import { useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { PanelRight, Plus, X } from "lucide-react";
import {
  CommandWorkspaceHostModulePane,
  CommandWorkspaceHostModuleUnavailablePane,
  type CommandWorkspaceHostModule,
} from "./CommandWorkspaceHostModule";
import type { Locale } from "../../lib/i18n";
import "./CommandWorkspacePluginPanel.css";

/** Host-owned presentation only; this does not grant a plugin access to the shell. */
export type CommandWorkspacePluginPanelSelection = Readonly<{
  id: string;
  label: string;
  close(): void;
  createPage?(): void;
  pages?: readonly Readonly<{
    id: string;
    label: string;
    active: boolean;
    activate(): void;
    close(): void;
  }>[];
}>;

export function CommandWorkspacePluginPanel({
  modules,
  selectedId,
  unavailableSelection,
  target,
  locale,
  onClose,
  onSelect,
  onRetry,
  onSelectionChange,
}: Readonly<{
  modules: readonly CommandWorkspaceHostModule[];
  selectedId: string | null;
  unavailableSelection: Readonly<{ id: string; label: string }> | null;
  target: HTMLElement | null;
  locale: Locale;
  onClose(): void;
  onSelect?(id: string): void;
  onRetry?(): void;
  onSelectionChange?(
    selection: CommandWorkspacePluginPanelSelection | null,
  ): void;
}>) {
  const label =
    unavailableSelection?.label ??
    modules.find((module) => module.id === selectedId)?.label ??
    null;
  const latestModules = useRef(modules);
  latestModules.current = modules;
  const pageKey = JSON.stringify(
    modules
      .filter((module) => module.pageId)
      .map((module) => ({ id: module.id, label: module.label })),
  );
  const canCreate = modules.some(
    (module) => module.id === selectedId && !!module.createPage,
  );
  const createPage = useCallback(
    () =>
      latestModules.current
        .find((module) => module.id === selectedId)
        ?.createPage?.(),
    [selectedId],
  );
  const pageTabs = useMemo(
    () =>
      JSON.parse(pageKey).map(
        (page: Readonly<{ id: string; label: string }>) => ({
          ...page,
          active: page.id === selectedId,
          activate: () => onSelect?.(page.id),
          close: () =>
            latestModules.current
              .find((module) => module.id === page.id)
              ?.closePage?.(),
        }),
      ),
    [pageKey, selectedId, onSelect],
  );
  const selection = useMemo(
    () =>
      selectedId !== null && label !== null
        ? {
            id: selectedId,
            label,
            close: onClose,
            ...(canCreate ? { createPage } : {}),
            pages: pageTabs,
          }
        : null,
    [selectedId, label, onClose, canCreate, createPage, pageTabs],
  );
  useLayoutEffect(() => {
    onSelectionChange?.(selection);
  }, [selection, onSelectionChange]);
  useLayoutEffect(() => () => onSelectionChange?.(null), [onSelectionChange]);
  if (target === null) return null;
  return createPortal(
    <div className="command-plugin-panels">
      {modules.map((module) => (
        <CommandWorkspaceHostModulePane
          key={module.id}
          module={module}
          active={selectedId === module.id}
        />
      ))}
      {unavailableSelection && onRetry ? (
        <CommandWorkspaceHostModuleUnavailablePane
          selection={unavailableSelection}
          locale={locale}
          onRetry={onRetry}
        />
      ) : null}
    </div>,
    target,
  );
}

export function CommandWorkspacePluginPanelHeader({
  selection,
  locale,
  existingTabs = [],
}: Readonly<{
  existingTabs?: readonly Readonly<{
    id: string;
    label: string;
    activate(): void;
  }>[];
  selection: CommandWorkspacePluginPanelSelection;
  locale: Locale;
}>) {
  return (
    <header
      className="command-workbench-tabbar command-plugin-panel-header"
      data-desktop-drag-region=""
    >
      {!selection.pages?.length && <strong>{selection.label}</strong>}
      {selection.pages?.length ? (
        <div
          className="command-workbench-tabs"
          role="tablist"
          aria-label={locale === "zh" ? "插件页面" : "Plugin pages"}
        >
          {selection.pages.map((page) => (
            <div
              key={page.id}
              className="command-workbench-tab"
              role="tab"
              aria-selected={page.active}
              data-active={page.active ? "true" : undefined}
            >
              <button type="button" onClick={page.activate}>
                {page.label}
              </button>
              <button
                type="button"
                className="command-workbench-tab-close"
                aria-label={`${locale === "zh" ? "关闭" : "Close"} ${page.label}`}
                onClick={page.close}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {selection.createPage ? (
        <button
          type="button"
          className="command-workbench-add"
          aria-label={locale === "zh" ? "新建插件页面" : "New plugin page"}
          onClick={selection.createPage}
        >
          <Plus aria-hidden="true" />
        </button>
      ) : null}
      {existingTabs.length > 0 ? (
        <div
          className="command-workbench-tabs"
          role="tablist"
          aria-label={
            locale === "zh" ? "其他工作台页面" : "Other workbench pages"
          }
        >
          {existingTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={false}
              className="command-workbench-tab"
              onClick={tab.activate}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <button
        aria-label={locale === "zh" ? "关闭插件面板" : "Close plugin panel"}
        className="command-workbench-close"
        type="button"
        onClick={selection.close}
      >
        <PanelRight aria-hidden="true" />
      </button>
    </header>
  );
}
