import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_PLATFORM_SESSION_CHANGED_EVENT,
  readAgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";

/** Recover transient account-service failures without retaining another account's data. */
export function useAgentPlatformResources() {
  const [platformState, setPlatformState] = useState<
    "loading" | "ready" | "fallback"
  >("loading");
  const [platformSnapshot, setPlatformSnapshot] = useState(
    emptyAgentPlatformSnapshot,
  );
  const reload = useRef<() => Promise<void>>(async () => undefined);
  const reloadPlatformResources = useCallback(() => reload.current(), []);

  useEffect(() => {
    let active = true;
    let generation = 0;
    let retryCount = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const request = ++generation;
      clearTimeout(timer);
      setPlatformState("loading");
      try {
        const snapshot = await readAgentPlatformSnapshot();
        if (!active || request !== generation) return;
        setPlatformSnapshot(snapshot);
        setPlatformState("ready");
        // Partial catalog failures also need recovery; successful categories remain usable.
        const partialFailure = Object.values(
          snapshot.resourceStates ?? {},
        ).some((state) => state.status === "error");
        if (partialFailure) scheduleRetry();
        else retryCount = 0;
      } catch {
        if (!active || request !== generation) return;
        setPlatformSnapshot(emptyAgentPlatformSnapshot);
        setPlatformState("fallback");
        scheduleRetry();
      }
    };
    const scheduleRetry = () => {
      if (retryCount >= 3) return;
      retryCount += 1;
      // The client has a 30-second availability circuit breaker.
      timer = setTimeout(() => void load(), 35_000);
    };
    const restart = () => {
      retryCount = 0;
      setPlatformSnapshot(emptyAgentPlatformSnapshot);
      return load();
    };
    reload.current = restart;
    const onChange = () => void restart();
    globalThis.addEventListener("online", onChange);
    globalThis.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, onChange);
    void load();
    return () => {
      active = false;
      ++generation;
      clearTimeout(timer);
      reload.current = async () => undefined;
      globalThis.removeEventListener("online", onChange);
      globalThis.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        onChange,
      );
    };
  }, []);

  return { platformState, platformSnapshot, reloadPlatformResources };
}
