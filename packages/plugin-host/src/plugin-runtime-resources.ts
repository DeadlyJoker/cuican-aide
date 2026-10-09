import type {
  PluginAbortSignal,
  PluginOwnedResource,
  PluginRuntimeResources,
} from "@crewon/plugin-sdk/node";

type Record = {
  settled: Promise<void>;
  dispose: (() => Promise<void>) | null;
};

/** Lifecycle ownership only; factories still need per-call host authorization. */
export class PluginRuntimeResourceOwner {
  readonly #records = new Set<Record>();
  readonly #controller = new AbortController();
  readonly #canAcquire: () => boolean;
  #closing: Promise<void> | null = null;

  constructor(canAcquire: () => boolean) {
    this.#canAcquire = canAcquire;
  }

  readonly api: PluginRuntimeResources = Object.freeze({
    apiVersion: "1",
    acquire: <T>(
      factory: (
        input: Readonly<{ signal: PluginAbortSignal }>,
      ) => PluginOwnedResource<T> | Promise<PluginOwnedResource<T>>,
    ) => this.#acquire(factory),
  });

  withdraw(): void {
    this.#controller.abort(new Error("plugin_resource_withdrawn"));
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.withdraw();
    this.#closing = this.#close();
    return this.#closing;
  }

  async #acquire<T>(
    factory: (
      input: Readonly<{ signal: PluginAbortSignal }>,
    ) => PluginOwnedResource<T> | Promise<PluginOwnedResource<T>>,
  ): Promise<PluginOwnedResource<T>> {
    if (this.#controller.signal.aborted || !this.#canAcquire())
      throw new Error("plugin_resource_unavailable");
    if (typeof factory !== "function")
      throw new Error("plugin_resource_factory_invalid");
    if (this.#records.size >= 512) throw new Error("plugin_resource_limit");
    let finish!: () => void;
    const record: Record = {
      settled: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      dispose: null,
    };
    this.#records.add(record);
    try {
      const resource = await factory(
        Object.freeze({ signal: this.#controller.signal }),
      );
      if (!resource || typeof resource.dispose !== "function")
        throw new Error("plugin_resource_invalid");
      const dispose = resource.dispose.bind(resource);
      let disposal: Promise<void> | null = null;
      const owned = Object.freeze({
        get value() {
          return resource.value;
        },
        dispose: () => {
          if (disposal !== null) return disposal;
          disposal = Promise.resolve()
            .then(dispose)
            .then(() => {
              this.#records.delete(record);
            });
          return disposal;
        },
      });
      record.dispose = owned.dispose;
      if (this.#controller.signal.aborted || !this.#canAcquire()) {
        await owned.dispose();
        throw new Error("plugin_resource_withdrawn");
      }
      return owned;
    } catch (error) {
      // No acquired resource, or successful disposal, is not a cleanup failure.
      if (record.dispose === null) this.#records.delete(record);
      throw error;
    } finally {
      finish();
    }
  }

  async #close(): Promise<void> {
    await Promise.all([...this.#records].map((record) => record.settled));
    const failures: unknown[] = [];
    for (const record of [...this.#records].reverse()) {
      try {
        await record.dispose?.();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "plugin_resource_cleanup_failed");
  }
}

export async function collectPluginCleanupFailures(
  resources: PluginRuntimeResourceOwner | null,
  callbacks: Array<() => void | Promise<void>>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const cleanup of [() => resources?.close(), ...callbacks.reverse()]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
