import { ApplicationError } from "./application-error.ts";

/** Original error mapping shared by the original Conversation recipes. */
export async function projectConversationCall<T>(
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    const code =
      error instanceof Error
        ? error.message
        : "project_conversation_service_unavailable";
    throw new ApplicationError(
      code.includes("not_found")
        ? "notFound"
        : code.includes("conflict") ||
            code.includes("mismatch") ||
            code === "project_outline_inputs_stale"
          ? "conflict"
          : code.includes("authority")
            ? "authorization"
            : "internal",
      code,
      { cause: error },
    );
  }
}
