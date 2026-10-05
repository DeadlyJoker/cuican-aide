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
export type CommandWorkspacePlatformSnapshotLoader =
  () => Promise<AgentPlatformSnapshot>;

/** Trusted host composition only; this slot is not a plugin loader or a runtime permission API. */
export type CommandWorkspaceHostModule = Readonly<{
  /** Stable host route identity, including plugin AND contribution; version belongs to the mount key. */
  id: string;
  label: string;
  content: ReactNode | ((state: Readonly<{ active: boolean }>) => ReactNode);
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
  }: Readonly<{
    navigationScope?: string | null;
    request?: Readonly<{ id: string; requestKey: string }> | null;
  }> = {},
) {
  const idsKey = JSON.stringify(modules.map(({ id }) => id));
  const ids = useMemo(() => new Set<string>(JSON.parse(idsKey)), [idsKey]);
  if (ids.size !== modules.length)
    throw new Error("command_workspace_host_module_id_duplicate");
  const [selection, setSelection] = useState<Readonly<{
    id: string;
    navigationScope: string | null;
  }> | null>(null);
  // A removed contribution or changed thread/scene is inactive in this render, before effects run.
  const selectedId =
    selection &&
    selection.navigationScope === navigationScope &&
    ids.has(selection.id)
      ? selection.id
      : null;
  useEffect(() => {
    setSelection((current) =>
      current &&
      (current.navigationScope !== navigationScope || !ids.has(current.id))
        ? null
        : current,
    );
  }, [ids, navigationScope]);
  const close = useCallback(() => setSelection(null), []);
  const lastRequestKey = useRef<string | null>(null);
  useEffect(() => {
    if (
      request &&
      lastRequestKey.current !== request.requestKey &&
      ids.has(request.id)
    ) {
      lastRequestKey.current = request.requestKey;
      setSelection({ id: request.id, navigationScope });
    }
  }, [request, ids, navigationScope]);
  const open = useCallback(
    (id: string) => {
      if (!ids.has(id))
        throw new Error("command_workspace_host_module_unavailable");
      setSelection({ id, navigationScope });
    },
    [ids, navigationScope],
  );
  return { selectedId, active: selectedId !== null, open, close };
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
