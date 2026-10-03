import { pluginUiControlRequest } from "./controlPluginUiSupport";
import { awaitPluginUiOperation } from "./pluginUiValidation";

const MAXIMUM_WAITERS = 16;
type RequestPool = { physical: Promise<unknown> | null; waiters: number };
const pools = new WeakMap<object, RequestPool>();

/** A logical cancellation never releases an HTTP request that has not actually settled. */
export async function installedPluginTaskRequest<T>(
  client: object,
  read: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  let pool = pools.get(client);
  if (!pool) {
    pool = { physical: null, waiters: 0 };
    pools.set(client, pool);
  }
  if (pool.waiters >= MAXIMUM_WAITERS)
    throw new Error("plugin_task_request_capacity");
  const owned = pool;
  owned.waiters += 1;
  try {
    return await pluginUiControlRequest(async (signal) => {
      while (owned.physical) {
        await awaitPluginUiOperation(
          owned.physical.catch(() => undefined),
          signal,
        );
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      // Register physical ownership before invoking a potentially reentrant port.
      const actual = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return read(signal);
      });
      owned.physical = actual;
      void actual.then(
        () => {
          if (owned.physical === actual) owned.physical = null;
        },
        () => {
          if (owned.physical === actual) owned.physical = null;
        },
      );
      return actual;
    }, parent);
  } finally {
    const release = () => {
      owned.waiters -= 1;
    };
    // Aborted waiters still attach to the pending physical promise. Keep their bounded slots until that promise settles.
    if (owned.physical) void owned.physical.then(release, release);
    else release();
  }
}
