import { ApplicationError } from "@crewon/application";

/** One profile serializes the entire Application operation, observation and instance projection. */
export class DesktopPluginProfileOperationQueue {
  readonly #assertAvailable: () => void;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(assertAvailable: () => void) {
    this.#assertAvailable = assertAvailable;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    this.#assertAvailable();
    if (this.#pending >= 32)
      throw new ApplicationError(
        "conflict",
        "plugin_installation_profile_busy",
      );
    this.#pending++;
    const pending = this.#tail.then(async () => {
      this.#assertAvailable();
      return work();
    });
    this.#tail = pending.then(
      () => {},
      () => {},
    );
    return pending.finally(() => {
      this.#pending--;
    });
  }

  /** The owning profile fences new entry first, then joins every admitted operation. */
  drain(): Promise<void> {
    return this.#tail;
  }
}
