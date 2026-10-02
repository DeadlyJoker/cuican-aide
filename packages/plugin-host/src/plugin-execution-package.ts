import type {
  PluginIdentity,
  PluginToolRuntimeFactory,
} from "@crewon/plugin-sdk/node";
import {
  PluginNodeHost,
  type PluginNodeActivation,
  type PluginNodeBorrow,
  type PluginNodePreparedCommit,
} from "./plugin-node-host.ts";
import { PluginExecutionRegistry } from "./plugin-execution-registry.ts";

export type PluginExecutionPackageBorrow = Readonly<{
  identity: PluginIdentity;
  factory: PluginToolRuntimeFactory;
  /** Keep the borrow until every created runtime and physical call has finished. */
  release(): void;
}>;

export type PluginExecutionPackageFailureOwner = Readonly<{
  /** Failed cleanup is still owned; closing never invents physical disposal. */
  close(): Promise<void>;
}>;

const failureOwners = new WeakMap<object, PluginExecutionPackageFailureOwner>();

/** Only the actual startup error carries ownership; matching error text grants nothing. */
export function pluginExecutionPackageFailureOwner(
  error: unknown,
): PluginExecutionPackageFailureOwner | null {
  return error !== null && typeof error === "object"
    ? (failureOwners.get(error) ?? null)
    : null;
}

/**
 * A private Node host for one exact installed package, including cold historical loads.
 * It never changes another host's current selection or exposes its service discovery.
 * Only the execution host service is available; dependency graphs require a separate
 * persisted lock and are deliberately not resolved from today's selection here.
 */
export class PluginExecutionPackage {
  readonly #identity: PluginIdentity;
  readonly #host: PluginNodeHost;
  readonly #registry: PluginExecutionRegistry;
  #closed = false;

  private constructor(
    identity: PluginIdentity,
    host: PluginNodeHost,
    registry: PluginExecutionRegistry,
  ) {
    this.#identity = identity;
    this.#host = host;
    this.#registry = registry;
  }

  static async open(
    input: Readonly<{
      activation: PluginNodeActivation;
      /** Re-read asynchronous current authority after setup and before the synchronous commit gate. */
      beforeCommit?(): Promise<void>;
      /** Current host authority, checked after verified ESM setup, before publication. */
      commit: PluginNodePreparedCommit;
    }>,
  ): Promise<PluginExecutionPackage> {
    const beforeCommit = input.beforeCommit;
    if (beforeCommit !== undefined && typeof beforeCommit !== "function")
      throw new Error("plugin_execution_before_commit_invalid");
    const registry = new PluginExecutionRegistry({ maximumFactories: 1 });
    const host = new PluginNodeHost({ services: [registry.hostService()] });
    let prepared: Awaited<ReturnType<PluginNodeHost["prepare"]>> | null = null;
    try {
      prepared = await host.prepare(input.activation);
      await beforeCommit?.();
      const identity = prepared.commit(input.commit);
      // A successfully loaded Node package must actually register its factory.
      const lease = host.acquire({
        pluginId: identity.pluginId,
        packageDigest: identity.packageDigest,
        purpose: "newOperation",
        authorizeBorrow: () => "allow",
      });
      try {
        registry.acquire(lease);
      } finally {
        lease.release();
      }
      return new PluginExecutionPackage(identity, host, registry);
    } catch (error) {
      registry.close();
      const failures: unknown[] = [];
      for (const cleanup of [
        () => prepared?.abort() ?? Promise.resolve(),
        () => host.close(),
      ]) {
        try {
          await cleanup();
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length) {
        const failed = new AggregateError(
          [error, ...failures],
          "plugin_execution_package_start_failed",
        );
        failureOwners.set(
          failed,
          Object.freeze({
            close: async () => {
              registry.close();
              await host.close();
            },
          }),
        );
        throw failed;
      }
      throw error;
    }
  }

  get identity(): PluginIdentity {
    return this.#identity;
  }

  acquire(
    input: Pick<PluginNodeBorrow, "purpose" | "authorizeBorrow">,
  ): PluginExecutionPackageBorrow {
    if (this.#closed) throw new Error("plugin_execution_package_closed");
    const lease = this.#host.acquire({
      ...input,
      pluginId: this.identity.pluginId,
      packageDigest: this.identity.packageDigest,
    });
    try {
      const factory = this.#registry.acquire(lease);
      return Object.freeze({
        identity: lease.identity,
        factory,
        release: lease.release,
      });
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  /**
   * Withdraws new factories immediately. A live borrow is an error, not proof of
   * completion; release it after physical work, then retry cleanup. Runtime close
   * remains the caller's responsibility and is never guessed from empty scans.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#registry.close();
    await this.#host.close();
  }
}
