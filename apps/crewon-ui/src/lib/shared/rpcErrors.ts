type RpcError = Error & Readonly<{ code?: unknown }>;

/** Classifies a missing Thread without depending on one transport's error class. */
export function isMissingThreadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("thread not found") ||
      error.message.includes("invalid thread id"))
  );
}

/** Classifies the JSON-RPC method-not-found code across legacy test fixtures. */
export function isUnsupportedRpcError(error: unknown): boolean {
  return error instanceof Error && (error as RpcError).code === -32601;
}
