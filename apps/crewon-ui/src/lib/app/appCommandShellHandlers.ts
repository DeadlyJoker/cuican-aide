import type { WorkMode } from "../workMode";
import type { ThreadRuntimeSettings } from "../thread/threadRuntimeSettings";

type CommandShellHandlersParams = {
  selectThread: (threadId: string) => void | Promise<void>;
  sendMessageInNewThread: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
  ) => void | Promise<void>;
  setComposerFocusSignal: (updater: (signal: number) => number) => void;
  setDraftWorkspaceCwd: (cwd: string | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setWorkMode: (mode: WorkMode) => void;
  startDraftThread: () => void;
};

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
    changeCommandShellWorkspace(nextCwd: string) {
      const trimmedCwd = nextCwd.trim();
      if (!trimmedCwd) {
        return;
      }
      setDraftWorkspaceCwd(trimmedCwd);
      setSelectedThreadId(null);
      setWorkMode("code");
      setComposerFocusSignal((signal) => signal + 1);
      if (typeof window !== "undefined") {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("cwd", trimmedCwd);
        nextUrl.hash = "#view-command";
        window.history.replaceState(
          null,
          "",
          `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
        );
      }
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
    ) {
      setSelectedThreadId(null);
      void sendMessageInNewThread(text, threadSettings);
    },
    startCommandShellDraftThread() {
      setWorkMode("code");
      startDraftThread();
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", "#view-command");
      }
    },
  };
}
