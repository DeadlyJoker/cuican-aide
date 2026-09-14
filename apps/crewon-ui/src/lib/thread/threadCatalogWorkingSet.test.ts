import { mergeThreadMetadata } from "./threadCatalogWorkingSet";
import { describe, expect, it } from "vitest";
import {
  createThreadCollectionReducer,
  initialThreadCollection,
  materializeThreads,
} from "./threadDetailCache";
import { detailThread } from "./threadDetailCache.test-support";
import { upsertThread } from "./threadModel";

describe("catalog and detail working sets", () => {
  it("replaces 2,000 browsed summaries while selected and active transcripts retain their identity", () => {
    const reduce = createThreadCollectionReducer();
    const selected = detailThread("selected");
    const active = detailThread("active");
    active.status = { type: "active", activeFlags: [] };
    active.turns[0]!.status = "inProgress";
    let state = reduce(initialThreadCollection(), {
      type: "threads",
      update: [selected, active],
    });
    state = reduce(state, { type: "selection", update: selected.id });
    state = reduce(state, {
      type: "activeTurns",
      update: { [active.id]: active.turns[0]!.id },
    });
    for (let page = 0; page < 40; page++) {
      const summaries = Array.from({ length: 50 }, (_, index) => ({
        ...detailThread(`thread-${page * 50 + index}`),
        turns: [],
        status: { type: "notLoaded" as const },
      }));
      state = reduce(state, { type: "catalogPage", threads: summaries });
      expect(state.summaries).toHaveLength(52);
      expect(state.catalogIds).toEqual(summaries.map((thread) => thread.id));
      expect(state.details.get(selected.id)).toBe(selected);
      expect(state.details.get(active.id)).toBe(active);
      expect(state.selectedThreadId).toBe(selected.id);
    }
    expect(state.summaries.some((thread) => thread.id === "thread-0")).toBe(
      false,
    );
    expect(
      materializeThreads(state).find((thread) => thread.id === active.id)
        ?.turns[0]?.status,
    ).toBe("inProgress");
    state = reduce(state, {
      type: "threads",
      update: (threads) =>
        upsertThread(threads, { ...active, name: "Still running" }),
    });
    expect(state.details.get(active.id)?.name).toBe("Still running");
  });
  it("bounds completed off-page notifications while retaining space for a newly created selection", () => {
    const reduce = createThreadCollectionReducer();
    let state = reduce(initialThreadCollection(), {
      type: "catalogPage",
      threads: [detailThread("page")],
    });
    for (let index = 0; index < 1_000; index++) {
      state = reduce(state, {
        type: "threads",
        update: (threads) =>
          upsertThread(threads, detailThread(`settled-${index}`)),
      });
      expect(state.summaries.length).toBeLessThanOrEqual(4);
    }
    state = reduce(state, {
      type: "threads",
      update: (threads) => upsertThread(threads, detailThread("created")),
    });
    state = reduce(state, { type: "selection", update: "created" });
    state = reduce(state, {
      type: "catalogPage",
      threads: [detailThread("other-page")],
    });
    expect(state.details.has("created")).toBe(true);
    expect(state.catalogIds).toEqual(["other-page"]);
    expect(state.summaries).toHaveLength(2);
  });
  it("a metadata refresh preserves an empty active detail and the ledger, while deletion does not resurrect it", () => {
    const reduce = createThreadCollectionReducer();
    const current = {
      ...detailThread("queued"),
      turns: [],
      status: { type: "active" as const, activeFlags: [] },
      controlTaskChangeLedger: { sentinel: true },
    };
    let state = reduce(initialThreadCollection(), {
      type: "threads",
      update: [current],
    });
    state = reduce(state, {
      type: "catalogPage",
      threads: [
        {
          ...detailThread(current.id),
          turns: [],
          name: "New title",
          status: { type: "notLoaded" },
        },
      ],
    });
    expect(state.details.get(current.id)).toMatchObject({
      name: "New title",
      status: { type: "active" },
      controlTaskChangeLedger: { sentinel: true },
    });
    state = reduce(state, { type: "threads", update: [] });
    expect(state.summaries).toEqual([]);
    expect(state.details.size).toBe(0);
  });
});

it("title metadata preserves loaded progress while a canonical rollback can replace it", () => {
  const current = detailThread("thread");
  current.status = { type: "active", activeFlags: [] };
  const summary = {
    ...detailThread("thread"),
    name: "renamed",
    status: { type: "notLoaded" as const },
    turns: [],
  };
  expect(mergeThreadMetadata(current, summary)).toMatchObject({
    name: "renamed",
    status: { type: "active" },
    turns: current.turns,
  });
  const rolledBack = { ...summary, status: { type: "idle" as const } };
  expect(mergeThreadMetadata(current, rolledBack)).toBe(rolledBack);
  expect(mergeThreadMetadata(current, rolledBack).turns).toEqual([]);
});
