import { abortableCatalogRead } from "./controlCatalogRead";
import type { ControlApiClient } from "@crewon/control-client";
import type { ThreadView, ThreadCatalogResponse } from "@crewon/contracts";

/** A catalog page cannot prove that the durable Assistant does not exist. Search before creating. */
export async function findControlAssistantThread(
  client: Pick<ControlApiClient, "getThreadCatalog">,
  title: string,
  signal: AbortSignal,
): Promise<ThreadView | null> {
  let cursor: string | null = null;
  const recent: string[] = [];
  for (;;) {
    signal.throwIfAborted();
    const page: ThreadCatalogResponse = await abortableCatalogRead(
      client.getThreadCatalog(
        {
          status: "active",
          excludeForks: true,
          search: title,
          limit: 100,
          cursor,
        },
        { signal },
      ),
      signal,
    );
    signal.throwIfAborted();
    const existing = page.data.find(
      (thread) =>
        thread.title === title &&
        thread.status === "active" &&
        thread.forkedFromThreadId === null,
    );
    if (existing) return existing;
    if (page.olderCursor === null) return null;
    if (page.olderCursor === cursor || recent.includes(page.olderCursor))
      throw new Error("control_assistant_cursor_cycle");
    if (cursor !== null) recent.push(cursor);
    if (recent.length > 4) recent.shift();
    cursor = page.olderCursor;
  }
}
