import type { WorkMode } from "../workMode";
import type { ThreadRuntimeSettings } from "../thread/threadRuntimeSettings";
import type { ComposerImageInput } from "../shared/composerImages";

type CommandShellHandlersParams = {
  selectThread: (threadId: string) => void | Promise<void>;
  sendMessageInNewThread: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    workspaceCwd?: string | null,
    images?: ComposerImageInput[],
  ) => void | Promise<void>;
  setComposerFocusSignal: (updater: (signal: number) => number) => void;
  setDraftWorkspaceCwd: (cwd: string | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setWorkMode: (mode: WorkMode) => void;
  startDraftThread: () => void;
};

export function commandShellWorkspaceUrl(
  currentHref: string,
  cwd: string | null,
): string {
  const nextUrl = new URL(currentHref);
  nextUrl.searchParams.set("cwd", cwd?.trim() || "");
  nextUrl.hash = "#view-command";
  return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
}

function replaceCommandShellWorkspaceUrl(cwd: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  window.history.replaceState(
    null,
    "",
    commandShellWorkspaceUrl(window.location.href, cwd),
  );
}

export function createAppCommandShellHandlers({
  selectThread,
  sendMessageInNewThread,
  setComposerFocusSignal,
  setDraftWorkspaceCwd,
  setSelectedThreadId,
  setWorkMode,
  startDraftThread,
}: CommandShellHandlersParams) {
  return {
    changeCommandShellWorkspace(nextCwd: string | null) {
      const trimmedCwd = nextCwd?.trim() || null;
      setDraftWorkspaceCwd(trimmedCwd);
      setSelectedThreadId(null);
      setWorkMode("code");
      setComposerFocusSignal((signal) => signal + 1);
      replaceCommandShellWorkspaceUrl(trimmedCwd);
    },
    openCommandShellThread(threadId: string | null) {
      if (!threadId) {
        setSelectedThreadId(null);
        return;
      }
      void selectThread(threadId);
    },
    sendCommandShellMessage(
      text: string,
      threadSettings?: ThreadRuntimeSettings,
      workspaceCwd?: string | null,
      images?: ComposerImageInput[],
    ) {
      setSelectedThreadId(null);
      if (images?.length) {
        void sendMessageInNewThread(text, threadSettings, workspaceCwd, images);
      } else {
        void sendMessageInNewThread(text, threadSettings, workspaceCwd);
      }
    },
    startCommandShellDraftThread(workspaceCwd: string | null) {
      const trimmedCwd = workspaceCwd?.trim() || null;
      setDraftWorkspaceCwd(trimmedCwd);
      setWorkMode("code");
      startDraftThread();
      replaceCommandShellWorkspaceUrl(trimmedCwd);
    },
  };
}
