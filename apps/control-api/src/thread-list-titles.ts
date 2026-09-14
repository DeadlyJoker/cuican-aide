import { deriveThreadTitle } from "@crewon/domain";
import { ApplicationError, type MessageRecord } from "@crewon/application";
import type { ThreadView } from "@crewon/contracts";

/** Read-only compatibility for historical unnamed threads. No revisions or sort timestamps change. */
export async function withThreadListTitles(
  threads: readonly ThreadView[],
  readMessages: (threadId: string) => Promise<readonly MessageRecord[]>,
): Promise<ThreadView[]> {
  const result = threads.map((thread) => ({ ...thread }));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, result.length) }, async () => {
      for (;;) {
        const thread = result[next++];
        if (!thread) return;
        if (
          thread.title !== null ||
          thread.lastMessageSequence === 0 ||
          thread.status === "deleted"
        )
          continue;
        // The caller performs normal tenant/space and message-read authorization.
        let messages: readonly MessageRecord[];
        try {
          messages = await readMessages(thread.threadId);
        } catch (error) {
          // A conversation can be deleted or access revoked after list authorization.
          if (
            error instanceof ApplicationError &&
            (error.category === "notFound" ||
              error.category === "authorization")
          )
            continue;
          throw error;
        }
        if (messages.some((message) => message.threadId !== thread.threadId))
          throw new Error("thread_title_message_identity_invalid");
        const firstUser = messages.find((message) => message.role === "user");
        const title = firstUser ? deriveThreadTitle(firstUser.content) : null;
        if (title !== null) thread.displayTitle = title;
      }
    }),
  );
  return result;
}
