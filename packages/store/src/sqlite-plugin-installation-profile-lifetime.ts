import type { SqlitePluginInstallationProfileOwner } from "./sqlite-plugin-installation-profile-owner.ts";

/** The parent Store withdraws owners synchronously and joins their real sessions before closing SQLite. */
export class SqlitePluginInstallationProfileLifetime {
  readonly #owners = new Set<SqlitePluginInstallationProfileOwner>();
  #closing: Promise<void> | null = null;

  register(owner: SqlitePluginInstallationProfileOwner): () => void {
    if (this.#closing) throw new Error("plugin_profile_owner_host_closed");
    this.#owners.add(owner);
    return () => {
      this.#owners.delete(owner);
    };
  }

  close(
    input: Readonly<{ markHostClosed(): void; closeDatabase(): void }>,
  ): Promise<void> {
    if (this.#closing) return this.#closing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.#closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    input.markHostClosed();
    const owners = [...this.#owners].map((owner) => owner.close());
    const finish = (results: readonly PromiseSettledResult<void>[]) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      try {
        input.closeDatabase();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        reject(
          new AggregateError(
            failures,
            "sqlite_plugin_profile_owner_close_failed",
          ),
        );
      else resolve();
    };
    // Preserve immediate database close for the original path with no acquired plugin owner.
    if (owners.length === 0) finish([]);
    else void Promise.allSettled(owners).then(finish);
    return this.#closing;
  }
}
