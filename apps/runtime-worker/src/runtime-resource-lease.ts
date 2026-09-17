/** A borrowed resource remains usable until its final physical caller releases it. */
export type RuntimeResourceLease<T> = Readonly<{
  resource: T;
  /** Idempotent and non-throwing; release bookkeeping must not perform I/O. */
  release(): void;
}>;

/** Compatibility for resources whose lifetime is owned outside this resolver. */
export function externalResourceLease<T>(resource: T): RuntimeResourceLease<T> {
  return { resource, release() {} };
}

export class RuntimeResourceOwner<T> {
  readonly #resource: T;
  readonly #dispose: () => void | Promise<void>;
  #users = 0;
  #closing = false;
  #closeTask: Promise<void> | null = null;
  #beginDispose: (() => void) | null = null;

  constructor(resource: T, dispose: () => void | Promise<void>) {
    this.#resource = resource;
    this.#dispose = dispose;
  }

  acquire(): RuntimeResourceLease<T> | null {
    if (this.#closing) return null;
    this.#users++;
    let released = false;
    return {
      resource: this.#resource,
      release: () => {
        if (released) return;
        released = true;
        this.#users--;
        if (this.#users === 0) this.#beginDispose?.();
      },
    };
  }

  close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#closing = true;
    this.#closeTask = new Promise<void>((resolve, reject) => {
      this.#beginDispose = () => {
        this.#beginDispose = null;
        void Promise.resolve().then(this.#dispose).then(resolve, reject);
      };
      if (this.#users === 0) this.#beginDispose();
    });
    return this.#closeTask;
  }

  get users(): number {
    return this.#users;
  }
}

/** A wake may end logically while a timed-out prerequisite still uses its resources. */
export class RuntimeResourceScope {
  readonly #leases = new Set<RuntimeResourceLease<unknown>>();
  #operations = 0;
  #closed = false;

  use<T>(lease: RuntimeResourceLease<T>): T {
    if (this.#closed && this.#operations === 0) {
      lease.release();
      throw new Error("runtime_resource_scope_closed");
    }
    this.#leases.add(lease);
    return lease.resource;
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("runtime_resource_scope_closed");
    this.#operations++;
    try {
      return await operation();
    } finally {
      this.#operations--;
      this.#releaseIfFinished();
    }
  }

  close(): void {
    this.#closed = true;
    this.#releaseIfFinished();
  }

  #releaseIfFinished(): void {
    if (!this.#closed || this.#operations !== 0) return;
    const leases = [...this.#leases];
    this.#leases.clear();
    for (const lease of leases) lease.release();
  }
}
