import type { Thread } from "@crewon-protocol/v2/Thread";

import type {
  LibraryPanel,
  OfficeConfig,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import { officeConfigForThread } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  officeThreadBindingPanel,
  officeThreadBoundPanel,
  officeWorkspaceConnectedPanel,
} from "./officeDetailPanel";
import { upsertThread } from "../thread/threadModel";
import {
  officeIdentityFromPanel,
  officePanelMatchesIdentity,
} from "./officeIdentity";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OfficeThreadResolution = {
  config: OfficeConfig;
  filePath: string | null;
  threadId: string;
};

export type EnsureOfficeThreadActionParams = {
  forceNew?: boolean;
  isConnected: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  locale: Locale;
  panel: LibraryPanel;
  ensureOfficeManager: (
    officeRecordId: string,
    expectedRecordRevision: string,
  ) => Promise<OfficeThreadResolution | null>;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  setLibraryPanel: LibraryPanelSetter;
  setThreads: StateSetter<Thread[]>;
  workspaceOverride?: OfficeWorkspace;
};

export async function ensureOfficeThreadAction({
  forceNew = false,
  isConnected,
  isMissingThreadError,
  locale,
  panel,
  ensureOfficeManager,
  readThread,
  setLibraryPanel,
  setThreads,
  workspaceOverride,
}: EnsureOfficeThreadActionParams): Promise<OfficeThreadResolution | null> {
  const workspace = workspaceOverride ?? panel.workspace;
  if (!workspace) {
    return null;
  }
  const expectedIdentity = officeIdentityFromPanel(panel);
  if (!expectedIdentity) {
    return null;
  }

  if (!isConnected) {
    const threadId = workspace.threadId;
    return threadId
      ? {
          config: officeConfigForThread(
            panel.title,
            panel.subtitle,
            workspace,
            threadId,
          ),
          filePath: panel.configPath ?? null,
          threadId,
        }
      : null;
  }

  if (workspace.threadId && !forceNew) {
    const existingThreadId = workspace.threadId;
    try {
      await readThread(existingThreadId);
      setLibraryPanel((currentPanel) =>
        officePanelMatchesIdentity(currentPanel, expectedIdentity)
          ? officeWorkspaceConnectedPanel(
              currentPanel,
              currentPanel?.workspace ?? workspace,
              existingThreadId,
            )
          : currentPanel,
      );
      return {
        config: officeConfigForThread(
          panel.title,
          panel.subtitle,
          workspace,
          existingThreadId,
        ),
        filePath: panel.configPath ?? null,
        threadId: existingThreadId,
      };
    } catch (error) {
      if (!isMissingThreadError(error)) {
        throw error;
      }
    }
  }

  let bindingPanelForTarget: LibraryPanel | null = null;
  setLibraryPanel((currentPanel) => {
    if (!officePanelMatchesIdentity(currentPanel, expectedIdentity)) {
      return currentPanel;
    }
    bindingPanelForTarget = officeThreadBindingPanel(currentPanel);
    return bindingPanelForTarget;
  });

  const recordId = workspace.recordId?.trim();
  const recordRevision = workspace.recordRevision?.trim();
  if (!recordId || !recordRevision) {
    throw new Error(
      locale === "zh"
        ? "办公室状态不完整，请刷新后重试"
        : "The Office state is incomplete; refresh it and retry",
    );
  }

  const ensured = await ensureOfficeManager(recordId, recordRevision);
  if (!ensured) {
    return null;
  }
  const thread = await readThread(ensured.threadId);
  if (thread) {
    setThreads((current) =>
      upsertThread(current, { ...thread, name: panel.title }),
    );
  }

  setLibraryPanel((currentPanel) => {
    const isCurrentTarget =
      officePanelMatchesIdentity(currentPanel, expectedIdentity) ||
      (bindingPanelForTarget !== null && currentPanel === bindingPanelForTarget);
    return isCurrentTarget
      ? officeThreadBoundPanel(currentPanel, {
          config: ensured.config,
          filePath: ensured.filePath,
          locale,
          threadId: ensured.threadId,
        })
      : currentPanel;
  });

  return ensured;
}
