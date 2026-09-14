export const AGENT_PLATFORM_AUTH_BOOTSTRAP_TIMEOUT_MS = 5_000;
export const AGENT_PLATFORM_AUTH_UNAVAILABLE_MESSAGE =
  "账号服务暂时不可用，请稍后重试。";

/**
 * A remote account probe must never hold the whole desktop shell hostage.
 * Bootstrap only observes account readiness, so the UI can stop waiting and
 * expose the login/retry surface without changing any PIM resource.
 */
export async function withAgentPlatformAuthBootstrapDeadline<T>(
  pending: Promise<T>,
  timeoutMs = AGENT_PLATFORM_AUTH_BOOTSTRAP_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("agent_platform_auth_bootstrap_timeout_invalid");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(AGENT_PLATFORM_AUTH_UNAVAILABLE_MESSAGE)),
      timeoutMs,
    );
  });
  pending.catch(() => undefined);
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
