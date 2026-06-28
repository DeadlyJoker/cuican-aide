import type { Thread } from "@crewon-protocol/v2/Thread";

const DOMAIN_THREAD_SOURCES = new Set([
  "agent",
  "automation",
  "office",
  "office_automation_runtime",
  "office_member_runtime",
  "tool",
]);

export function isSingleConversationThread(thread: Thread): boolean {
  return (
    !thread.threadSource ||
    thread.threadSource === "app_server" ||
    !DOMAIN_THREAD_SOURCES.has(thread.threadSource)
  );
}
