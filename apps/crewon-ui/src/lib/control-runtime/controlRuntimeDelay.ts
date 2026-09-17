/** Resolves on timeout or cancellation; callers decide whether cancellation throws. */
export function waitForControlRuntimeDelay({
  delayMs,
  signal,
}: Readonly<{ delayMs: number; signal: AbortSignal }>): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
