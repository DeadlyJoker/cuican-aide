import { ControlApiClient } from "@crewon/control-client";
import { soakPrompt } from "./tool-fixture.ts";

/** Bootstrap secrets remain in memory. Only loopback read-only calls are permitted. */
export function soakReadClient(input: unknown): ControlApiClient {
  const session = input as Record<string, unknown> | null;
  if (
    !session ||
    typeof session.baseUrl !== "string" ||
    typeof session.sessionToken !== "string" ||
    typeof session.csrfToken !== "string" ||
    typeof session.origin !== "string"
  )
    throw new Error("soak_session_invalid");
  const url = new URL(session.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new Error("soak_session_origin_invalid");
  return new ControlApiClient({
    baseUrl: session.baseUrl,
    accessToken: session.sessionToken,
    csrfToken: session.csrfToken,
    origin: session.origin,
  });
}

/** A user echo, partial stream, or a provider receipt alone cannot pass a turn. */
export async function verifySoakTurn(
  client: ControlApiClient,
  threadId: string,
  marker: string,
) {
  const options = { signal: AbortSignal.timeout(5000) };
  const transcript = await client.getThreadTranscriptWindow(
    threadId,
    { limit: 8 },
    options,
  );
  const messages = transcript.messageWindow.data;
  const users = messages.filter(
    (message) =>
      message.role === "user" && message.content === soakPrompt(marker),
  );
  const assistants = messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.content.startsWith(`ACK ${marker}\n`),
  );
  if (users.length !== 1 || assistants.length !== 1)
    throw new Error("soak_turn_messages_invalid");
  const user = users[0]!,
    assistant = assistants[0]!;
  const binding = (id: string) =>
    transcript.runBindings.find((item) => item.messageId === id)?.runId;
  const runId = binding(user.messageId);
  if (
    !runId ||
    binding(assistant.messageId) !== runId ||
    user.sequence >= assistant.sequence
  )
    throw new Error("soak_turn_binding_invalid");
  const { run } = await client.getRunInThread(threadId, runId, options);
  if (run.status !== "completed" || run.purpose !== "turn")
    throw new Error(`soak_turn_not_completed:${run.status}`);
  return {
    threadId,
    runId,
    userMessageId: user.messageId,
    assistantMessageId: assistant.messageId,
    assistantSequence: assistant.sequence,
  };
}

/** Inspect the exact submitted user message so a terminal failure is not called a UI timeout. */
export async function assertSoakTurnNotFailed(
  client: ControlApiClient,
  threadId: string,
  marker: string,
) {
  const options = { signal: AbortSignal.timeout(5000) };
  const transcript = await client.getThreadTranscriptWindow(
    threadId,
    { limit: 8 },
    options,
  );
  const user = transcript.messageWindow.data.find(
    (message) =>
      message.role === "user" && message.content === soakPrompt(marker),
  );
  const runId = transcript.runBindings.find(
    (binding) => binding.messageId === user?.messageId,
  )?.runId;
  if (!runId) return;
  const { run } = await client.getRunInThread(threadId, runId, options);
  if (run.status === "failed" || run.status === "canceled")
    throw new Error(
      `soak_product_run_${run.status}:${run.failure?.code ?? "unknown"}`,
    );
}

export async function verifySoakInFlightTurn(
  client: ControlApiClient,
  threadId: string,
  marker: string,
) {
  const options = { signal: AbortSignal.timeout(5000) };
  const transcript = await client.getThreadTranscriptWindow(
    threadId,
    { limit: 8 },
    options,
  );
  const users = transcript.messageWindow.data.filter(
    (message) =>
      message.role === "user" && message.content === soakPrompt(marker),
  );
  if (users.length !== 1) throw new Error("soak_inflight_user_invalid");
  const runId = transcript.runBindings.find(
    (binding) => binding.messageId === users[0]!.messageId,
  )?.runId;
  if (!runId) throw new Error("soak_inflight_binding_missing");
  const { run } = await client.getRunInThread(threadId, runId, options);
  if (run.status !== "running")
    throw new Error(`soak_inflight_run_invalid:${run.status}`);
  return { runId, userMessageId: users[0]!.messageId };
}
