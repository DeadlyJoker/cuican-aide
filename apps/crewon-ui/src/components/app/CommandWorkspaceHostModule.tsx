import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
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
  content: ReactNode | ((state: Readonly<{ active: boolean }>) => ReactNode);
}>;

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
    request?: Readonly<{ id: string; requestKey: string }> | null;
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
        (!unavailable && !ids.has(current.id)))
        ? null
        : current,
    );
  }, [ids, navigationScope, ownerKey, unavailable]);
  const close = useCallback(() => setSelection(null), []);
  const lastRequestKey = useRef<string | null>(null);
  useEffect(() => {
    if (
      request &&
      !unavailable &&
      lastRequestKey.current !== request.requestKey &&
      ids.has(request.id)
    ) {
      lastRequestKey.current = request.requestKey;
      setSelection({
        id: request.id,
        label: modules.find((module) => module.id === request.id)!.label,
        navigationScope,
        ownerKey,
      });
    }
  }, [request, ids, modules, navigationScope, ownerKey, unavailable]);
  const open = useCallback(
    (id: string) => {
      if (unavailable || !ids.has(id))
        throw new Error("command_workspace_host_module_unavailable");
      setSelection({
        id,
        label: modules.find((module) => module.id === id)!.label,
        navigationScope,
        ownerKey,
      });
    },
    [ids, modules, navigationScope, ownerKey, unavailable],
  );
  return {
    selectedId,
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
