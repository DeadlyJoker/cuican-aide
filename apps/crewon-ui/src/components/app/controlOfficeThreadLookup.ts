import type { ControlApiClient } from "@crewon/control-client";
import type {
  OfficeThreadResponse,
  ThreadCatalogResponse,
  ThreadView,
} from "@crewon/contracts";
import { abortableCatalogRead } from "../../lib/control-runtime/controlCatalogRead";

// Each server page scans at most 100 candidates. The caller also owns a deadline.
const MAX_LOOKUP_PAGES = 100;

export function controlOfficeAssociatedThread(
  response: OfficeThreadResponse,
  expected: { officeId: string; officeVersionId: string },
): ThreadView | null {
  if (
    response.officeId !== expected.officeId ||
    response.officeVersionId !== expected.officeVersionId
  )
    throw new Error("control_office_binding_mismatch");
  return response.thread;
}

/** A filtered/sidebar page cannot establish absence or a unique Office match. */
export async function findControlOfficeThread(
  client: Pick<ControlApiClient, "getThreadCatalog">,
  titles: { title: string; legacyTitle: string; searchTitle: string },
  signal: AbortSignal,
): Promise<ThreadView | null> {
  let cursor: string | null = null;
  let match: ThreadView | null = null;
  const recentCursors: string[] = [];
  for (let index = 0; index < MAX_LOOKUP_PAGES; index++) {
    signal.throwIfAborted();
    const page: ThreadCatalogResponse = await abortableCatalogRead(
      client.getThreadCatalog(
        {
          status: "active",
          excludeForks: true,
          search: titles.searchTitle,
          limit: 100,
          cursor,
        },
        { signal },
      ),
      signal,
    );
    signal.throwIfAborted();
    for (const candidate of page.data) {
      if (
        candidate.status !== "active" ||
        candidate.forkedFromThreadId !== null ||
        (candidate.title !== titles.title &&
          candidate.title !== titles.legacyTitle)
      )
        continue;
      if (match !== null && match.threadId !== candidate.threadId)
        throw new Error("control_office_thread_ambiguous");
      match = candidate;
    }
    // Empty filtered pages and a first match can both have older candidates.
    if (page.olderCursor === null) return match;
    if (page.olderCursor === cursor || recentCursors.includes(page.olderCursor))
      throw new Error("control_office_lookup_incomplete");
    if (cursor !== null) recentCursors.push(cursor);
    if (recentCursors.length > 4) recentCursors.shift();
    cursor = page.olderCursor;
  }
  throw new Error("control_office_lookup_incomplete");
}
