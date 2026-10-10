import { RuntimeWorker, type RuntimeWorkerConfig } from "./runtime-worker.ts";

export function runtimeWorkerConcurrency(value: number | undefined): number {
  const concurrency = value ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("runtime_worker_concurrency_invalid");
  return concurrency;
}

/** Each lane owns its leases, cancellation watchers and Store access fence. */
export function createRuntimeWorkerPool(
  input: Readonly<{
    concurrency: number;
    dependencies: ConstructorParameters<typeof RuntimeWorker>[0];
    config(index: number): RuntimeWorkerConfig;
    own(worker: RuntimeWorker): void;
  }>,
) {
  const concurrency = runtimeWorkerConcurrency(input.concurrency);
  const workers: RuntimeWorker[] = [];
  // The composition owns financial maintenance once. Lanes only borrow poll.
  const maintenance = input.dependencies.pluginCreditSettlement;
  const dependencies = {
    ...input.dependencies,
    ...(maintenance === undefined
      ? {}
      : {
          pluginCreditSettlement: {
            poll: () => maintenance.poll(),
            close: async () => {},
          },
        }),
  };
  for (let index = 0; index < concurrency; index++) {
    const worker = new RuntimeWorker(dependencies, input.config(index));
    // Register immediately: later construction failure still joins earlier lanes.
    input.own(worker);
    workers.push(worker);
  }
  const lanes = Object.freeze(workers);
  return Object.freeze({
    workers: lanes,
    start: () => {
      for (const worker of lanes) worker.start();
    },
  });
}
