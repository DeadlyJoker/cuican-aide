import { abortableCatalogRead } from "./controlCatalogRead";
import type { ControlApiClient } from "@crewon/control-client";
import {
  parseThreadCatalogQuery,
  type ThreadCatalogResponse,
  type ThreadView,
} from "@crewon/contracts";
import { isControlConversationThread } from "./controlConversationThreads";

export type ControlCatalogFilter = Readonly<{
  status: "active" | "archived";
  search: string;
}>;
export type ControlCatalogSnapshot = Readonly<{
  filter: ControlCatalogFilter;
  cursor: string | null;
  threads: readonly ThreadView[];
  olderCursor: string | null;
  newerCursor: string | null;
  loading: boolean;
  error: unknown | null;
  revision: number;
}>;
export const EMPTY_CONTROL_CATALOG: ControlCatalogSnapshot = Object.freeze({
  filter: { status: "active" as const, search: "" },
  cursor: null,
  threads: [],
  olderCursor: null,
  newerCursor: null,
  loading: false,
  error: null,
  revision: 0,
});

/** One replaceable catalog window. An empty search page can still offer continuation. */
export class ControlThreadCatalog {
  readonly #client: Pick<ControlApiClient, "getThreadCatalog">;
  readonly #listeners = new Set<() => void>();
  readonly #timeoutMs: number;
  #snapshot: ControlCatalogSnapshot = EMPTY_CONTROL_CATALOG;
  #generation = 0;
  #closed = false;
  #request: {
    key: string;
    controller: AbortController;
    promise: Promise<ControlCatalogSnapshot>;
  } | null = null;

  constructor(
    client: Pick<ControlApiClient, "getThreadCatalog">,
    timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("catalog_timeout_invalid");
    this.#client = client;
    this.#timeoutMs = timeoutMs;
  }
  readonly getSnapshot = (): ControlCatalogSnapshot => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    this.cancel();
    this.#snapshot = EMPTY_CONTROL_CATALOG;
  }
  cancel(): void {
    this.#generation++;
    this.#request?.controller.abort();
    this.#request = null;
    if (this.#snapshot.loading)
      this.#publish({ ...this.#snapshot, loading: false });
  }
  refresh(
    filter: ControlCatalogFilter = this.#snapshot.filter,
  ): Promise<ControlCatalogSnapshot> {
    const same =
      filter.status === this.#snapshot.filter.status &&
      filter.search.trim() === this.#snapshot.filter.search;
    return this.load(filter, same ? this.#snapshot.cursor : null);
  }
  navigate(
    direction: "older" | "newer" | "latest",
  ): Promise<ControlCatalogSnapshot> {
    const cursor =
      direction === "latest" ? null : this.#snapshot[`${direction}Cursor`];
    if (direction !== "latest" && cursor === null)
      return Promise.resolve(this.#snapshot);
    return this.load(this.#snapshot.filter, cursor);
  }
  load(
    filter: ControlCatalogFilter,
    cursor: string | null = null,
  ): Promise<ControlCatalogSnapshot> {
    if (this.#closed)
      return Promise.reject(new Error("control_catalog_closed"));
    let query;
    try {
      query = parseThreadCatalogQuery({
        ...filter,
        cursor,
        limit: 50,
        excludeForks: true,
      });
    } catch (error) {
      this.cancel();
      this.#publish({ ...this.#snapshot, error });
      return Promise.reject(error);
    }
    const normalized = { status: query.status, search: query.search };
    const key = JSON.stringify([normalized, cursor]);
    if (this.#request?.key === key) return this.#request.promise;
    this.cancel();
    const generation = this.#generation;
    const controller = new AbortController();
    const same =
      normalized.status === this.#snapshot.filter.status &&
      normalized.search === this.#snapshot.filter.search;
    this.#publish({
      ...this.#snapshot,
      filter: normalized,
      cursor,
      loading: true,
      error: null,
      ...(same ? {} : { threads: [], olderCursor: null, newerCursor: null }),
    });
    const timeout = setTimeout(
      () => controller.abort(new Error("control_catalog_timeout")),
      this.#timeoutMs,
    );
    const promise = this.#read(
      normalized,
      cursor,
      query.position?.direction ?? "older",
      controller.signal,
    )
      .then((page) => {
        if (this.#closed || generation !== this.#generation)
          throw new DOMException("Catalog superseded", "AbortError");
        this.#publish({
          filter: normalized,
          cursor,
          threads: page.data,
          olderCursor: page.olderCursor,
          newerCursor: page.newerCursor,
          loading: false,
          error: null,
          revision: this.#snapshot.revision + 1,
        });
        return this.#snapshot;
      })
      .catch((error: unknown) => {
        if (!this.#closed && generation === this.#generation)
          this.#publish({ ...this.#snapshot, loading: false, error });
        throw error;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (generation === this.#generation) this.#request = null;
      });
    this.#request = { key, controller, promise };
    return promise;
  }
  async #read(
    filter: ControlCatalogFilter,
    start: string | null,
    direction: "older" | "newer",
    signal: AbortSignal,
  ): Promise<ThreadCatalogResponse> {
    const seen = new Set<string>();
    let cursor = start;
    let first: ThreadCatalogResponse | null = null;
    // Bound work for one user action. Navigation continues from the returned cursor, without a lifetime cap.
    for (let scannedPages = 0; scannedPages < 4; scannedPages++) {
      if (cursor !== null) {
        if (seen.has(cursor)) throw new Error("control_catalog_cursor_cycle");
        seen.add(cursor);
      }
      const page = await abortableCatalogRead(
        this.#client.getThreadCatalog(
          { ...filter, cursor, limit: 50, excludeForks: true },
          { signal },
        ),
        signal,
      );
      first ??= page;
      const data = page.data.filter(isControlConversationThread);
      const next = page[`${direction}Cursor`];
      if (next !== null && seen.has(next))
        throw new Error("control_catalog_cursor_cycle");
      if (data.length > 0 || next === null || scannedPages === 3)
        return {
          ...page,
          data,
          ...(direction === "older"
            ? { newerCursor: first.newerCursor }
            : { olderCursor: first.olderCursor }),
        };
      cursor = next;
    }
    throw new Error("control_catalog_read_invalid");
  }
  #publish(snapshot: ControlCatalogSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
