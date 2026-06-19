import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

import type { LibraryPanel, OfficeWorkspace } from "../domain/crewonDomain";
import { officeConfigForThread } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  officeBindThreadTurnPrompt,
  officeThreadBindingPanel,
  officeThreadBoundPanel,
  officeWorkspaceConnectedPanel,
} from "./officeDetailPanel";
import { upsertThread } from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type EnsureOfficeThreadActionParams = {
  forceNew?: boolean;
  isConnected: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  locale: Locale;
  panel: LibraryPanel;
  persistOfficeWorkspace: (
    panel: Pick<LibraryPanel, "title" | "subtitle">,
    workspace: OfficeWorkspace,
    threadId?: string | null,
  ) => Promise<string | null>;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  setLibraryPanel: LibraryPanelSetter;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget: number | null,
  ) => Promise<void>;
  setThreads: StateSetter<Thread[]>;
  startOfficeThread: () => Promise<Thread | null>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
  workspaceOverride?: OfficeWorkspace;
};

export async function ensureOfficeThreadAction({
  forceNew = false,
  isConnected,
  isMissingThreadError,
  locale,
  panel,
  persistOfficeWorkspace,
  readThread,
  renameThread,
  setLibraryPanel,
  setThreadGoal,
  setThreads,
  startOfficeThread,
  startTurn,
  workspaceOverride,
}: EnsureOfficeThreadActionParams): Promise<string | null> {
  const workspace = workspaceOverride ?? panel.workspace;
  if (!workspace) {
    return null;
  }

  if (!isConnected) {
    return workspace.threadId ?? null;
  }

  if (workspace.threadId && !forceNew) {
    const existingThreadId = workspace.threadId;
    try {
      await readThread(existingThreadId);
      await persistOfficeWorkspace(panel, workspace, existingThreadId);
      setLibraryPanel((currentPanel) =>
        officeWorkspaceConnectedPanel(
          currentPanel,
          currentPanel?.workspace ?? workspace,
          existingThreadId,
        ),
      );
      return existingThreadId;
    } catch (error) {
      if (!isMissingThreadError(error)) {
        throw error;
      }
    }
  }

  setLibraryPanel((currentPanel) => officeThreadBindingPanel(currentPanel));

  const thread = await startOfficeThread();
  if (!thread) {
    return null;
  }

  await renameThread(thread.id, panel.title);
  await setThreadGoal(thread.id, workspace.goal, null);
  const config = officeConfigForThread(
    panel.title,
    panel.subtitle,
    workspace,
    thread.id,
  );
  const officeConfigPath = await persistOfficeWorkspace(
    panel,
    workspace,
    thread.id,
  );
  await startTurn(
    thread.id,
    officeBindThreadTurnPrompt({
      config,
      locale,
      officeConfigPath,
      panel,
    }),
  );
  setThreads((current) => upsertThread(current, { ...thread, name: panel.title }));

  setLibraryPanel((currentPanel) =>
    officeThreadBoundPanel(currentPanel, {
      locale,
      threadId: thread.id,
    }),
  );

  return thread.id;
}
