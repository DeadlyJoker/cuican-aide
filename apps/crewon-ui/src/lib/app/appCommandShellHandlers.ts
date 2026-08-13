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
  setSelectedThreadId: (threadId: string | null) => void;
  setWorkMode: (mode: WorkMode) => void;
  startDraftThread: () => void;
};

export function createAppCommandShellHandlers({
  selectThread,
  sendMessageInNewThread,
  setSelectedThreadId,
  setWorkMode,
  startDraftThread,
}: CommandShellHandlersParams) {
  return {
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
      images?: ComposerImageInput[],
    ) {
      setSelectedThreadId(null);
      if (images?.length) {
        void sendMessageInNewThread(text, threadSettings, null, images);
      } else {
        void sendMessageInNewThread(text, threadSettings, null);
      }
    },
    startCommandShellDraftThread() {
      setWorkMode("code");
      startDraftThread();
    },
  };
}
