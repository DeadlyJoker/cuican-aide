// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useControlWorkflowRecords } from "./useControlWorkflowRecords";
import {
  ControlDurableWorkflowRuntime,
  type ControlDurableWorkflowClient,
} from "../../lib/control-runtime/controlDurableWorkflowRuntime";
import type { CrewonWorkflowRecord } from "../../lib/workflow/crewonWorkflow";
import { workflowCommandsSnapshotFixture } from "../../lib/control-runtime/controlWorkflowCommands.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const contextId = `sha256:${"a".repeat(64)}`;
function record(runId = "root-1", name = "Review"): CrewonWorkflowRecord {
  return {
    filePath: "control:workflow-version:version-1",
    savedAt: "2026-10-18T00:00:00.000Z",
    config: {
      workflowId: "version-1",
      name,
      description: "Review",
      lead: "producer",
      status: "running",
      resourceSource: "crewon",
      createdAt: 1,
      updatedAt: 2,
      nodes: [],
      runs: [
        {
          executionId: runId,
          status: "running",
          input: "input",
          output: "",
          error: null,
          createdAt: 1,
          updatedAt: 2,
          executedNodes: [],
        },
      ],
    },
    control: {
      source: "durable",
      workflowVersionId: "version-1",
      loaded: true,
      readOnlyReason: null,
      inputMode: "json",
      inputSchema: null,
      knownRunId: runId,
      root: { ...workflowCommandsSnapshotFixture().run, runId },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(name = "Review") {
  const runtime = new ControlDurableWorkflowRuntime({
    client: {} as ControlDurableWorkflowClient,
  });
  const availability = vi.spyOn(runtime, "availability").mockResolvedValue({
    contextId,
    execution: {
      version: "v1",
      admission: true,
      snapshots: true,
      humanGates: true,
    },
    pending: [],
  });
  const catalog = vi.spyOn(runtime, "catalog").mockImplementation(async () => {
    const value = record("root-1", name);
    value.config.runs = [];
    value.control!.loaded = false;
    value.control!.knownRunId = null;
    return { nextCursor: null, records: [value] };
  });
  const read = vi
    .spyOn(runtime, "read")
    .mockImplementation(async (scope) => record(scope.runId ?? "root-1", name));
  const run = vi
    .spyOn(runtime, "runWorkflow")
    .mockImplementation(async () => record("root-new", name));
  const legacy = vi
    .spyOn(runtime, "legacy")
    .mockResolvedValue({ nextCursor: null, records: [] });
  return { runtime, availability, catalog, read, run, legacy };
}
let root: Root, container: HTMLDivElement;
let state!: ReturnType<typeof useControlWorkflowRecords>;
function Harness({
  runtime,
  enabled = true,
}: {
  runtime: ControlDurableWorkflowRuntime;
  enabled?: boolean;
}) {
  state = useControlWorkflowRecords({ runtime, enabled, refreshNonce: 0 });
  return (
    <output>
      {state.records
        .map((record) => `${record.config.name}:${record.control?.knownRunId}`)
        .join(",")}
    </output>
  );
}
async function render(runtime: ControlDurableWorkflowRuntime, enabled = true) {
  await act(async () => {
    root.render(
      <StrictMode>
        <Harness runtime={runtime} enabled={enabled} />
      </StrictMode>,
    );
  });
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("Control Workflow source-bound record ownership", () => {
  it("keeps unsupported deployments read-only without falling back to renderer execution", async () => {
    const f = fixture();
    f.availability.mockResolvedValue({
      contextId: null,
      execution: {
        version: "v1",
        admission: false,
        snapshots: false,
        humanGates: false,
      },
      pending: [],
    });
    const definition = record();
    definition.config.runs = [];
    definition.control!.knownRunId = null;
    definition.control!.root = undefined;
    vi.spyOn(f.runtime, "definition").mockResolvedValue(definition);
    await render(f.runtime);
    await act(async () => {
      await state.inspect({ workflowVersionId: "version-1", runId: null });
    });
    expect(state.records[0]!.control).toMatchObject({
      canStart: false,
      canReview: false,
      readOnlyReason: "当前服务尚未启用持久协作流执行，记录可查看",
    });
    expect(f.read).not.toHaveBeenCalled();
    await expect(
      state.run({
        workflowVersionId: "version-1",
        threadId: "thread-1",
        prompt: "Original input",
      }),
    ).rejects.toThrow("workflow_durable_execution_unavailable");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("does not disable existing-root review when only new admission is off", async () => {
    const f = fixture();
    f.availability.mockResolvedValue({
      contextId,
      execution: {
        version: "v1",
        admission: false,
        snapshots: true,
        humanGates: true,
      },
      pending: [],
    });
    await render(f.runtime);
    await act(async () => {
      await state.inspect({ workflowVersionId: "version-1", runId: "root-1" });
    });
    expect(state.records[0]!.control).toMatchObject({
      canStart: false,
      canReview: true,
      readOnlyReason: null,
      knownRunId: "root-1",
    });
  });
  it("retains another visited root across scoped refreshes but replaces history on explicit page navigation", async () => {
    const f = fixture();
    await render(f.runtime);
    for (const runId of ["root-a", "root-b", "root-a"])
      await act(async () => {
        await state.inspect({ workflowVersionId: "version-1", runId });
      });
    expect(state.records[0]?.control?.knownRunId).toBe("root-a");
    expect(
      state.records[0]?.control?.roots?.some((run) => run.runId === "root-b"),
    ).toBe(true);
    await act(async () => {
      await state.reload({ workflowVersionId: "version-1", runId: "root-a" });
    });
    expect(
      state.records[0]?.control?.roots?.some((run) => run.runId === "root-b"),
    ).toBe(true);
    const page = record("root-page");
    page.control!.roots = [page.control!.root!];
    page.control!.nextRootCursor = null;
    f.read.mockResolvedValueOnce(page);
    await act(async () => {
      await state.inspect({ workflowVersionId: "version-1", runId: null });
    });
    expect(state.records[0]?.control?.roots?.map((run) => run.runId)).toEqual([
      "root-page",
    ]);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("loads only the directory on mount, never execution or legacy discovery", async () => {
    const f = fixture();
    await render(f.runtime);
    expect(state.status).toBe("ready");
    expect(f.catalog).toHaveBeenCalledOnce();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.legacy).not.toHaveBeenCalled();
  });
  it("coalesces identical slow root reads and retains the last record on rejection", async () => {
    const f = fixture();
    await render(f.runtime);
    await act(async () => {
      await state.inspect({ workflowVersionId: "version-1", runId: "root-1" });
    });
    const held = deferred<CrewonWorkflowRecord>();
    f.read.mockReturnValueOnce(held.promise);
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => {
      first = state.reload({ workflowVersionId: "version-1", runId: "root-1" });
      second = state.reload({
        workflowVersionId: "version-1",
        runId: "root-1",
      });
    });
    expect(first).toBe(second);
    expect(f.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      held.resolve(record());
      await first;
    });
    f.read.mockRejectedValueOnce(Error("offline"));
    await act(async () => {
      await state.reload({ workflowVersionId: "version-1", runId: "root-1" });
    });
    expect(state.records[0]?.control?.knownRunId).toBe("root-1");
    expect(state.status).toBe("ready");
    expect(state.notice).toBe("offline");
    expect(f.catalog).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("does not let an old client/catalog response replace a new source", async () => {
    const first = fixture("Old account"),
      second = fixture("New account");
    const held =
      deferred<Awaited<ReturnType<ControlDurableWorkflowRuntime["catalog"]>>>();
    first.catalog.mockReturnValueOnce(held.promise);
    await render(first.runtime);
    await render(second.runtime);
    expect(container.textContent).toContain("New account");
    await act(async () => {
      held.resolve({
        records: [record("old-root", "Old account")],
        nextCursor: null,
      });
    });
    expect(container.textContent).toContain("New account");
    expect(container.textContent).not.toContain("Old account");
  });
  it("drops late old-root reads after an accepted submission and ignores the stale submit callback's root", async () => {
    const f = fixture();
    await render(f.runtime);
    await act(async () => {
      await state.inspect({ workflowVersionId: "version-1", runId: "root-1" });
    });
    const held = deferred<CrewonWorkflowRecord>();
    f.read.mockReturnValueOnce(held.promise);
    let polling!: Promise<void>;
    await act(async () => {
      polling = state.reload({
        workflowVersionId: "version-1",
        runId: "root-1",
      });
    });
    await act(async () => {
      await state.run({
        workflowVersionId: "version-1",
        threadId: "thread-1",
        prompt: '{"topic":"new"}',
      });
    });
    expect(state.records[0]?.control?.knownRunId).toBe("root-new");
    await act(async () => {
      await state.reload({ workflowVersionId: "version-1", runId: "root-1" });
      held.resolve(record("root-1"));
      await polling;
    });
    expect(state.records[0]?.control?.knownRunId).toBe("root-new");
    expect(f.run.mock.calls[0]?.[1]).toMatchObject({
      expectedRecoveryContext: contextId,
    });
    expect(
      f.read.mock.calls.filter(([scope]) => scope.runId === "root-1"),
    ).toHaveLength(2);
  });
  it("opens a new draft without canceling or advancing the existing root and retains its history entry", async () => {
    const f = fixture();
    await render(f.runtime);
    await act(async () => {
      await state.inspect({ workflowVersionId: "version-1", runId: "root-1" });
    });
    await act(async () => {
      state.draft("version-1");
    });
    expect(state.records[0]?.config.runs).toEqual([]);
    expect(state.records[0]?.control?.knownRunId).toBeNull();
    expect(state.records[0]?.control?.roots?.[0]?.runId).toBe("root-1");
    expect(f.run).not.toHaveBeenCalled();
    await act(async () => {
      await state.reload({ workflowVersionId: "version-1", runId: "root-1" });
    });
    expect(state.records[0]?.control?.knownRunId).toBeNull();
  });

  it("keeps a user's newly selected root when an earlier mutation finishes later", async () => {
    const f = fixture();
    await render(f.runtime);
    await act(async () => {
      await state.inspect({ workflowVersionId: "version-1", runId: "root-1" });
    });
    const held = deferred<CrewonWorkflowRecord>();
    f.run.mockReturnValueOnce(held.promise);
    let submitted!: Promise<unknown>;
    await act(async () => {
      submitted = state.run({
        workflowVersionId: "version-1",
        threadId: "thread-1",
        prompt: "{}",
      });
    });
    await act(async () => {
      await state.inspect({
        workflowVersionId: "version-1",
        runId: "root-chosen",
      });
    });
    await act(async () => {
      held.resolve(record("root-new"));
      await submitted;
    });
    expect(state.records[0]?.control?.knownRunId).toBe("root-chosen");
  });

  it("ignores a late mutation result after changing source and rejects its callback", async () => {
    const first = fixture("Old source"),
      second = fixture("New source"),
      held = deferred<CrewonWorkflowRecord>();
    await render(first.runtime);
    first.run.mockReturnValueOnce(held.promise);
    let outcome!: Promise<unknown>;
    await act(async () => {
      outcome = state
        .run({
          workflowVersionId: "version-1",
          threadId: "thread-1",
          prompt: "{}",
        })
        .catch((error) => error);
    });
    await render(second.runtime);
    let error: unknown;
    await act(async () => {
      held.resolve(record("old-root", "Old source"));
      error = await outcome;
    });
    expect(error).toMatchObject({ name: "AbortError" });
    expect(container.textContent).toContain("New source");
    expect(container.textContent).not.toContain("old-root");
  });
  it("clears displayed records when the same client reports another recovery context and reloads its definitions", async () => {
    const f = fixture();
    await render(f.runtime);
    await act(async () => {
      await state.inspect({ workflowVersionId: "version-1", runId: "root-1" });
    });
    f.availability.mockResolvedValue({
      contextId: `sha256:${"b".repeat(64)}`,
      execution: {
        version: "v1",
        admission: true,
        snapshots: true,
        humanGates: true,
      },
      pending: [],
    });
    f.catalog.mockResolvedValue({ records: [], nextCursor: null });
    await act(async () => {
      await state.reload();
    });
    expect(state.records).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("loads legacy history only on an explicit action", async () => {
    const f = fixture();
    await render(f.runtime);
    expect(f.legacy).not.toHaveBeenCalled();
    await act(async () => {
      await state.browse("legacy");
    });
    expect(f.legacy).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
    expect(state.mode).toBe("legacy");
  });
});
