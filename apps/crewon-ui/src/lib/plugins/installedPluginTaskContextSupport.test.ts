import { describe, expect, it } from "vitest";
import {
  installedPluginTaskProjection,
  installedPluginTaskRunIds,
  installedPluginTaskThread,
  INSTALLED_PLUGIN_TASK_CONTEXT_LIMITS,
} from "./installedPluginTaskContextSupport";
import {
  taskContextTask,
  taskContextThread,
} from "./installedPluginTaskContext.test-support";

describe("installed plugin public task projection bounds", () => {
  it("copies a large actual DTO without rewriting identifiers and explicitly reports omitted result images", () => {
    const original = taskContextTask();
    original.operations[0]!.images = Array.from({ length: 16 }, (_, index) => ({
      url: `https://result.fixture.invalid/${index}${"x".repeat(1900)}`,
      filename: "画面.png",
    }));
    const tasks = Array.from({ length: 8 }, (_, index) => ({
      ...original,
      runId: `run-${index}`,
      operations: [{ ...original.operations[0]!, sourceRunId: `run-${index}` }],
    }));
    const result = installedPluginTaskProjection(
      { threadId: "thread-1", revision: 17, provisional: false },
      tasks,
      null,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(result.data)).length,
    ).toBeLessThanOrEqual(INSTALLED_PLUGIN_TASK_CONTEXT_LIMITS.bytes);
    expect(result.tasks.map(({ runId }) => runId)).toEqual(
      tasks.map(({ runId }) => runId),
    );
    expect(result.tasks.some(({ truncated }) => truncated)).toBe(true);
    expect(
      tasks.every(({ operations }) => operations[0]!.images.length === 16),
    ).toBe(true);
    expect(Object.isFrozen(result.tasks)).toBe(true);
  });
  it("never equates an event cursor or a creation receipt with a Thread revision", () => {
    expect(() =>
      installedPluginTaskThread(
        { thread: taskContextThread(), eventSequence: 18 },
        "thread-1",
        false,
      ),
    ).toThrow();
    expect(() =>
      installedPluginTaskThread(
        { thread: taskContextThread(), eventSequence: 17 },
        "other-thread",
        false,
      ),
    ).toThrow();
  });
  it("rejects invalid or unbounded recovery references before requesting HTTP", () => {
    expect(() =>
      installedPluginTaskRunIds(
        Array.from({ length: 9 }, (_, index) => `run-${index}`),
      ),
    ).toThrow();
    expect(() => installedPluginTaskRunIds(["../run"])).toThrow();
    expect(() => installedPluginTaskRunIds(new Array<string>(2))).toThrow();
    let invoked = false;
    const accessor: string[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return "run-1";
      },
    });
    expect(() => installedPluginTaskRunIds(accessor)).toThrow();
    expect(invoked).toBe(false);
    expect(installedPluginTaskRunIds(["run-1", "run-1"])).toEqual(["run-1"]);
  });
});
