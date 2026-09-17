export type ProcessShutdownHost = Readonly<{
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: 0 | 1): void;
}>;

export type ProcessShutdownController = Readonly<{
  request(reason: "requested" | "failure"): void;
  isRequested(): boolean;
}>;

/** One coordinator per CLI lifetime, installed before publishing readiness. */
export function installProcessShutdown(input: {
  host: ProcessShutdownHost;
  close(): void | Promise<void>;
  reportFailure(): void;
}): ProcessShutdownController {
  let requested = false;
  let failureRequested = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const finish = (outcome: "succeeded" | "failed") => {
    if (keepAlive !== null) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
    if (outcome === "failed") {
      try {
        input.reportFailure();
      } catch {
        // A failed diagnostic sink must not hide the unsuccessful shutdown.
      }
    }
    input.host.exit(outcome === "failed" || failureRequested ? 1 : 0);
  };
  const request: ProcessShutdownController["request"] = (reason) => {
    if (reason === "failure") failureRequested = true;
    if (requested) return;
    requested = true;
    // A pending Promise alone does not keep Node alive. Hold exactly one
    // referenced handle until cleanup settles; do not infer success from idle.
    keepAlive = setInterval(() => {}, 1000);
    let closing: void | Promise<void>;
    try {
      // Fence synchronously, including reentrant requests from close itself.
      closing = input.close();
    } catch {
      finish("failed");
      return;
    }
    void Promise.resolve(closing).then(
      () => finish("succeeded"),
      () => finish("failed"),
    );
  };
  // Keep both listeners until actual process exit. Removing a once listener
  // restores the default signal action and bypasses unfinished cleanup.
  const onSignal = () => request("requested");
  input.host.on("SIGINT", onSignal);
  input.host.on("SIGTERM", onSignal);
  return { request, isRequested: () => requested };
}
