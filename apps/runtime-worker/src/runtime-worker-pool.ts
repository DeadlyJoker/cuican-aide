import { RuntimeWorkerPump } from "./runtime-worker-pump.ts";
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
    own(worker: { close(): void | Promise<void> }): void;
  }>,
) {
  const concurrency = runtimeWorkerConcurrency(input.concurrency);
  const workers: RuntimeWorker[] = [];
  const pumps: RuntimeWorkerPump[] = [];
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
    const config = input.config(index);
    const worker = new RuntimeWorker(dependencies, config);
    const pump = new RuntimeWorkerPump({
      wake: () => worker.wake(),
      scanIntervalMs:
        config.scanIntervalMs === undefined ? 1000 : config.scanIntervalMs,
    });
    // Register immediately: later construction failure still joins earlier lanes.
    input.own(worker);
    input.own(pump);
    workers.push(worker);
    pumps.push(pump);
  }
  const lanes = Object.freeze(workers);
  return Object.freeze({
    workers: lanes,
    notifyAvailability: () => {
      for (const pump of pumps) pump.notifyAvailability();
    },
    start: () => {
      for (const pump of pumps) pump.start();
    },
  });
}
