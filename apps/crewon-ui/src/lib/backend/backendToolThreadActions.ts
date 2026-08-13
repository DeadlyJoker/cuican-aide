import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { TurnStartResponse } from "@crewon-ui-model/v2/TurnStartResponse";

import { activeTurnByThreadAfterTurn } from "../thread/threadRuntimeState";
import type { Locale } from "../i18n";
import {
  mcpBackendToolEventPrompt,
  mcpToolThreadGoal,
  mcpToolThreadTitleForNames,
} from "../mcp/mcpDetailPanel";
import { backendThreadId } from "../thread/threadIds";
import { upsertThread, upsertTurnInThread } from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;

export type EnsureBackendToolThreadParams = {
  locale: Locale;
  renameThread: (threadId: string, title: string) => Promise<void>;
  resolveBackendCwd: () => Promise<string>;
  selectedThreadId: string | null;
  serverName: string;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget: number | null,
  ) => Promise<void>;
  setThreads: StateSetter<Thread[]>;
  startThread: (cwd: string, source: "tool") => Promise<Thread | null>;
  toolName: string;
};

export async function ensureBackendToolThreadAction({
  locale,
  renameThread,
  resolveBackendCwd,
  selectedThreadId,
  serverName,
  setThreadGoal,
  setThreads,
  startThread,
  toolName,
}: EnsureBackendToolThreadParams): Promise<string | null> {
  const selectedBackendThreadId = backendThreadId(selectedThreadId);
  if (selectedBackendThreadId) {
    return selectedBackendThreadId;
  }

  const title = mcpToolThreadTitleForNames(serverName, toolName, locale);
  const thread = await startThread(await resolveBackendCwd(), "tool");
  if (!thread) {
    return null;
  }
  await renameThread(thread.id, title);
  await setThreadGoal(
    thread.id,
    mcpToolThreadGoal(serverName, toolName, locale),
    null,
  );
  setThreads((current) => upsertThread(current, { ...thread, name: title }));
  return thread.id;
}

export type RecordBackendToolEventParams = {
  body: string;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setThreads: StateSetter<Thread[]>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
  threadId: string;
  title: string;
};

export async function recordBackendToolEventAction({
  body,
  setActiveTurnByThread,
  setThreads,
  startTurn,
  threadId,
  title,
}: RecordBackendToolEventParams): Promise<boolean> {
  const response = await startTurn(threadId, mcpBackendToolEventPrompt(title, body));
  if (!response) {
    return false;
  }
  setThreads((current) =>
    upsertTurnInThread(current, threadId, response.turn),
  );
  setActiveTurnByThread((current) =>
    activeTurnByThreadAfterTurn(current, threadId, response.turn),
  );
  return true;
}
