/** Withdraw one request's wait without canceling shared account token work. */
export function waitForAgentPlatformRequest<T>(input: {
  pending: Promise<T>;
  signal?: AbortSignal | null;
}): Promise<T> {
  const { pending, signal } = input;
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(signal.aborted ? signal.reason : error);
      },
    );
    if (signal.aborted) abort();
  });
}
