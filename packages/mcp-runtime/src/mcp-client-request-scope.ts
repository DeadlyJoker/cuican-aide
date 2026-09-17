const MAX_REQUESTS = 32;

/** SDK request listeners must never attach directly to a caller's long-lived signal. */
export class McpClientRequestScope {
  readonly #active = new Set<AbortController>();
  #closed = false;

  async run<T>(
    signal: AbortSignal,
    operation: (ownedSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.#closed) throw new Error("mcp_client_closed");
    if (this.#active.size >= MAX_REQUESTS)
      throw new Error("mcp_client_request_capacity_exceeded");
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    this.#active.add(controller);
    try {
      return await operation(controller.signal);
    } catch (error) {
      // SDK 1.26.0 can leave its deadline registered when a request rejects on close.
      controller.abort(error);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#active.delete(controller);
      // Successful SDK requests have already cleared their deadline. Discard this
      // private signal; aborting it would send a spurious cancellation notification.
    }
  }

  disconnected(reason: Error): void {
    for (const controller of this.#active) controller.abort(reason);
  }

  close(reason: Error): void {
    this.#closed = true;
    this.disconnected(reason);
  }
}
