import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "./agentPlatformSessionEvents";
import type { AgentPlatformUser } from "./agentPlatformSession";

export type AgentPlatformAccountState =
  | Readonly<{ status: "anonymous"; error: string | null }>
  | Readonly<{ status: "authenticated"; user: AgentPlatformUser }>
  | Readonly<{ status: "restoring"; unavailable: boolean }>;

type Dependencies = Readonly<{
  read(signal: AbortSignal): Promise<AgentPlatformUser | null>;
  hasCredentials(): boolean;
  isTransient(error: unknown): boolean;
  events: EventTarget;
}>;
type Operation = {
  controller: AbortController;
  epoch: number;
  slowTimer: ReturnType<typeof setTimeout>;
  deadlineTimer: ReturnType<typeof setTimeout>;
};
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const;

/** Owns restoration only. Saved credentials never stand in for a verified user. */
export class AgentPlatformAccountRestoration {
  readonly #dependencies: Dependencies;
  readonly #listeners = new Set<(state: AgentPlatformAccountState) => void>();
  #state: AgentPlatformAccountState = {
    status: "restoring",
    unavailable: false,
  };
  #pending: Operation | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryStep = 0;
  #epoch = 0;
  #paused = false;
  #attached = false;
  #restartRequested = false;

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }
  get state(): AgentPlatformAccountState {
    return this.#state;
  }
  subscribe(listener: (state: AgentPlatformAccountState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    if (!this.#attached) {
      this.#attached = true;
      for (const name of ["online", "focus"])
        this.#dependencies.events.addEventListener(name, this.#wake);
      this.#dependencies.events.addEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        this.#sessionChanged,
      );
      // StrictMode's replacement subscriber shares this initial read.
      queueMicrotask(() => {
        if (this.#listeners.size && !this.#paused) this.#request();
      });
    }
    return () => {
      this.#listeners.delete(listener);
      queueMicrotask(() => {
        if (this.#listeners.size || !this.#attached) return;
        this.#attached = false;
        for (const name of ["online", "focus"])
          this.#dependencies.events.removeEventListener(name, this.#wake);
        this.#dependencies.events.removeEventListener(
          AGENT_PLATFORM_SESSION_CHANGED_EVENT,
          this.#sessionChanged,
        );
        this.#withdraw();
        this.#paused = false;
        this.#state = { status: "restoring", unavailable: false };
      });
    };
  }
  /** Explicit account actions supersede every automatic read before mutation. */
  suspend(): void {
    this.#paused = true;
    this.#withdraw();
  }
  resume(): void {
    this.#paused = false;
    this.#sessionChanged();
  }
  accept(user: AgentPlatformUser | null, error: string | null = null): void {
    this.#withdraw();
    this.#paused = false;
    this.#retryStep = 0;
    this.#publish(
      user ? { status: "authenticated", user } : { status: "anonymous", error },
    );
  }
  #publish(state: AgentPlatformAccountState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
  #withdraw(): void {
    this.#epoch++;
    this.#restartRequested = false;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    if (this.#pending) {
      clearTimeout(this.#pending.slowTimer);
      clearTimeout(this.#pending.deadlineTimer);
      this.#pending.controller.abort();
    }
    // The physical slot is retired only when the original read actually ends.
  }
  readonly #wake = (): void => {
    if (this.#paused || this.#state.status !== "restoring") return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#request();
  };
  readonly #sessionChanged = (): void => {
    if (this.#paused) return;
    this.#withdraw();
    this.#publish({ status: "restoring", unavailable: false });
    this.#restartRequested = true;
    this.#request();
  };
  #request(): void {
    if (
      !this.#listeners.size ||
      this.#paused ||
      this.#pending ||
      this.#state.status !== "restoring"
    )
      return;
    this.#restartRequested = false;
    const controller = new AbortController();
    const operation: Operation = {
      controller,
      epoch: this.#epoch,
      slowTimer: setTimeout(() => {
        if (this.#pending === operation && !controller.signal.aborted)
          this.#publish({ status: "restoring", unavailable: true });
      }, 5_000),
      deadlineTimer: setTimeout(() => {
        if (this.#pending !== operation || operation.epoch !== this.#epoch)
          return;
        this.#publish({ status: "restoring", unavailable: true });
        controller.abort(new DOMException("账号连接暂不可用", "TimeoutError"));
      }, 10_000),
    };
    this.#pending = operation;
    void this.#read(operation);
  }
  async #read(operation: Operation): Promise<void> {
    let retry = false;
    try {
      const user = await this.#dependencies.read(operation.controller.signal);
      if (operation.epoch !== this.#epoch) return;
      if (operation.controller.signal.aborted) {
        retry =
          this.#dependencies.hasCredentials() &&
          this.#dependencies.isTransient(operation.controller.signal.reason);
        return;
      }
      this.#retryStep = 0;
      this.#publish(
        user
          ? { status: "authenticated", user }
          : { status: "anonymous", error: null },
      );
    } catch (error) {
      if (
        operation.epoch !== this.#epoch ||
        !this.#listeners.size ||
        this.#paused
      )
        return;
      if (this.#dependencies.hasCredentials()) {
        this.#publish({ status: "restoring", unavailable: true });
        retry = this.#dependencies.isTransient(error);
      } else {
        this.#publish({
          status: "anonymous",
          error:
            error instanceof Error
              ? error.message
              : "账号服务暂时不可用，请稍后重试。",
        });
      }
    } finally {
      clearTimeout(operation.slowTimer);
      clearTimeout(operation.deadlineTimer);
      if (this.#pending === operation) this.#pending = null;
      if (!this.#listeners.size || this.#paused) return;
      if (this.#restartRequested) {
        this.#request();
      } else if (retry) {
        const delay =
          RETRY_DELAYS_MS[
            Math.min(this.#retryStep++, RETRY_DELAYS_MS.length - 1)
          ]!;
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = undefined;
          this.#request();
        }, delay);
      }
    }
  }
}
