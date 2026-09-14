// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSkillScheduleEntry } from "./useSkillScheduleEntry";
import type { SkillLibraryControlClient } from "./SkillLibraryHost";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const input = {
  title: "销售汇总",
  invocation: {
    schemaVersion: "crewon.skill-invocation.v1" as const,
    skill: {
      skillId: "skill-1",
      versionId: "version-1",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
    parameters: { date: "2026-09-21" },
    requiredToolRefs: ["crewon_browser_act"],
  },
};
it("opens a complete Skill schedule draft only after real thread preparation, retrying a lost creation response with the same key", async () => {
  const onReady = vi.fn();
  const client: SkillLibraryControlClient = {
    requestSkill: vi.fn(),
    getRun: vi.fn(),
    createThread: vi
      .fn()
      .mockRejectedValueOnce(new Error("lost_ack"))
      .mockResolvedValue({
        thread: { threadId: "schedule-thread", revision: 1 },
      }),
    getThread: vi.fn(async () => ({
      thread: { threadId: "schedule-thread", revision: 2, status: "active" },
    })),
  };
  let entry!: ReturnType<typeof useSkillScheduleEntry>;
  function Probe() {
    entry = useSkillScheduleEntry({
      controlClient: client,
      selectedThreadId: null,
      onReady,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => entry.request(input));
    expect(onReady).not.toHaveBeenCalled();
    expect(entry.error).toContain("重试");
    await act(async () => entry.request(input));
    const calls = vi.mocked(client.createThread).mock.calls;
    expect(calls[1]).toEqual(calls[0]);
    expect(client.getThread).toHaveBeenCalledWith("schedule-thread");
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({
        title: input.title,
        skillInvocation: input.invocation,
      }),
      "schedule-thread",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("uses a Skill delivery thread before the currently selected thread and never creates an unrelated one", async () => {
  const onReady = vi.fn();
  const client: SkillLibraryControlClient = {
    requestSkill: vi.fn(),
    getRun: vi.fn(),
    createThread: vi.fn(),
    getThread: vi.fn(async () => ({
      thread: { threadId: "delivery-thread", revision: 5, status: "active" },
    })),
  };
  let entry!: ReturnType<typeof useSkillScheduleEntry>;
  function Probe() {
    entry = useSkillScheduleEntry({
      controlClient: client,
      selectedThreadId: "selected-thread",
      onReady,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    const invocation = {
      ...input.invocation,
      deliveryTarget: {
        schemaVersion: "crewon.delivery-target.v1" as const,
        tenantId: "tenant",
        spaceId: "space",
        threadId: "delivery-thread",
        targetId: "thread-deliveries" as const,
      },
    };
    await act(async () => entry.request({ ...input, invocation }));
    expect(client.createThread).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ skillInvocation: invocation }),
      "delivery-thread",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not open a prepared schedule after the authenticated Control client changes", async () => {
  const onReady = vi.fn();
  let resolve!: (value: {
    thread: { threadId: string; revision: number };
  }) => void;
  const oldClient: SkillLibraryControlClient = {
    requestSkill: vi.fn(),
    getRun: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(
      () =>
        new Promise<{ thread: { threadId: string; revision: number } }>(
          (done) => {
            resolve = done;
          },
        ),
    ),
  };
  const newClient: SkillLibraryControlClient = {
    requestSkill: vi.fn(),
    getRun: vi.fn(),
    createThread: vi.fn(async () => ({
      thread: { threadId: "new-thread", revision: 1 },
    })),
    getThread: vi.fn(async () => ({
      thread: { threadId: "new-thread", revision: 1, status: "active" },
    })),
  };
  let entry!: ReturnType<typeof useSkillScheduleEntry>;
  function Probe({ client }: { client: SkillLibraryControlClient }) {
    entry = useSkillScheduleEntry({
      controlClient: client,
      selectedThreadId: null,
      onReady,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe client={oldClient} />));
    let pending!: Promise<void>;
    await act(async () => {
      pending = entry.request(input);
    });
    await act(async () => root.render(<Probe client={newClient} />));
    await act(async () => {
      resolve({ thread: { threadId: "old-thread", revision: 1 } });
      await pending;
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(oldClient.getThread).not.toHaveBeenCalled();
    await act(async () => entry.request(input));
    expect(onReady).toHaveBeenCalledWith(expect.anything(), "new-thread");
  } finally {
    await act(async () => root.unmount());
  }
});
