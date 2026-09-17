import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { MessageView } from "@crewon/contracts";
import type { ThreadRuntimeSettings } from "../thread/threadRuntimeSettings";
import { transcriptWindow } from "./controlTranscriptWindow";

export type MessageReplayRequest = Readonly<{
  threadId: string;
  userMessageId: string;
  expectedTurnIds: readonly string[];
  expectedThreadRevision?: number;
  text: string;
  settings?: ThreadRuntimeSettings;
}>;

export class MessageReplayError extends Error {
  constructor(
    readonly code: "changed" | "busy" | "input" | "send-failed",
    readonly historyChanged = false,
    options?: ErrorOptions,
  ) {
    super(`message_replay_${code}`, options);
  }
}

export function replaySource(thread: Thread, userMessageId: string) {
  const index = thread.turns.findIndex((turn) =>
    turn.items.some(
      (item) => item.type === "userMessage" && item.id === userMessageId,
    ),
  );
  const item =
    thread.turns[index]?.items.find(
      (candidate) =>
        candidate.type === "userMessage" && candidate.id === userMessageId,
    ) ??
    transcriptWindow(thread)?.rows.find(
      (row) =>
        row.kind === "unassociated" &&
        row.item.id === userMessageId &&
        row.item.type === "userMessage",
    );
  const sourceItem =
    item && "kind" in item && item.kind === "unassociated" ? item.item : item;
  if (
    !sourceItem ||
    !("type" in sourceItem) ||
    sourceItem.type !== "userMessage"
  )
    return null;
  return {
    index,
    text: sourceItem.content
      .filter((input) => input.type === "text")
      .map((input) => input.text)
      .join("\n\n"),
    textOnly: sourceItem.content.every((input) => input.type === "text"),
  };
}

type ReplayRuntime = {
  readThread(threadId: string): Promise<Thread>;
  rollbackThread(
    threadId: string,
    numTurns: number,
    guard: { expectedRevision: number },
  ): Promise<Thread>;
  startTurn(
    threadId: string,
    text: string,
    mentions: [],
    settings?: ThreadRuntimeSettings,
  ): Promise<unknown>;
};

/** Validate the visible boundary and its revision before touching durable history. */
export async function replayControlMessage(input: {
  request: MessageReplayRequest;
  runtime: ReplayRuntime;
  readRevision: () => Promise<number>;
  readMessages?: () => Promise<MessageView[]>;
  readBoundary?: (
    revision: number,
  ) => Promise<{ message: MessageView; numTurns: number }>;
  preflight: () => Promise<void>;
}): Promise<void> {
  const { request, runtime } = input;
  if (
    !request.text.trim() ||
    new TextEncoder().encode(request.text).length > 24 * 1024
  ) {
    throw new MessageReplayError("input");
  }
  const revision = await input.readRevision();
  if (
    request.expectedThreadRevision !== undefined &&
    request.expectedThreadRevision !== revision
  )
    throw new MessageReplayError("changed");
  const [thread, boundary] = await Promise.all([
    runtime.readThread(request.threadId),
    input.readBoundary
      ? input.readBoundary(revision)
      : (async () => {
          if (!input.readMessages) throw new MessageReplayError("changed");
          const messages = await input.readMessages();
          const message = messages.find(
            (item) =>
              item.messageId === request.userMessageId && item.role === "user",
          );
          if (!message) throw new MessageReplayError("changed");
          return {
            message,
            numTurns: messages.filter(
              (item) =>
                item.role === "user" && item.sequence >= message.sequence,
            ).length,
          };
        })(),
  ]);
  if (
    thread.status.type === "active" ||
    thread.turns.some((turn) => turn.status === "inProgress")
  ) {
    throw new MessageReplayError("busy");
  }
  const source = replaySource(thread, request.userMessageId);
  if (
    thread.id !== request.threadId ||
    !source ||
    JSON.stringify(thread.turns.map((turn) => turn.id)) !==
      JSON.stringify(request.expectedTurnIds)
  )
    throw new MessageReplayError("changed");
  if (!source.textOnly) throw new MessageReplayError("input");
  const { message: user, numTurns } = boundary;
  if (
    user.messageId !== request.userMessageId ||
    user.role !== "user" ||
    !Number.isSafeInteger(numTurns) ||
    numTurns < 1
  )
    throw new MessageReplayError("changed");
  // Rich input is currently projected as visible text. Do not silently discard
  // selected resources, personalization or routed-member context during an edit.
  if (user.content.trim() !== source.text.trim())
    throw new MessageReplayError("input");
  await input.preflight();
  if ((await input.readRevision()) !== revision)
    throw new MessageReplayError("changed");
  await runtime.rollbackThread(request.threadId, numTurns, {
    expectedRevision: revision,
  });
  try {
    await runtime.startTurn(request.threadId, request.text.trim(), [], {
      ...request.settings,
      executionIntent: "none",
    });
  } catch (cause) {
    // Never repeat rollback or blindly resubmit after an uncertain send outcome.
    throw new MessageReplayError("send-failed", true, { cause });
  }
}
