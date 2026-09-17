import { useCallback, useEffect, useMemo } from "react";

export type ThreadSelectionRead = <T>(
  threadId: string,
  read: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

type Request = { threadId: string; controller: AbortController };

/** One page-owned selection read; authoritative refreshes use their own lifetime. */
export function useThreadSelectionRead(params: {
  identity: object | null;
  selectedThreadId: string | null;
}): ThreadSelectionRead {
  const owner = useMemo(
    () => ({ request: null as Request | null, closed: false }),
    [params.identity],
  );
  useEffect(() => {
    owner.closed = false;
    return () => {
      owner.closed = true;
      owner.request?.controller.abort();
      owner.request = null;
    };
  }, [owner]);
  useEffect(() => {
    if (owner.request && owner.request.threadId !== params.selectedThreadId) {
      owner.request.controller.abort();
      owner.request = null;
    }
  }, [owner, params.selectedThreadId]);
  return useCallback(
    async (threadId, read) => {
      if (owner.closed)
        throw new DOMException("Selection read canceled", "AbortError");
      const request = { threadId, controller: new AbortController() };
      owner.request?.controller.abort();
      owner.request = request;
      try {
        const result = await waitForSelectionRead(
          read(request.controller.signal),
          request.controller.signal,
        );
        request.controller.signal.throwIfAborted();
        return result;
      } finally {
        if (owner.request === request) owner.request = null;
        request.controller.abort(new Error("thread_selection_read_finished"));
      }
    },
    [owner],
  );
}

function waitForSelectionRead<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
