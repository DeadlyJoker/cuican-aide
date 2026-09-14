import { describe, expect, it, vi } from "vitest";
import {
  createThreadCollectionReducer,
  initialThreadCollection,
  materializeThreads,
} from "./threadDetailCache";
import { ThreadDetailSize } from "./threadDetailSize";
import { detailThread } from "./threadDetailCache.test-support";
import { mergeThreadListSummaries, upsertThread } from "./threadModel";
import {
  commandSidebarThreadEventFingerprint,
  commandSidebarThreadState,
  reconcileCommandSidebarSeenThreadEvents,
} from "../../components/app/commandSidebarThreadPresentation";

describe("Thread detail cache", () => {
  it("preserves completed/failed indicators and read receipts when only the body is evicted", () => {
    for (const status of ["completed", "failed", "interrupted"] as const) {
      const reduce = createThreadCollectionReducer({
        maxThreads: 1,
        maxBytes: 1_000_000,
      });
      const original = detailThread("old");
      original.turns[0] = { ...original.turns[0]!, status };
      const state = reduce(initialThreadCollection(), {
        type: "threads",
        update: [detailThread("new"), original],
      });
      const cold = materializeThreads(state).find(
        (thread) => thread.id === "old",
      )!;
      expect(cold.turns).toEqual([]);
      expect(cold.status.type).toBe("notLoaded");
      const fingerprint = commandSidebarThreadEventFingerprint(original);
      expect(commandSidebarThreadEventFingerprint(cold)).toBe(fingerprint);
      expect(commandSidebarThreadState(cold, undefined)).toBe(
        commandSidebarThreadState(original, undefined),
      );
      expect(commandSidebarThreadState(cold, fingerprint)).toBe(
        commandSidebarThreadState(original, fingerprint),
      );
      expect(reconcileCommandSidebarSeenThreadEvents({}, [cold], null)).toEqual(
        {},
      );
    }
  });

  it("keeps UTF-16 titles intact when copying summary strings", () => {
    const thread = {
      ...detailThread("unicode"),
      name: "文\ud800字🦊",
      preview: "字\udc00符",
    };
    const state = createThreadCollectionReducer()(initialThreadCollection(), {
      type: "threads",
      update: [thread],
    });
    expect(state.summaries[0]!.name).toBe(thread.name);
    expect(state.summaries[0]!.preview).toBe(thread.preview);
  });

  it("keeps three recent details while the list contains 1,000 visited Threads", () => {
    const reduce = createThreadCollectionReducer();
    let state = initialThreadCollection();
    for (let index = 0; index < 1_000; index++) {
      const thread = detailThread(`thread-${index}`, "文".repeat(2_000));
      state = reduce(state, { type: "selection", update: thread.id });
      state = reduce(state, {
        type: "threads",
        update: (current) => upsertThread(current, thread),
      });
      expect(state.details.size).toBeLessThanOrEqual(3);
      expect(state.recency.length).toBe(state.details.size);
      expect(state.usage.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    }
    expect(state.summaries).toHaveLength(1_000);
    expect(state.summaries.every((thread) => thread.turns.length === 0)).toBe(
      true,
    );
    expect([...state.details.keys()].sort()).toEqual([
      "thread-997",
      "thread-998",
      "thread-999",
    ]);
    expect(
      materializeThreads(state).find((thread) => thread.id === "thread-0"),
    ).toMatchObject({
      name: "Title thread-0",
      preview: "Request thread-0",
      status: { type: "notLoaded" },
      turns: [],
    });
  });

  it("enforces bytes independently of count, including attached ledgers and Unicode", () => {
    const first = {
      ...detailThread("a", "文".repeat(3_000)),
      controlTaskChangeLedger: { paths: ["账".repeat(3_000)] },
      controlTranscriptWindow: { rows: [{ kind: "unassociated", item: { text: "旧".repeat(3_000) } }] },
    };
    const second = { ...first, id: "b" };
    const weight = new ThreadDetailSize(1_000_000).measure(first);
    const reduce = createThreadCollectionReducer({
      maxThreads: 10,
      maxBytes: weight * 2 - 1,
    });
    const state = reduce(initialThreadCollection(), {
      type: "threads",
      update: [second, first],
    });
    expect(state.details.size).toBe(1);
    expect(state.details.get("b")).toBe(second);
    expect(state.usage.estimatedBytes).toBe(weight);
    expect(state.usage.overBudget).toBe(false);
    expect(
      state.summaries.every((thread) => !("controlTaskChangeLedger" in thread)),
    ).toBe(true);
    expect(state.summaries.every((thread) => !("controlTranscriptWindow" in thread))).toBe(true);
    expect(first.turns[0]!.items).toHaveLength(2);
  });

  it("protects selection, active Turns, approvals and non-durable data, then evicts after release", () => {
    const reduce = createThreadCollectionReducer({
      maxThreads: 1,
      maxBytes: 1_000_000,
    });
    const threads = [
      detailThread("selected"),
      detailThread("active-marker"),
      {
        ...detailThread("approval"),
        status: {
          type: "active" as const,
          activeFlags: ["waitingOnApproval" as const],
        },
      },
      { ...detailThread("draft"), ephemeral: true },
      { ...detailThread("local"), modelProvider: "other" },
      detailThread("cold"),
    ];
    let state = reduce(initialThreadCollection(), {
      type: "selection",
      update: "selected",
    });
    state = reduce(state, {
      type: "activeTurns",
      update: { "active-marker": "turn-active-marker" },
    });
    state = reduce(state, { type: "threads", update: threads });
    expect([...state.details.keys()]).toEqual([
      "selected",
      "active-marker",
      "approval",
      "draft",
      "local",
    ]);
    expect(state.usage).toMatchObject({
      retainedThreads: 5,
      protectedThreads: 5,
      overBudget: true,
    });
    state = reduce(state, { type: "activeTurns", update: () => ({}) });
    expect(state.details.has("active-marker")).toBe(false);
    expect(state.details.has("approval")).toBe(true);
    const original = state;
    state = reduce(state, {
      type: "threads",
      update: (current) =>
        current
          .filter((thread) => !["draft", "local"].includes(thread.id))
          .map((thread) =>
            thread.id === "approval"
              ? { ...thread, status: { type: "idle" } }
              : thread,
          ),
    });
    expect([...state.details.keys()]).toEqual(["selected"]);
    expect(state.usage.overBudget).toBe(false);
    expect(original.details.get("approval")?.status.type).toBe("active");
  });

  it("never truncates the selected oversized body and releases it when no longer selected", () => {
    const reduce = createThreadCollectionReducer({
      maxThreads: 3,
      maxBytes: 4_096,
    });
    const large = {
      ...detailThread("large", "x".repeat(50_000)),
      preview: "文".repeat(5_000),
    };
    let state = reduce(initialThreadCollection(), {
      type: "selection",
      update: "large",
    });
    state = reduce(state, {
      type: "threads",
      update: [large, detailThread("small")],
    });
    expect(state.details.get("large")).toBe(large);
    expect(state.usage.overBudget).toBe(true);
    expect(state.usage.oversizedThreads).toBe(1);
    state = reduce(state, { type: "selection", update: null });
    expect(state.details.size).toBe(0);
    const summary = state.summaries.find((thread) => thread.id === "large")!;
    expect(summary.preview.length).toBeLessThanOrEqual(512);
    expect(summary.turns).toEqual([]);
    expect(JSON.stringify(state.summaries)).not.toContain("x".repeat(1_000));
    expect(state.usage.overBudget).toBe(false);
  });

  it("restores an evicted detail and preserves unchanged historical identities on summary refresh", () => {
    const reduce = createThreadCollectionReducer();
    const originals = ["d", "c", "b", "a"].map((id) => detailThread(id));
    let state = reduce(initialThreadCollection(), {
      type: "threads",
      update: originals,
    });
    expect(state.details.has("a")).toBe(false);
    state = reduce(state, { type: "selection", update: "a" });
    state = reduce(state, {
      type: "threads",
      update: (current) => upsertThread(current, originals[3]!),
    });
    expect(state.details.get("a")).toBe(originals[3]);
    const oldTurn = state.details.get("d")!.turns[0];
    state = reduce(state, {
      type: "threads",
      update: (current) =>
        mergeThreadListSummaries(
          current,
          state.summaries.map((thread) => ({
            ...thread,
            name: `renamed ${thread.id}`,
          })),
        ),
    });
    expect(state.details.get("d")!.turns[0]).toBe(oldTurn);
    expect(state.details.size).toBe(3);
    expect(materializeThreads(state).map((thread) => thread.id)).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  it("reuses immutable subtree weights during 100 changes to a large history", () => {
    const read = vi.fn(() => "x".repeat(10_000));
    const stable = Array.from({ length: 1_000 }, () => ({
      get content() {
        return read();
      },
    }));
    const size = new ThreadDetailSize(32 * 1024 * 1024);
    for (let index = 0; index < 100; index++)
      size.measure([...stable, { content: `delta ${index}` }]);
    expect(read).toHaveBeenCalledTimes(1_000);
  });

  it("treats cyclic or deeply nested values as over budget without overflowing the call stack", () => {
    const size = new ThreadDetailSize(4_096);
    const cycle: { next?: unknown } = {};
    cycle.next = cycle;
    expect(size.measure(cycle)).toBe(4_097);
    let deep: unknown = {};
    for (let index = 0; index < 10_000; index++) deep = { next: deep };
    expect(size.measure(deep)).toBe(4_097);
  });
});
