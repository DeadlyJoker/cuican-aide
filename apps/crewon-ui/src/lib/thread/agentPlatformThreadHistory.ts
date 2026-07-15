import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";

import type { AppServerClient } from "../app-server/appServer";
import { getAgentPlatformAccessToken } from "../agent-platform/agentPlatformClient";
import { createDemoTurn } from "../demo/demoData";
import { AGENT_PLATFORM_THREAD_SOURCE_PREFIX } from "./threadRuntimeSettings";

type AgentPlatformSessionClient = Pick<
  AppServerClient,
  "readAgentPlatformSession"
>;

export function agentPlatformAgentIdFromThreadSource(
  threadSource: string | null | undefined,
): string | null {
  if (!threadSource?.startsWith(AGENT_PLATFORM_THREAD_SOURCE_PREFIX)) {
    return null;
  }
  const agentId = threadSource.slice(AGENT_PLATFORM_THREAD_SOURCE_PREFIX.length);
  return agentId || null;
}

export function restoredAgentPlatformTurns(
  messages: Array<{ role: string; content: string }>,
): Turn[] {
  const turns: Turn[] = [];
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user.role !== "user" || assistant.role !== "assistant") continue;
    turns.push(
      createDemoTurn({
        text: user.content,
        responseText: assistant.content,
        nowMs: index + 1,
      }),
    );
  }
  return turns;
}

export async function restoreAgentPlatformThread({
  client,
  readAccessToken = getAgentPlatformAccessToken,
  thread,
}: {
  client: AgentPlatformSessionClient;
  readAccessToken?: () => Promise<string | null>;
  thread: Thread;
}): Promise<Thread> {
  const agentId = agentPlatformAgentIdFromThreadSource(thread.threadSource);
  if (!agentId || thread.turns.length > 0) {
    return thread;
  }
  const accessToken = await readAccessToken();
  if (!accessToken) {
    return thread;
  }
  const messages = await client.readAgentPlatformSession(
    accessToken,
    thread.id,
    agentId,
  );
  const turns = restoredAgentPlatformTurns(messages);
  return turns.length > 0 ? { ...thread, turns } : thread;
}
