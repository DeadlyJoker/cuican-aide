/** Request cleanup without letting an untrusted body own an already known failure. */
export function cancelResponsesBody(
  body: Pick<ReadableStream<Uint8Array>, "cancel"> | null,
  reason?: string,
): void {
  try {
    // Cancellation closes this read side immediately. A tee or custom source may
    // keep its cancellation promise pending; it must not delay HTTP classification.
    void body?.cancel(reason).catch(() => {});
  } catch {
    // Preserve the original HTTP/protocol failure even if cleanup itself throws.
  }
}
