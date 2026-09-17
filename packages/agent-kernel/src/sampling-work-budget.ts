import { AgentKernelError } from "./agent-kernel-port.ts";
import { MAX_EMPTY_PROVIDER_CONTINUATIONS } from "@crewon/domain";

// Allows WebSocket -> HTTP and a rejected stored continuation -> full input.
const MAX_TRANSPORT_FALLBACKS = 2;

/** Non-resettable work counters for one Kernel segment, separate from local retries. */
export class SamplingWorkBudget {
  readonly #maxRequests: number;
  #requests = 0;
  #emptyContinuations = 0;
  #fallbacks = 0;

  constructor(maxRetries: number) {
    this.#maxRequests =
      1 + maxRetries + MAX_EMPTY_PROVIDER_CONTINUATIONS + MAX_TRANSPORT_FALLBACKS;
  }

  startRequest(): void {
    if (this.#requests >= this.#maxRequests)
      throw new AgentKernelError(
        "model_sampling_request_limit_exceeded",
        false,
      );
    this.#requests++;
  }

  continueEmptyResponse(): void {
    if (this.#emptyContinuations >= MAX_EMPTY_PROVIDER_CONTINUATIONS)
      throw new AgentKernelError(
        "model_empty_continuation_limit_exceeded",
        false,
      );
    this.#emptyContinuations++;
  }

  fallback(): void {
    if (this.#fallbacks >= MAX_TRANSPORT_FALLBACKS)
      throw new AgentKernelError(
        "model_transport_fallback_limit_exceeded",
        false,
      );
    this.#fallbacks++;
  }
}
