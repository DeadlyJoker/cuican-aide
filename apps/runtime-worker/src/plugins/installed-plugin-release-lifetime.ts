import { installedPluginReleaseFailure } from "./installed-plugin-release-document.ts";

/** Owns metadata/creation work only; successful runtimes transfer to their real registry/caller. */
export class InstalledPluginReleaseLifetime {
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #failedOwners = new Set<Readonly<{ close(): Promise<void> }>>();
  #closed = false;
  #closing: Promise<void> | null = null;

  assertLive(): void {
    if (this.#closed) installedPluginReleaseFailure("closed");
  }

  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertLive();
    if (this.#pending.size + this.#failedOwners.size >= 32)
      installedPluginReleaseFailure("capacity_exhausted");
    // Defer invocation until the real Promise is registered for physical close joining.
    const task = Promise.resolve().then(() => {
      this.assertLive();
      return operation(this.#controller.signal);
    });
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }

  retainFailedOwner(owner: Readonly<{ close(): Promise<void> }>): void {
    this.#failedOwners.add(owner);
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#controller.abort(new Error("installed_plugin_release_closed"));
    this.#closing = Promise.allSettled([...this.#pending]).then(async () => {
      const owners = [...this.#failedOwners];
      const results = await Promise.allSettled(
        owners.map(async (owner) => {
          await owner.close();
          this.#failedOwners.delete(owner);
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length)
        throw new AggregateError(
          errors,
          "installed_plugin_release_cleanup_failed",
        );
    });
    return this.#closing;
  }
}
