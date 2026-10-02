import { useEffect, useState, type ReactNode } from "react";
import { classNames } from "./commandWorkspaceUtils";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";

/** Host reader injection; business modules receive no authentication or client authority. */
export type CommandWorkspacePlatformSnapshotLoader =
  () => Promise<AgentPlatformSnapshot>;

/** Trusted host composition only; this slot is not a plugin loader or a runtime permission API. */
export type CommandWorkspaceHostModule = Readonly<{
  id: string;
  label: string;
  content: ReactNode;
}>;

export function useCommandWorkspaceHostModule(
  module: CommandWorkspaceHostModule | undefined,
) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const id = module?.id ?? null;
  useEffect(() => {
    setSelectedId(null);
  }, [id]);
  return {
    active: id !== null && selectedId === id,
    open: () => setSelectedId(id),
    close: () => setSelectedId(null),
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
      {module.content}
    </section>
  );
}
