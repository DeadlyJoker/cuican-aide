import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import type { PluginNavigationIcon } from "@crewon/contracts/plugins";
import { classNames } from "./commandWorkspaceUtils";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";

/** Host reader injection; business modules receive no authentication or client authority. */
export type CommandWorkspacePlatformSnapshotLoader = (
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<AgentPlatformSnapshot>;

/** Trusted host composition only; this slot is not a plugin loader or a runtime permission API. */
export type CommandWorkspaceHostModule = Readonly<{
  /** Stable host route identity, including plugin AND contribution; version belongs to the mount key. */
  id: string;
  label: string;
  pluginId?: string;
  navigationLabel?: string;
  pageId?: string;
  createPage?(): void;
  closePage?(): void;
  icon?: PluginNavigationIcon;
  sidebarContent?:
    | ReactNode
    | ((state: Readonly<{ active: boolean }>) => ReactNode);
  content: ReactNode | ((state: Readonly<{ active: boolean }>) => ReactNode);
}>;

/** Presentation is selected by the host; returning sidebar content supplies no service authority. */
export function commandWorkspaceHostModuleSidebar({
  module,
  active,
}: Readonly<{
  module: CommandWorkspaceHostModule;
  active: boolean;
}>): ReactNode {
  return typeof module.sidebarContent === "function"
    ? module.sidebarContent({ active })
    : module.sidebarContent;
}

/** Directory availability affects callable content; the owner identifies the current host session only. */
export type CommandWorkspaceHostModuleAvailability = Readonly<{
  state: "available" | "unavailable";
  ownerKey: object | null;
  retry(): void;
}>;

/** The legacy single contribution keeps its position; duplicate identities are a host configuration error. */
export function mergeCommandWorkspaceHostModules<
  T extends Readonly<{ id: string }>,
>({
  hostModule,
  hostModules = [],
}: Readonly<{ hostModule?: T; hostModules?: readonly T[] }>): readonly T[] {
  const modules = hostModule ? [hostModule, ...hostModules] : [...hostModules];
  if (new Set(modules.map(({ id }) => id)).size !== modules.length)
    throw new Error("command_workspace_host_module_id_duplicate");
  return Object.freeze(modules);
}

export function useCommandWorkspaceHostModules(
  modules: readonly CommandWorkspaceHostModule[],
  {
    navigationScope = null,
    request = null,
    availability,
  }: Readonly<{
    navigationScope?: string | null;
    request?: Readonly<{
      id: string;
      requestKey: string;
      panelOpen?: boolean;
      hideOnlyGroup?: string;
      activateOnlyIfSelectedId?: string;
    }> | null;
    availability?: CommandWorkspaceHostModuleAvailability;
  }> = {},
) {
  const idsKey = JSON.stringify(modules.map(({ id }) => id));
  const ids = useMemo(() => new Set<string>(JSON.parse(idsKey)), [idsKey]);
  if (ids.size !== modules.length)
    throw new Error("command_workspace_host_module_id_duplicate");
  const [selection, setSelection] = useState<Readonly<{
    id: string;
    label: string;
    panelOpen: boolean;
    pluginId?: string;
    navigationScope: string | null;
    ownerKey: object | null;
  }> | null>(null);
  const ownerKey = availability?.ownerKey ?? null;
  const unavailable = availability?.state === "unavailable";
  // Failed reads withdraw callable content without turning a selected module into a chat navigation.
  const selectedId =
    selection &&
    selection.navigationScope === navigationScope &&
    selection.ownerKey === ownerKey &&
    (unavailable || ids.has(selection.id))
      ? selection.id
      : null;
  useEffect(() => {
    setSelection((current) =>
      current &&
      (current.navigationScope !== navigationScope ||
        current.ownerKey !== ownerKey ||
        (!unavailable &&
          !ids.has(current.id) &&
          !(
            request?.activateOnlyIfSelectedId === current.id &&
            ids.has(request.id)
          )))
        ? null
        : current,
    );
  }, [ids, navigationScope, ownerKey, unavailable, request]);
  const close = useCallback(() => setSelection(null), []);
  const sidebarIdsKey = JSON.stringify(
    modules
      .filter((module) => module.sidebarContent !== undefined)
      .map((module) => module.id),
  );
  const sidebarIds = useMemo(
    () => new Set<string>(JSON.parse(sidebarIdsKey)),
    [sidebarIdsKey],
  );
  const closePanel = useCallback(() => {
    setSelection((current) => {
      if (!current) return null;
      // Legacy workbench-only contributions retain their original close behavior.
      const hasSidebar = sidebarIds.has(current.id);
      return hasSidebar ? { ...current, panelOpen: false } : null;
    });
  }, [sidebarIds]);
  const lastRequestKey = useRef<string | null>(null);
  useEffect(() => {
    if (
      request &&
      !unavailable &&
      lastRequestKey.current !== request.requestKey &&
      ids.has(request.id)
    ) {
      lastRequestKey.current = request.requestKey;
      setSelection((current) => {
        if (
          request.activateOnlyIfSelectedId &&
          current?.id !== request.activateOnlyIfSelectedId
        )
          return current;
        if (
          request.hideOnlyGroup &&
          current?.pluginId !== request.hideOnlyGroup
        )
          return current;
        return {
          id: request.id,
          pluginId: modules.find((module) => module.id === request.id)
            ?.pluginId,
          panelOpen: request.panelOpen ?? true,
          label: modules.find((module) => module.id === request.id)!.label,
          navigationScope,
          ownerKey,
        };
      });
    }
  }, [request, ids, modules, navigationScope, ownerKey, unavailable]);
  const labelsKey = JSON.stringify(
    modules.map((module) => [
      module.id,
      { label: module.label, pluginId: module.pluginId },
    ]),
  );
  const labels = useMemo(
    () =>
      new Map<string, { label: string; pluginId?: string }>(
        JSON.parse(labelsKey),
      ),
    [labelsKey],
  );
  const open = useCallback(
    (id: string) => {
      if (unavailable || !ids.has(id))
        throw new Error("command_workspace_host_module_unavailable");
      setSelection({
        id,
        panelOpen: true,
        label: labels.get(id)!.label,
        pluginId: labels.get(id)!.pluginId,
        navigationScope,
        ownerKey,
      });
    },
    [ids, labels, navigationScope, ownerKey, unavailable],
  );
  return {
    selectedId,
    panelOpen: selectedId !== null && selection?.panelOpen === true,
    closePanel,
    active: selectedId !== null,
    unavailableSelection:
      unavailable && selectedId !== null && selection
        ? { id: selection.id, label: selection.label }
        : null,
    open,
    close,
  };
}

/** Contains no cached module or loader. A successful fresh directory is required before mounting again. */
export function CommandWorkspaceHostModuleUnavailablePane({
  selection,
  locale,
  onRetry,
}: {
  selection: Readonly<{ id: string; label: string }>;
  locale: "zh" | "en";
  onRetry(): void;
}) {
  return (
    <section
      aria-label={selection.label}
      className="shell-view active"
      data-host-module-id={selection.id}
    >
      <p role="alert">
        {locale === "zh"
          ? "模块暂时不可用，请重试。"
          : "This module is temporarily unavailable. Try again."}
      </p>
      <button type="button" onClick={onRetry}>
        {locale === "zh" ? "重试" : "Try again"}
      </button>
    </section>
  );
}

export function useCommandWorkspaceHostModule(
  module: CommandWorkspaceHostModule | undefined,
) {
  const selected = useCommandWorkspaceHostModules(module ? [module] : []);
  return {
    active: selected.active,
    open: () => {
      if (module) selected.open(module.id);
    },
    close: selected.close,
  };
}

export function CommandWorkspaceHostModulePane({
  module,
  active,
}: {
  module: CommandWorkspaceHostModule | undefined;
  active: boolean;
}) {
  if (!module) return null;
  return (
    <section
      aria-label={module.label}
      className={classNames("shell-view", active && "active")}
      data-host-module-id={module.id}
      hidden={!active}
    >
      {typeof module.content === "function"
        ? module.content({ active })
        : module.content}
    </section>
  );
}
