type Listener = () => void;
const owners = new WeakMap<object, Map<string, Set<Listener>>>();

/** Share the existing authenticated Thread stream; never open another polling loop. */
export function subscribeControlThreadRevision(
  owner: object,
  threadId: string,
  listener: Listener,
): () => void {
  let threads = owners.get(owner);
  if (!threads) {
    threads = new Map();
    owners.set(owner, threads);
  }
  let listeners = threads.get(threadId);
  if (!listeners) {
    listeners = new Set();
    threads.set(threadId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) threads.delete(threadId);
  };
}

export function publishControlThreadRevision(
  owner: object,
  threadId: string,
): void {
  for (const listener of [...(owners.get(owner)?.get(threadId) ?? [])]) {
    try {
      listener();
    } catch {
      /* A presentation listener cannot interrupt the canonical stream. */
    }
  }
}
