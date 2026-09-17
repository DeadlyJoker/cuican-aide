import { vi } from "vitest";
import {
  formatThreadCatalogCursor,
  parseThreadCatalogQuery,
  type ThreadView,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

const timestamp = "2026-09-11T00:00:00.000Z";
export function catalogThread(index: number): ThreadView {
  return {
    threadId: `thread-${String(index).padStart(5, "0")}`,
    title: index === 0 ? "needle 缓存" : `Task ${index}`,
    status: "active",
    revision: 1,
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    deletedAt: null,
  };
}
export function catalogClientFixture() {
  const records = Array.from({ length: 1_301 }, (_, index) =>
    catalogThread(index),
  ).reverse();
  const getThreadCatalog = vi.fn<ControlApiClient["getThreadCatalog"]>(
    async (input) => {
      const query = parseThreadCatalogQuery(input);
      const candidates = records.filter(
        (record) =>
          query.position === null ||
          (query.position.direction === "older"
            ? record.threadId < query.position.threadId
            : record.threadId > query.position.threadId),
      );
      const reverse = query.position?.direction === "newer";
      const scanned = reverse
        ? candidates.slice(-query.limit)
        : candidates.slice(0, query.limit);
      const edge = (direction: "older" | "newer") => {
        const anchor = direction === "older" ? scanned.at(-1) : scanned[0];
        if (
          !anchor ||
          !records.some((record) =>
            direction === "older"
              ? record.threadId < anchor.threadId
              : record.threadId > anchor.threadId,
          )
        )
          return null;
        return formatThreadCatalogCursor(query, {
          direction,
          threadId: anchor.threadId,
          updatedAt: anchor.updatedAt,
        });
      };
      return {
        schemaVersion: "crewon.thread-catalog.v0",
        scannedCount: scanned.length,
        data: scanned.filter((record) =>
          record.title!.toLowerCase().includes(query.search.toLowerCase()),
        ),
        olderCursor: edge("older"),
        newerCursor: edge("newer"),
      };
    },
  );
  return { getThreadCatalog };
}
