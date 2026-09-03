import { useCallback, useEffect, useRef, useState } from "react";

import {
  AppServerRpcError,
  type BackgroundTerminal,
} from "../app-server/appServer";

export type TaskDetailProcessClient = {
  listBackgroundTerminals(
    threadId: string,
  ): Promise<{ data: BackgroundTerminal[] }>;
  terminateBackgroundTerminal(
    threadId: string,
    processId: string,
  ): Promise<boolean>;
};

export type TaskDetailProcess = {
  command: string;
  cpuLabel: string | null;
  cwdLabel: string;
  id: string;
  memoryLabel: string | null;
  pidLabel: string | null;
};

export type TaskDetailProcessState = {
  data: TaskDetailProcess[];
  error: string | null;
  refreshing: boolean;
  status: "idle" | "loading" | "ready" | "error" | "forbidden" | "unavailable";
  terminatingIds: string[];
  threadId: string | null;
};

const ACTIVE_PROCESS_REFRESH_MS = 3_000;
const EMPTY_PROCESS_REFRESH_MS = 10_000;
const SAFE_PROCESS_EXECUTABLES = new Set([
  "bash",
  "bun",
  "cargo",
  "cmake",
  "curl",
  "deno",
  "docker",
  "docker-compose",
  "electron",
  "git",
  "go",
  "gradle",
  "java",
  "make",
  "mvn",
  "mysql",
  "node",
  "npm",
  "npx",
  "pnpm",
  "psql",
  "pytest",
  "python",
  "python3",
  "redis-cli",
  "ruby",
  "rustc",
  "sh",
  "sqlite3",
  "tsc",
  "uv",
  "uvx",
  "vite",
  "vitest",
  "wget",
  "yarn",
  "zsh",
]);
const SAFE_PROCESS_SUBCOMMANDS = new Set([
  "build",
  "check",
  "dev",
  "exec",
  "lint",
  "preview",
  "run",
  "serve",
  "start",
  "status",
  "test",
  "typecheck",
  "watch",
  "worker",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTaskDetailProcessPermissionError(error: unknown): boolean {
  if (
    error instanceof AppServerRpcError &&
    (error.code === 401 || error.code === 403)
  ) {
    return true;
  }
  const data =
    typeof error === "object" && error !== null && "data" in error
      ? String(error.data)
      : "";
  return /(?:\b403\b|forbidden|permission denied|access denied|unauthori[sz]ed)/iu.test(
    `${errorMessage(error)} ${data}`,
  );
}

function safeCommandToken(token: string): string {
  const unquoted = token.replace(/^["']+|["';|&()]+$/gu, "");
  return unquoted.replace(/\\/gu, "/").split("/").at(-1)?.toLowerCase() ?? "";
}

/**
 * Process commands are untrusted runtime data. Until the process protocol owns
 * a pre-sanitized display label, expose only an allowlisted executable and an
 * optional non-sensitive subcommand; never reflect arbitrary arguments.
 */
function compactCommand(command: string): string {
  const tokens = command
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .split(/\s+/gu)
    .filter(Boolean);
  const executableIndex = tokens.findIndex((token) =>
    SAFE_PROCESS_EXECUTABLES.has(safeCommandToken(token)),
  );
  if (executableIndex < 0) return "process";
  const executable = safeCommandToken(tokens[executableIndex] ?? "");
  const subcommand = tokens
    .slice(executableIndex + 1)
    .map(safeCommandToken)
    .find((token) => SAFE_PROCESS_SUBCOMMANDS.has(token));
  return subcommand ? `${executable} ${subcommand}` : executable;
}

function directoryName(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function memoryLabel(rssKb: number | null): string | null {
  if (rssKb === null) {
    return null;
  }
  if (rssKb < 1_024) {
    return `${Math.round(rssKb)} KB`;
  }
  return `${(rssKb / 1_024).toFixed(rssKb < 10_240 ? 1 : 0)} MB`;
}

export function taskDetailProcessPresentation(
  terminal: BackgroundTerminal,
): TaskDetailProcess {
  return {
    command: compactCommand(terminal.command),
    cpuLabel:
      terminal.cpuPercent === null
        ? null
        : `${terminal.cpuPercent.toFixed(1)}% CPU`,
    cwdLabel: directoryName(terminal.cwd),
    id: terminal.processId,
    memoryLabel: memoryLabel(terminal.rssKb),
    pidLabel: terminal.osPid === null ? null : `PID ${terminal.osPid}`,
  };
}

export function taskDetailProcessRefreshMs(processCount: number): number {
  return processCount > 0
    ? ACTIVE_PROCESS_REFRESH_MS
    : EMPTY_PROCESS_REFRESH_MS;
}

function initialState(
  threadId: string | null,
  status: TaskDetailProcessState["status"],
): TaskDetailProcessState {
  return {
    data: [],
    error: null,
    refreshing: false,
    status,
    terminatingIds: [],
    threadId,
  };
}

export function taskDetailProcessStateForThread(
  state: TaskDetailProcessState,
  threadId: string | null,
  fallbackStatus: TaskDetailProcessState["status"],
  allowCurrentData = true,
): TaskDetailProcessState {
  return allowCurrentData && state.threadId === threadId
    ? state
    : initialState(threadId, fallbackStatus);
}

export function useTaskDetailProcesses({
  client,
  enabled,
  open,
  threadId,
}: {
  client: TaskDetailProcessClient | null | undefined;
  enabled: boolean;
  open: boolean;
  threadId: string | null;
}) {
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [pageVisible, setPageVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [state, setState] = useState<TaskDetailProcessState>(() =>
    initialState(threadId, "idle"),
  );
  const generationRef = useRef(0);
  const terminatingProcessKeysRef = useRef(new Set<string>());
  const processCountRef = useRef<{ count: number; threadId: string | null }>({
    count: 0,
    threadId: null,
  });

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const syncVisibility = () =>
      setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", syncVisibility);
    return () =>
      document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  useEffect(() => {
    if (!open || !pageVisible) {
      return;
    }

    if (!enabled || !client || !threadId) {
      generationRef.current += 1;
      processCountRef.current = { count: 0, threadId };
      setState(initialState(threadId, "unavailable"));
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    setState((current) =>
      current.threadId === threadId
        ? {
            ...current,
            error: null,
            refreshing: current.data.length > 0,
            status: current.data.length > 0 ? current.status : "loading",
          }
        : initialState(threadId, "loading"),
    );

    const refresh = async () => {
      try {
        const response = await client.listBackgroundTerminals(threadId);
        if (cancelled || generationRef.current !== generation) {
          return;
        }
        const data = response.data.map(taskDetailProcessPresentation);
        processCountRef.current = { count: data.length, threadId };
        setState((current) => ({
          ...current,
          data,
          error: null,
          refreshing: false,
          status: "ready",
          threadId,
        }));
        refreshTimer = setTimeout(
          () => void refresh(),
          taskDetailProcessRefreshMs(data.length),
        );
      } catch (error) {
        if (cancelled || generationRef.current !== generation) {
          return;
        }
        if (isTaskDetailProcessPermissionError(error)) {
          processCountRef.current = { count: 0, threadId };
          setState({
            ...initialState(threadId, "forbidden"),
            error: null,
          });
          return;
        }
        setState((current) => ({
          ...current,
          error: errorMessage(error),
          refreshing: false,
          status: "error",
          threadId,
        }));
        refreshTimer = setTimeout(
          () => void refresh(),
          taskDetailProcessRefreshMs(
            processCountRef.current.threadId === threadId
              ? processCountRef.current.count
              : 0,
          ),
        );
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
      }
    };
  }, [client, enabled, open, pageVisible, refreshSequence, threadId]);

  const refresh = useCallback(() => {
    setRefreshSequence((current) => current + 1);
  }, []);

  const terminate = useCallback(
    async (processId: string) => {
      if (!client || !enabled || !threadId) {
        return false;
      }
      const processKey = `${threadId}\0${processId}`;
      if (terminatingProcessKeysRef.current.has(processKey)) {
        return false;
      }
      terminatingProcessKeysRef.current.add(processKey);
      setState((current) => ({
        ...current,
        terminatingIds: [...new Set([...current.terminatingIds, processId])],
      }));
      try {
        const terminated = await client.terminateBackgroundTerminal(
          threadId,
          processId,
        );
        setRefreshSequence((current) => current + 1);
        return terminated;
      } catch (error) {
        setState((current) =>
          current.threadId === threadId
            ? isTaskDetailProcessPermissionError(error)
              ? initialState(threadId, "forbidden")
              : {
                  ...current,
                  error: errorMessage(error),
                  status: "error",
                }
            : current,
        );
        return false;
      } finally {
        terminatingProcessKeysRef.current.delete(processKey);
        setState((current) =>
          current.threadId === threadId
            ? {
                ...current,
                terminatingIds: current.terminatingIds.filter(
                  (id) => id !== processId,
                ),
              }
            : current,
        );
      }
    },
    [client, enabled, threadId],
  );

  const runtimeAvailable = Boolean(enabled && client && threadId);
  const visibleState = taskDetailProcessStateForThread(
    state,
    threadId,
    !runtimeAvailable ? "unavailable" : open ? "loading" : "idle",
    runtimeAvailable,
  );

  return { refresh, state: visibleState, terminate };
}
