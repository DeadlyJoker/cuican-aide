import type { Thread } from "@crewon-protocol/v2/Thread";

import { isAssistantThread } from "./assistantThread";

import { userMessageText } from "./threadModel";

const DOMAIN_THREAD_SOURCES = new Set([
  "agent",
  "automation",
  "office",
  "office_automation_runtime",
  "office_manager_runtime_v1",
  "office_member_runtime",
  "office_member_runtime_repair_v2",
  "tool",
]);

const OFFICE_THREAD_MARKERS = [
  " group chat message:",
  "群聊消息：",
  " recruited agent:",
  "招募智能体：",
  " created artifact:",
  "创建产物：",
  "Create office:",
  "创建办公室：",
  "Bind office:",
  "绑定办公室：",
  "Backend record: submitted to office/",
  "后端记录：已提交到 office/",
];

function isDomainThread(thread: Thread): boolean {
  return Boolean(thread.threadSource && DOMAIN_THREAD_SOURCES.has(thread.threadSource));
}

function threadText(thread: Thread): string {
  const turnText = thread.turns
    .flatMap((turn) => turn.items)
    .map(userMessageText)
    .filter(Boolean)
    .slice(0, 3);

  return [thread.name, thread.preview, ...turnText].filter(Boolean).join("\n");
}

function hasOfficeThreadMarker(thread: Thread): boolean {
  const text = threadText(thread);
  return OFFICE_THREAD_MARKERS.some((marker) => text.includes(marker));
}

export function isSingleConversationThread(thread: Thread): boolean {
  if (
    isAssistantThread(thread) ||
    isDomainThread(thread) ||
    hasOfficeThreadMarker(thread)
  ) {
    return false;
  }

  return (
    !thread.threadSource ||
    thread.threadSource === "app_server" ||
    !DOMAIN_THREAD_SOURCES.has(thread.threadSource)
  );
}
