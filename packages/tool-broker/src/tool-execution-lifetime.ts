import { ToolBrokerError } from "./tool-broker-port.ts";

/** The host stops waiting; the physical execution continues to own its reservation. */
export class ToolExecutionPendingError extends ToolBrokerError {
  readonly retryAfterMs = 5_000;
  constructor() {
    super("tool_execution_still_running");
    this.name = "ToolExecutionPendingError";
    this.stack = this.message;
  }
}

export class ToolExecutionLifetime {
  readonly #controller = new AbortController();
  readonly #parent: AbortSignal;
  readonly #interrupted: (reason: unknown) => void;
  readonly #cancel: () => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  constructor(parent: AbortSignal, interrupted: (reason: unknown) => void) {
    this.#parent = parent;
    this.#interrupted = interrupted;
    this.#cancel = () => this.interrupt(parent.reason);
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  start(timeoutMs: number): void {
    if (this.#parent.aborted) {
      this.#cancel();
      return;
    }
    this.#parent.addEventListener("abort", this.#cancel, { once: true });
    this.#timer = setTimeout(
      () => this.interrupt(new ToolExecutionPendingError()),
      timeoutMs,
    );
  }
  interrupt(reason: unknown): void {
    if (this.#closed) return;
    this.#detach();
    this.#interrupted(reason);
    this.#controller.abort(reason);
  }
  close(): void {
    this.#closed = true;
    this.#detach();
  }
  #detach(): void {
    this.#parent.removeEventListener("abort", this.#cancel);
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
