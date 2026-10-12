import { useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { PanelRight } from "lucide-react";
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
}>;

export function CommandWorkspacePluginPanel({
  modules,
  selectedId,
  unavailableSelection,
  target,
  locale,
  onClose,
  onRetry,
  onSelectionChange,
}: Readonly<{
  modules: readonly CommandWorkspaceHostModule[];
  selectedId: string | null;
  unavailableSelection: Readonly<{ id: string; label: string }> | null;
  target: HTMLElement | null;
  locale: Locale;
  onClose(): void;
  onRetry?(): void;
  onSelectionChange?(
    selection: CommandWorkspacePluginPanelSelection | null,
  ): void;
}>) {
  const label =
    unavailableSelection?.label ??
    modules.find((module) => module.id === selectedId)?.label ??
    null;
  const selection = useMemo(
    () =>
      selectedId !== null && label !== null
        ? { id: selectedId, label, close: onClose }
        : null,
    [selectedId, label, onClose],
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
      <strong>{selection.label}</strong>
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
