import { AGENT_PLATFORM_AUTH_UNAVAILABLE_MESSAGE } from "./agentPlatformAuthBootstrap";
import type { AgentPlatformSessionSnapshot } from "./agentPlatformAccessTokenOwner";

// Match the desktop HTTP request budget for the token POST and its JSON body.
export const AGENT_PLATFORM_INTERACTIVE_REQUEST_TIMEOUT_MS = 15_000;

/** A token exchange ends before publishing the next account epoch. */
export async function withAgentPlatformInteractiveRequest<T>(input: {
  session: AgentPlatformSessionSnapshot;
  execute(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.session.signal, controller.signal]);
  let rejectDeadline!: (error: DOMException) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    const error = new DOMException(
      AGENT_PLATFORM_AUTH_UNAVAILABLE_MESSAGE,
      "TimeoutError",
    );
    controller.abort(error);
    rejectDeadline(error);
  }, AGENT_PLATFORM_INTERACTIVE_REQUEST_TIMEOUT_MS);
  try {
    signal.throwIfAborted();
    const physical = input.execute(signal);
    // A timed out consumer cannot publish a late physical response. Callers
    // fence body consumption with this signal before returning credentials.
    void physical.catch(() => undefined);
    return await Promise.race([physical, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
