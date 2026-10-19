import { pluginUiControlRequest } from "./controlPluginUiSupport";
import { awaitPluginUiOperation } from "./pluginUiValidation";

const MAXIMUM_WAITERS = 16;
const MAXIMUM_PARALLEL_READS = 4;
type Access = "read" | "exclusive";
type PhysicalRequest = { access: Access };

function createRequestPool() {
  let wake = () => {};
  const pool = {
    physical: new Set<PhysicalRequest>(),
    queued: new Set<{ access: Access }>(),
    changed: Promise.resolve(),
    notify() {
      wake();
      pool.changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
    },
  };
  pool.notify();
  return pool;
}
const pools = new WeakMap<object, ReturnType<typeof createRequestPool>>();

/** Reads share capacity in arrival order; writes fence all later arrivals. */
async function sharedRequest<T>(
  client: object,
  request: (signal: AbortSignal) => Promise<T>,
  { parent, access }: { parent?: AbortSignal; access: Access },
): Promise<T> {
  let pool = pools.get(client);
  if (!pool) {
    pool = createRequestPool();
    pools.set(client, pool);
  }
  if (pool.queued.size + pool.physical.size >= MAXIMUM_WAITERS)
    throw new Error("plugin_task_request_capacity");
  const owned = pool;
  const ticket = { access };
  owned.queued.add(ticket);
  try {
    return await pluginUiControlRequest(async (signal) => {
      const blocked = () => {
        for (const earlier of owned.queued) {
          if (earlier === ticket) break;
          if (access === "exclusive" || earlier.access === "exclusive")
            return true;
        }
        return (
          owned.physical.size > 0 &&
          (access === "exclusive" ||
            owned.physical.size >= MAXIMUM_PARALLEL_READS ||
            [...owned.physical].some((active) => active.access === "exclusive"))
        );
      };
      while (blocked()) await awaitPluginUiOperation(owned.changed, signal);
      signal.throwIfAborted();
      // Register ownership before invoking a potentially reentrant port.
      const physical = { access };
      owned.physical.add(physical);
      owned.queued.delete(ticket);
      owned.notify();
      const actual = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return request(signal);
      });
      const release = () => {
        owned.physical.delete(physical);
        owned.notify();
      };
      // Logical cancellation must not release an HTTP request that ignores abort.
      void actual.then(release, release);
      return actual;
    }, parent);
  } finally {
    if (owned.queued.delete(ticket)) owned.notify();
  }
}

/** Writes and confirmation sequences retain the exclusive default. */
export function installedPluginTaskRequest<T>(
  client: object,
  request: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  return sharedRequest(client, request, { parent, access: "exclusive" });
}

/** Independent reads share bounded capacity; writes retain the exclusive default. */
export function installedPluginTaskRead<T>(
  client: object,
  request: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  return sharedRequest(client, request, { parent, access: "read" });
}
