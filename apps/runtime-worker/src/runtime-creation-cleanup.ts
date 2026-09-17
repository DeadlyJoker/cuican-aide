import type { FailedRuntimeCreationCleanup } from "./agent-runtime-capacity.ts";

export type RuntimeCreationOptions = Readonly<{
  failedCreationCleanup?: FailedRuntimeCreationCleanup;
}>;

type Closeable = { close?(): void | Promise<void> };

/** Local to one construction attempt; success transfers ownership to its result. */
export class RuntimeCreationCleanup {
  readonly #owners = new Set<Closeable>();
  #unknown = 0;
  #transferred = false;
  #clean = false;
  #notified = false;
  #cleanup: Promise<void> | null = null;
  readonly #confirmation: FailedRuntimeCreationCleanup | undefined;

  constructor(confirmation?: FailedRuntimeCreationCleanup) {
    this.#confirmation = confirmation;
  }

  own<T extends Closeable>(owner: T): T {
    this.#owners.add(owner);
    return owner;
  }

  /** Used where no returned object can prove disposal of a nested allocation. */
  requireConfirmation(): FailedRuntimeCreationCleanup {
    this.#unknown++;
    let confirmed = false;
    return {
      confirmReleased: () => {
        if (confirmed) return;
        confirmed = true;
        this.#unknown--;
        this.#confirm();
      },
    };
  }

  async create<T extends Closeable>(
    creator: (options: RuntimeCreationOptions) => T | Promise<T>,
  ): Promise<T> {
    const child = this.requireConfirmation();
    const owner = await creator({ failedCreationCleanup: child });
    this.own(owner);
    // The returned owner now bears disposal responsibility, even if a creator
    // had previously confirmed an allocation-free phase.
    child.confirmReleased();
    return owner;
  }

  transfer(): void {
    this.#transferred = true;
    this.#owners.clear();
  }

  /** Always preserve the caller's original failure, including synchronous closes. */
  cleanup(): Promise<void> {
    this.#cleanup ??= Promise.allSettled(
      [...this.#owners].map((owner) =>
        Promise.resolve().then(() => owner.close?.()),
      ),
    ).then((results) => {
      this.#owners.clear();
      this.#clean = results.every((result) => result.status === "fulfilled");
      this.#confirm();
    });
    return this.#cleanup;
  }

  #confirm(): void {
    if (this.#notified || this.#transferred || !this.#clean || this.#unknown)
      return;
    this.#notified = true;
    this.#confirmation?.confirmReleased();
  }
}

/** Only for audited synchronous constructors that begin no external operations. */
export function createWithoutExternalAllocation<T>(
  create: () => T,
  options: RuntimeCreationOptions,
): T {
  try {
    return create();
  } catch (error) {
    options.failedCreationCleanup?.confirmReleased();
    throw error;
  }
}
