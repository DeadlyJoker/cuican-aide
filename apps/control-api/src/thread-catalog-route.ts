import type { FastifyInstance } from "fastify";
import type {
  ThreadApplicationService,
  ThreadListSelection,
} from "@crewon/application";
import {
  formatThreadCatalogCursor,
  matchesThreadCatalogSearch,
  parseThreadCatalogQuery,
  type ThreadCatalogPosition,
  type ThreadCatalogResponse,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { projectThread } from "./thread-projection.ts";
import { withThreadListTitles } from "./thread-list-titles.ts";

export function registerThreadCatalogRoute(
  app: FastifyInstance,
  dependencies: {
    threads: ThreadApplicationService;
    identity: ControlApiIdentityPort;
  },
): void {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/v1/thread-catalog",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parseThreadCatalogQuery({ ...request.query });
      const direction = query.position?.direction ?? "older";
      const selection = (
        position: ThreadCatalogPosition | null,
        limit: number,
      ): ThreadListSelection => ({
        before:
          position?.direction === "older"
            ? { updatedAt: position.updatedAt, threadId: position.threadId }
            : null,
        after:
          position?.direction === "newer"
            ? { updatedAt: position.updatedAt, threadId: position.threadId }
            : null,
        filter: { status: query.status, excludeForks: query.excludeForks },
        limit,
      });
      // Limit bounds hydrated candidates; filters can return fewer matches. Never loop over the catalog.
      const candidates = await dependencies.threads.listThreads(
        actor,
        selection(query.position, query.limit),
      );
      const first = candidates[0];
      const last = candidates.at(-1);
      const edge = direction === "older" ? last : first;
      const continuation =
        edge === undefined
          ? null
          : { direction, updatedAt: edge.updatedAt, threadId: edge.threadId };
      const hasMore =
        candidates.length === query.limit &&
        continuation !== null &&
        (
          await dependencies.threads.listThreads(
            actor,
            selection(continuation, 1),
          )
        ).length > 0;
      const titled = await withThreadListTitles(
        candidates.map(projectThread),
        (threadId) =>
          dependencies.threads.listMessages(actor, {
            threadId,
            afterSequence: 0,
            limit: 16,
          }),
      );
      const cursor = (requestedDirection: "older" | "newer") => {
        if (direction === requestedDirection && !hasMore) return null;
        if (direction !== requestedDirection && query.position === null)
          return null;
        const anchor =
          (requestedDirection === "older" ? last : first) ?? query.position;
        return anchor == null
          ? null
          : formatThreadCatalogCursor(query, {
              direction: requestedDirection,
              updatedAt: anchor.updatedAt,
              threadId: anchor.threadId,
            });
      };
      const response: ThreadCatalogResponse = {
        schemaVersion: "crewon.thread-catalog.v0",
        data: titled.filter((thread) =>
          matchesThreadCatalogSearch(thread, query.search),
        ),
        scannedCount: candidates.length,
        olderCursor: cursor("older"),
        newerCursor: cursor("newer"),
      };
      return response;
    },
  );
}
