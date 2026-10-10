export const AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS = 10_000;

/** The shared token operation, rather than any one consumer, owns its transport. */
export function createAgentPlatformTokenTransport(
  sessionSignal: AbortSignal,
  unavailableError: (message: string) => Error,
): Readonly<{
  signal: AbortSignal;
  deadline: Promise<never>;
  close(): void;
}> {
  const controller = new AbortController();
  const withdraw = () => controller.abort(sessionSignal.reason);
  sessionSignal.addEventListener("abort", withdraw, { once: true });
  if (sessionSignal.aborted) withdraw();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    const error = unavailableError("账号服务暂时不可用，请稍后重试。");
    controller.abort(error);
    rejectDeadline(error);
  }, AGENT_PLATFORM_TOKEN_TRANSPORT_TIMEOUT_MS);
  return Object.freeze({
    signal: controller.signal,
    deadline,
    close() {
      clearTimeout(timer);
      sessionSignal.removeEventListener("abort", withdraw);
    },
  });
}
