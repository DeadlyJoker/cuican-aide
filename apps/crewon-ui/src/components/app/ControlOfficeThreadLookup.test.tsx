// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  catalogPage,
  deferred,
  fixture as baseFixture,
  choose,
  officeAssociation,
  officeMutation,
  record,
  send,
  thread,
} from "./ControlOfficeThread.test-support";
import type { ThreadCatalogResponse } from "@crewon/contracts";
import { legacyControlOfficeThreadTitle } from "./controlOfficeChatPresentation";

function fixture() {
  const result = baseFixture();
  result.client.getOfficeThread.mockResolvedValue(officeAssociation(null));
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("finds an Office beyond an empty filtered page without changing the sidebar", async () => {
  const f = fixture();
  f.runtime.listThreads.mockResolvedValue([]);
  f.client.getThreadCatalog.mockImplementation(async (query) =>
    query?.cursor == null ? catalogPage([], "older") : catalogPage(),
  );
  try {
    await f.render();
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    await choose(f.container, "Use existing conversation");
    await send(f.container);
    expect(f.runtime.startTurn).toHaveBeenCalledWith(
      thread.id,
      expect.any(String),
      [],
      expect.any(Object),
    );
    expect(f.runtime.listThreads).not.toHaveBeenCalled();
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
    expect(f.client.getThreadCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "older" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  } finally {
    await f.close();
  }
});

it("does not create or send when the catalog remains unavailable", async () => {
  const f = fixture();
  f.runtime.listThreads.mockRejectedValue(new Error("offline"));
  f.client.getThreadCatalog.mockRejectedValue(new Error("offline"));
  try {
    await f.render();
    await send(f.container);
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(f.container.querySelector("textarea")!.value).toBe(
      "Continue the task",
    );
  } finally {
    await f.close();
  }
});

it("cancels an independent lookup on unmount and ignores its late result", async () => {
  const f = fixture(),
    pending = deferred<ThreadCatalogResponse>();
  f.client.getThreadCatalog.mockReturnValue(pending.promise);
  try {
    await f.render();
    expect(f.client.getThreadCatalog).toHaveBeenCalled();
    const signals = f.client.getThreadCatalog.mock.calls.map(
      (call) => call[1]!.signal!,
    );
    await f.close();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => pending.resolve(catalogPage()));
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
  } finally {
    pending.resolve(catalogPage());
    await f.close();
  }
});

it.each(["current", "legacy"] as const)(
  "refuses a second %s match on a later page, including an unverified live preview",
  async (kind) => {
    const f = fixture();
    const other = {
      ...thread,
      id: "thread-other",
      name:
        kind === "legacy"
          ? legacyControlOfficeThreadTitle(record)
          : thread.name,
    };
    f.client.getThreadCatalog.mockImplementation(async (query) =>
      query?.cursor == null
        ? catalogPage([thread], "older")
        : catalogPage([other]),
    );
    try {
      await f.render([thread], {
        streamingTextByThread: { [thread.id]: "Unverified answer" },
      });
      expect(f.container.textContent).not.toContain("Unverified answer");
      expect(f.container.textContent).toContain(
        "Several conversations match this Office",
      );
      await send(f.container);
      expect(f.runtime.readThread).not.toHaveBeenCalled();
      expect(f.runtime.renameThread).not.toHaveBeenCalled();
      expect(f.runtime.startTurn).not.toHaveBeenCalled();
      expect(f.client.createOfficeThread).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each(["cycle", "budget", "error"] as const)(
  "does not adopt a first match or create after an incomplete lookup (%s)",
  async (kind) => {
    const f = fixture();
    let pages = 0;
    f.client.getThreadCatalog.mockImplementation(async (query) => {
      pages++;
      if (query?.cursor == null) return catalogPage([thread], "older");
      if (kind === "error") throw new Error("offline");
      return catalogPage([], kind === "cycle" ? "older" : `older-${pages}`);
    });
    try {
      await f.render();
      f.client.getThreadCatalog.mockClear();
      await send(f.container);
      expect(f.client.getThreadCatalog.mock.calls.length).toBeLessThanOrEqual(
        100,
      );
      expect(f.runtime.readThread).not.toHaveBeenCalled();
      expect(f.runtime.startTurn).not.toHaveBeenCalled();
      expect(f.client.createOfficeThread).not.toHaveBeenCalled();
      expect(f.container.querySelector("textarea")!.value).toBe(
        "Continue the task",
      );
    } finally {
      await f.close();
    }
  },
);

it("finds an association established after the empty initial lookup before sending", async () => {
  const f = fixture();
  f.client.getThreadCatalog.mockResolvedValue(catalogPage([]));
  try {
    await f.render();
    f.client.getOfficeThread.mockResolvedValue(officeAssociation());
    await send(f.container);
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).toHaveBeenCalledWith(
      thread.id,
      expect.any(String),
      [],
      expect.any(Object),
    );
  } finally {
    await f.close();
  }
});

it("reuses the creation key after an uncertain response within the same Office", async () => {
  const f = fixture();
  f.client.getThreadCatalog.mockResolvedValue(catalogPage([]));
  f.client.createOfficeThread.mockRejectedValueOnce(new Error("response lost"));
  f.client.createOfficeThread.mockResolvedValue(officeMutation("created"));
  try {
    await f.render();
    await send(f.container);
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    await send(f.container);
    expect(f.client.createOfficeThread).toHaveBeenCalledTimes(2);
    expect(f.client.createOfficeThread.mock.calls[0]).toEqual(
      f.client.createOfficeThread.mock.calls[1],
    );
    expect(f.runtime.startTurn).toHaveBeenCalledOnce();
    expect(f.runtime.startTurn).toHaveBeenCalledWith(
      thread.id,
      expect.any(String),
      [],
      expect.any(Object),
    );
  } finally {
    await f.close();
  }
});

it("cancels lookup before creation if the Office closes during a send", async () => {
  const f = fixture(),
    pending = deferred<ThreadCatalogResponse>();
  f.client.getThreadCatalog.mockResolvedValue(catalogPage([]));
  try {
    await f.render();
    f.client.getThreadCatalog.mockReturnValue(pending.promise);
    await send(f.container);
    const signal = f.client.getThreadCatalog.mock.lastCall![1]!.signal!;
    await f.close();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(catalogPage([])));
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  } finally {
    pending.resolve(catalogPage([]));
    await f.close();
  }
});

it("bounds a stalled initial lookup, ignores late pages and releases all owned timers", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    pending = deferred<ThreadCatalogResponse>();
  f.client.getThreadCatalog.mockReturnValue(pending.promise);
  try {
    await f.render();
    const signal = f.client.getThreadCatalog.mock.lastCall![1]!.signal!;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(signal.aborted).toBe(true);
    expect(f.container.querySelector("textarea")!.disabled).toBe(false);
    expect(
      f.container.querySelector('[data-runtime-status="error"]'),
    ).not.toBeNull();
    await act(async () => pending.resolve(catalogPage()));
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    pending.resolve(catalogPage());
    await f.close();
  }
});

it("requires explicit legacy adoption and keeps the original conversation title", async () => {
  const f = fixture();
  const legacy = { ...thread, name: legacyControlOfficeThreadTitle(record) };
  f.client.getThreadCatalog.mockImplementation(async (query) =>
    query?.cursor == null ? catalogPage([legacy], "older") : catalogPage([]),
  );
  f.runtime.renameThread.mockRejectedValue(new Error("offline"));
  try {
    await f.render();
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    await choose(f.container, "Use existing conversation");
    expect(f.client.bindOfficeThread).toHaveBeenCalledWith(
      record.definition.officeVersionId,
      { threadId: thread.id, expectedRevision: 1 },
    );
    expect(f.runtime.renameThread).not.toHaveBeenCalled();
    f.client.getThreadCatalog.mockRejectedValue(new Error("offline"));
    await send(f.container);
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).toHaveBeenCalledWith(
      thread.id,
      expect.any(String),
      [],
      expect.any(Object),
    );
  } finally {
    await f.close();
  }
});
