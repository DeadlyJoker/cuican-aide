import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../../lib/agent-platform/agentPlatformSessionEvents";
import type { CommandWorkspacePlatformSnapshotLoader } from "./CommandWorkspaceHostModule";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";

type LoadState = "loading" | "ready" | "fallback";
type ReadOwner = {
  loader: CommandWorkspacePlatformSnapshotLoader;
  controller: AbortController | null;
  closed: boolean;
};

/** Catalog enrichment owns its requests, independently of conversation execution. */
export function useCommandPlatformSnapshot(
  loader: CommandWorkspacePlatformSnapshotLoader,
) {
  const [platformState, setPlatformState] = useState<LoadState>("loading");
  const [platformSnapshot, setPlatformSnapshot] =
    useState<AgentPlatformSnapshot>(emptyAgentPlatformSnapshot);
  const ownerRef = useRef<ReadOwner | null>(null);

  const read = useCallback(async (owner: ReadOwner) => {
    if (owner.closed || ownerRef.current !== owner) return;
    owner.controller?.abort();
    const controller = new AbortController();
    owner.controller = controller;
    setPlatformState("loading");
    const current = () =>
      !owner.closed &&
      !controller.signal.aborted &&
      ownerRef.current === owner &&
      owner.controller === controller;
    try {
      // A disposed StrictMode lifetime must not start a duplicate catalog read.
      await Promise.resolve();
      if (!current()) return;
      const snapshot = await owner.loader({ signal: controller.signal });
      if (!current()) return;
      setPlatformSnapshot(snapshot);
      setPlatformState("ready");
    } catch {
      if (!current()) return;
      setPlatformSnapshot(emptyAgentPlatformSnapshot);
      setPlatformState("fallback");
    }
  }, []);

  useEffect(() => {
    const owner: ReadOwner = { loader, controller: null, closed: false };
    ownerRef.current = owner;
    setPlatformSnapshot(emptyAgentPlatformSnapshot);
    void read(owner);
    const sessionChanged = () => {
      setPlatformSnapshot(emptyAgentPlatformSnapshot);
      void read(owner);
    };
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      sessionChanged,
    );
    return () => {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        sessionChanged,
      );
      owner.closed = true;
      owner.controller?.abort();
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [loader, read]);

  const reloadPlatformResources = useCallback(async () => {
    const owner = ownerRef.current;
    if (owner) await read(owner);
  }, [read]);

  return { platformState, platformSnapshot, reloadPlatformResources };
}
