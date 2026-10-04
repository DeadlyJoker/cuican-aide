export type RuntimeStoppedMutationOptions<T> = Readonly<{
  mutation(): Promise<T>;
  /** Wrap only the synchronous call to stop when identifying its own invalidation. */
  onStopInvalidation(stop: () => Promise<void>): Promise<void>;
}>;

export type RuntimeStoppedMutationResult<T> = Readonly<{
  value: T;
  runtimeStatus: "ready" | "restartRequired";
}>;

export type RuntimeStoppedMutationPort = Readonly<{
  stop(): Promise<void>;
  start(): Promise<void>;
  assertReady(): void;
}>;

/** The caller must place this entire physical operation in its existing restart queue. */
export async function runRuntimeStoppedMutation<T>(
  options: RuntimeStoppedMutationOptions<T>,
  runtime: RuntimeStoppedMutationPort,
): Promise<RuntimeStoppedMutationResult<T>> {
  let physicalStop: Promise<void> | undefined;
  let stopInvoked = false;
  let wrapperOpen = true;
  let wrapperFailed = false;
  let wrapperFailure: unknown;
  try {
    await options.onStopInvalidation(() => {
      if (!wrapperOpen)
        throw new Error("desktop_runtime_mutation_stop_scope_closed");
      if (stopInvoked)
        throw new Error("desktop_runtime_mutation_stop_already_called");
      stopInvoked = true;
      // Capture a synchronous throw as the same physical stop failure.
      try {
        physicalStop = runtime.stop();
      } catch (error) {
        physicalStop = Promise.reject(error);
      }
      void physicalStop.catch(() => {});
      return physicalStop;
    });
  } catch (error) {
    wrapperFailed = true;
    wrapperFailure = error;
  } finally {
    wrapperOpen = false;
  }
  if (physicalStop === undefined) {
    if (wrapperFailed) throw wrapperFailure;
    throw new Error("desktop_runtime_mutation_stop_not_called");
  }
  // A wrapper that returns or rejects early cannot detach the actual stop.
  try {
    await physicalStop;
  } catch (error) {
    if (wrapperFailed && wrapperFailure !== error)
      throw new AggregateError(
        [error, wrapperFailure],
        "desktop_runtime_mutation_stop_failed",
      );
    throw error;
  }
  if (wrapperFailed) throw wrapperFailure;

  let value: T;
  try {
    value = await options.mutation();
  } catch (error) {
    // No successful mutation result was returned. Restore the previous runtime
    // where possible, but never replace the original mutation failure.
    try {
      await runtime.start();
    } catch {
      // The caller still receives the original failure and can request a restart.
    }
    throw error;
  }

  try {
    await runtime.start();
    runtime.assertReady();
    return Object.freeze({ value, runtimeStatus: "ready" });
  } catch {
    // The mutation has its own commit point. Startup failure cannot undo it.
    return Object.freeze({ value, runtimeStatus: "restartRequired" });
  }
}
