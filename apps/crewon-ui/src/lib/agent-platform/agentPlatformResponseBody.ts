export const AGENT_PLATFORM_RESPONSE_BODY_MAX_BYTES = 1_048_576;

/** Keep the body cancellable after response headers have arrived. */
export async function readAgentPlatformResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  let cancellation: Promise<void> | null = null;
  const cancelRead = (reason: unknown) => {
    cancellation ??= reader.cancel(reason).catch(() => {});
  };
  const abort = () => {
    cancelRead(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > AGENT_PLATFORM_RESPONSE_BODY_MAX_BYTES) {
        const error = new Error("agent_platform_response_too_large");
        cancelRead(error);
        throw error;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    signal.removeEventListener("abort", abort);
    // A retry may start only after cancellation of the previous body settles.
    if (cancellation) await cancellation;
    reader.releaseLock();
  }
}
