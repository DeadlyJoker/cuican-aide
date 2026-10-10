import type { AgentPlatformSessionSnapshot } from "./agentPlatformAccessTokenOwner";
import { waitForAgentPlatformRequest } from "./agentPlatformRequestWait";

type Flight<T> = {
  session: AgentPlatformSessionSnapshot;
  controller: AbortController;
  pending: Promise<T>;
  borrowers: number;
  settled: boolean;
};

/** Share only current-account work in progress; no catalog data survives completion. */
export class AgentPlatformSnapshotReads<T> {
  readonly #deadlineMs: number;
  #flight: Flight<T> | null = null;

  constructor(options: { deadlineMs?: number } = {}) {
    this.#deadlineMs = options.deadlineMs ?? 45_000;
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs < 1) {
      throw new Error("agent_platform_catalog_snapshot_deadline_invalid");
    }
  }

  read(input: {
    session: AgentPlatformSessionSnapshot;
    signal?: AbortSignal;
    read: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    if (input.session.signal.aborted)
      return Promise.reject(new Error("agent_platform_session_changed"));
    if (input.signal?.aborted) return Promise.reject(input.signal.reason);
    let flight = this.#flight;
    if (
      !flight ||
      flight.settled ||
      flight.controller.signal.aborted ||
      flight.session.generation !== input.session.generation ||
      flight.session.signal !== input.session.signal
    ) {
      flight?.controller.abort(new Error("agent_platform_session_changed"));
      const controller = new AbortController();
      const ownerSignal = AbortSignal.any([
        input.session.signal,
        controller.signal,
      ]);
      const timer = setTimeout(() => {
        controller.abort(new Error("agent_platform_catalog_snapshot_timeout"));
      }, this.#deadlineMs);
      const clearDeadline = () => clearTimeout(timer);
      controller.signal.addEventListener("abort", clearDeadline, {
        once: true,
      });
      const current: Flight<T> = {
        session: input.session,
        controller,
        borrowers: 0,
        settled: false,
        pending: Promise.resolve().then(() => {
          ownerSignal.throwIfAborted();
          return input.read(ownerSignal);
        }),
      };
      const accountChanged = () => {
        controller.abort(new Error("agent_platform_session_changed"));
        if (this.#flight === current) this.#flight = null;
      };
      input.session.signal.addEventListener("abort", accountChanged, {
        once: true,
      });
      current.pending = current.pending
        .then((value) => {
          ownerSignal.throwIfAborted();
          return value;
        })
        .finally(() => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", clearDeadline);
          current.settled = true;
          input.session.signal.removeEventListener("abort", accountChanged);
          if (this.#flight === current) this.#flight = null;
        });
      this.#flight = current;
      flight = current;
    }
    const borrowed = flight;
    borrowed.borrowers++;
    return waitForAgentPlatformRequest({
      pending: borrowed.pending,
      signal: input.signal
        ? AbortSignal.any([input.signal, borrowed.controller.signal])
        : borrowed.controller.signal,
    }).finally(() => {
      borrowed.borrowers--;
      if (borrowed.borrowers !== 0 || borrowed.settled) return;
      // React StrictMode cleans up and reacquires synchronously. Give that
      // replacement a chance to borrow the same live work before retiring it.
      queueMicrotask(() => {
        if (borrowed.borrowers !== 0 || borrowed.settled) return;
        borrowed.controller.abort(
          new Error("agent_platform_catalog_snapshot_unobserved"),
        );
        if (this.#flight === borrowed) this.#flight = null;
      });
    });
  }
}
