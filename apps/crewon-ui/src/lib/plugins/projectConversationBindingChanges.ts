import type { ControlApiClient } from "@crewon/control-client";

const listeners = new WeakMap<ControlApiClient, Map<string, Set<() => void>>>();

/** A local read invalidation only. The composer reloads its authenticated binding. */
export function notifyProjectConversationBindingChanged(
  client: ControlApiClient,
  threadId: string,
): void {
  for (const listener of listeners.get(client)?.get(threadId) ?? []) listener();
}

export function subscribeProjectConversationBindingChanges(
  client: ControlApiClient,
  threadId: string,
  listener: () => void,
): () => void {
  const threads = listeners.get(client) ?? new Map<string, Set<() => void>>();
  listeners.set(client, threads);
  const thread = threads.get(threadId) ?? new Set<() => void>();
  threads.set(threadId, thread);
  thread.add(listener);
  return () => {
    thread.delete(listener);
    if (thread.size === 0) threads.delete(threadId);
    if (threads.size === 0) listeners.delete(client);
  };
}
