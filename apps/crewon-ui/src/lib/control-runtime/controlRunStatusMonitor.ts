import type { GetRunResponse } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import { waitForControlRuntimeDelay } from "./controlRuntimeDelay";

/** One shared, cancelable reconciliation request for polling and SSE recovery. */
export class ControlRunStatusMonitor {
  readonly #client: Pick<ControlApiClient, "getRun">;
  readonly #runId: string;
  readonly #threadId: string;
  readonly #signal: AbortSignal;
  readonly #pollDelay: ((signal: AbortSignal) => Promise<void>) | undefined;
  #pending: Promise<GetRunResponse> | null = null;
  #streamHealthy = false;
  #failures = 0;
  #hasWaited = false;

  constructor(
    input: Readonly<{
      client: Pick<ControlApiClient, "getRun">;
      runId: string;
      threadId: string;
      signal: AbortSignal;
      pollDelay?: (signal: AbortSignal) => Promise<void>;
    }>,
  ) {
    this.#client = input.client;
    this.#runId = input.runId;
    this.#threadId = input.threadId;
    this.#signal = input.signal;
    this.#pollDelay = input.pollDelay;
  }

  observeStreamEvent(): void {
    this.#streamHealthy = true;
  }
  observeStreamDisconnected(): void {
    this.#streamHealthy = false;
  }

  waitForPoll(): Promise<void> {
    if (this.#pollDelay !== undefined) return this.#pollDelay(this.#signal);
    const ceilingMs = this.#streamHealthy
      ? 30_000
      : Math.min(30_000, 5_000 * 2 ** Math.min(this.#failures, 3));
    const delayMs = this.#hasWaited
      ? Math.floor(ceilingMs * (0.5 + Math.random() * 0.5))
      : 500;
    this.#hasWaited = true;
    return waitForControlRuntimeDelay({ delayMs, signal: this.#signal });
  }

  read(): Promise<GetRunResponse> {
    if (this.#pending !== null) return this.#pending;
    const pending = this.#read().finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }

  async #read(): Promise<GetRunResponse> {
    const controller = new AbortController();
    const abort = () => controller.abort(this.#signal.reason);
    if (this.#signal.aborted) abort();
    else this.#signal.addEventListener("abort", abort, { once: true });
    const timeout = globalThis.setTimeout(() => {
      controller.abort(new Error("control_run_status_timeout"));
    }, 10_000);
    try {
      controller.signal.throwIfAborted();
      const response = await this.#client.getRun(this.#runId, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (
        response.run.runId !== this.#runId ||
        response.run.threadId !== this.#threadId
      ) {
        throw new Error("control_run_status_identity_invalid");
      }
      this.#failures = 0;
      return response;
    } catch (error) {
      if (!this.#signal.aborted)
        this.#failures = Math.min(this.#failures + 1, 3);
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      this.#signal.removeEventListener("abort", abort);
    }
  }
}
