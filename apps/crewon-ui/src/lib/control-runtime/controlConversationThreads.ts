import type { ThreadView } from "@crewon/contracts";

import { isInternalControlExpertThread } from "./controlExpertRuntime";
import { isInternalControlWorkflowThread } from "./controlWorkflowRuntime";

/** Match sidebar visibility before conversation bootstrap/search chooses a Thread. */
export function isControlConversationThread(thread: ThreadView): boolean {
  return (
    thread.forkedFromThreadId === null &&
    !isInternalControlExpertThread(thread) &&
    !isInternalControlWorkflowThread(thread)
  );
}
