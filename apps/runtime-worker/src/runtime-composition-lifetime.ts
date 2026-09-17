export type RuntimeClosePhase = "stop" | "resources" | "storage";
export type RuntimeCleanupHandle = Readonly<{
  close(): Promise<void>;
  /** A registered parent now owns this close; remove it from root cleanup. */
  delegate(): void;
}>;

type Closeable = { close?(): void | Promise<void> };

/** One startup/teardown transaction, shared by success and every failure path. */
export class RuntimeCompositionLifetime {
  readonly #handles = new WeakMap<object, RuntimeCleanupHandle>();
  readonly #phases: Record<RuntimeClosePhase, Set<RuntimeCleanupHandle>> = {
    stop: new Set(),
    resources: new Set(),
    storage: new Set(),
  };
  #closing: Promise<void> | null = null;

  own(
    resource: Closeable,
    options: { phase: RuntimeClosePhase },
  ): RuntimeCleanupHandle {
    const existing = this.#handles.get(resource);
    if (existing !== undefined) return existing;
    if (this.#closing !== null) throw new Error("runtime_composition_closed");
    const phase = this.#phases[options.phase];
    let task: Promise<void> | null = null;
    let target: Closeable | null = resource;
    const handle: RuntimeCleanupHandle = {
      close: () => {
        if (task !== null) return task;
        let resolve!: () => void, reject!: (error: unknown) => void;
        task = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        // Invoke synchronously so Worker/resolver fences take effect before
        // close returns. Still isolate each synchronous failure from siblings.
        try {
          Promise.resolve(target!.close?.()).then(() => {
            target = null;
            phase.delete(handle);
            resolve();
          }, reject);
        } catch (error) {
          reject(error);
        }
        return task;
      },
      delegate: () => {
        phase.delete(handle);
      },
    };
    phase.add(handle);
    this.#handles.set(resource, handle);
    return handle;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.#closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void this.#closePhases().then(resolve, reject);
    return this.#closing;
  }

  async #closePhases(): Promise<void> {
    const failures: unknown[] = [];
    for (const phase of ["stop", "resources", "storage"] as const) {
      const results = await Promise.allSettled(
        [...this.#phases[phase]].map((owner) => owner.close()),
      );
      for (const result of results)
        if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "runtime_close_failed");
  }
}

/** Parent disposers share the same input handles used during startup unwind. */
export async function closeRuntimeResources(
  handles: readonly RuntimeCleanupHandle[],
): Promise<void> {
  const results = await Promise.allSettled(
    [...new Set(handles)].map((handle) => handle.close()),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, "runtime_resources_close_failed");
}
