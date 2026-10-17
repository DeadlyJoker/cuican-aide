// @vitest-environment happy-dom
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CrewonWorkflowExecution,
  CrewonWorkflowRecord,
} from "../../lib/workflow/crewonWorkflow";
import { CommandWorkflowPanel } from "./CommandWorkflowPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Props = ComponentProps<typeof CommandWorkflowPanel>;
let root: Root;
let container: HTMLDivElement;
function record(status = "running"): CrewonWorkflowRecord {
  return {
    filePath: "control:workflow-version:review-v1",
    savedAt: "2026-10-17T00:00:00Z",
    config: {
      workflowId: "review-v1",
      name: "页面交付协作流",
      description: "审阅后核验",
      lead: "reviewer",
      status,
      resourceSource: "crewon",
      createdAt: 1,
      updatedAt: 2,
      nodes: [
        {
          nodeId: "review",
          title: "需求审阅",
          agentId: "reviewer",
          agentName: "产品审阅智能体",
          instruction: "审阅需求",
        },
      ],
      runs: [
        {
          executionId: "root-1",
          status,
          input: "核对页面",
          output: status === "completed" ? "交付结果" : "",
          error: null,
          createdAt: 1,
          updatedAt: 2,
          executedNodes: [
            {
              nodeId: "review",
              nodeType: "agent",
              title: "需求审阅",
              agentId: "reviewer",
              status:
                status === "waitingForApproval" ? "waitingForApproval" : status,
              output: status === "completed" ? "交付结果" : "",
              error: null,
            },
          ],
        },
      ],
    },
  };
}
function props(changes: Partial<Props> = {}): Props {
  return {
    defaultOpenWorkflowId: "review-v1",
    status: "ready",
    workflows: [record()],
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onResolveGate: vi.fn(),
    onReload: vi.fn(async () => {}),
    ...changes,
  };
}
async function render(input: Props) {
  await act(async () => {
    root.render(
      <StrictMode>
        <CommandWorkflowPanel {...input} />
      </StrictMode>,
    );
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Workflow progress ownership", () => {
  it("backs off passive Gate observation while preserving cross-window approval discovery", async () => {
    const input = props({ workflows: [record("waitingForApproval")] });
    await render(input);
    await advance(2000);
    expect(input.onReload).toHaveBeenCalledTimes(1);
    await advance(14999);
    expect(input.onReload).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(input.onReload).toHaveBeenCalledTimes(2);
    await render({ ...input, workflows: [record("running")] });
    await advance(2000);
    expect(input.onReload).toHaveBeenCalledTimes(3);
  });

  it("continues observing an immediately accepted Run and displays its later canonical completion without resubmission", async () => {
    const ready = record("ready");
    ready.config.runs = [];
    const completed = record("completed");
    const accepted: CrewonWorkflowExecution = {
      executionId: "root-1",
      workflowId: "review-v1",
      status: "running",
      output: "",
      error: null,
      executedNodes: record().config.runs![0]!.executedNodes,
    };
    const input = props({
      workflows: [ready],
      onRun: vi.fn(async () => accepted),
    });
    await render(input);
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "#workflow-message-input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, "核对页面");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(input.onRun).toHaveBeenCalledTimes(1);
    expect(input.onReload).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="取消当前协作流运行"]',
      )!.disabled,
    ).toBe(false);
    await advance(2000);
    expect(input.onReload).toHaveBeenCalledTimes(2);
    await render({ ...input, workflows: [completed] });
    expect(container.textContent).toContain("交付结果");
    expect(
      container.querySelector('[aria-label="取消当前协作流运行"]'),
    ).toBeNull();
    await advance(10000);
    expect(input.onReload).toHaveBeenCalledTimes(2);
    expect(input.onRun).toHaveBeenCalledTimes(1);
  });

  it("keeps observing after Gate approval returns a still-running task", async () => {
    const gate = record("waitingForApproval");
    gate.config.nodes = [
      {
        nodeId: "review",
        type: "humanGate",
        title: "需求审阅",
        instruction: "确认后继续",
      },
    ];
    const input = props({
      workflows: [gate],
      onResolveGate: vi.fn(async () => ({
        executionId: "root-1",
        workflowId: "review-v1",
        status: "running",
        output: "",
        error: null,
        executedNodes: record().config.runs![0]!.executedNodes,
      })),
    });
    await render(input);
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "批准并继续",
    )!;
    await act(async () => approve.click());
    expect(input.onResolveGate).toHaveBeenCalledTimes(1);
    expect(input.onReload).toHaveBeenCalledTimes(1);
    await advance(2000);
    expect(input.onReload).toHaveBeenCalledTimes(2);
    expect(input.onResolveGate).toHaveBeenCalledTimes(1);
    expect(input.onRun).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "waitingForApproval", "canceling"])(
    "resumes a persisted %s task without submitting another command",
    async (status) => {
      const input = props({ workflows: [record(status)] });
      await render(input);
      await advance(2000);
      expect(input.onReload).toHaveBeenCalledTimes(1);
      expect(input.onRun).not.toHaveBeenCalled();
      expect(input.onResolveGate).not.toHaveBeenCalled();
      expect(input.onCancel).not.toHaveBeenCalled();
    },
  );

  it("serializes slow automatic reads and uses the newest callback without resetting the timer", async () => {
    const pending = deferred(),
      first = vi.fn(() => pending.promise),
      second = vi.fn(async () => {});
    const input = props({ onReload: first });
    await render(input);
    await advance(2000);
    expect(first).toHaveBeenCalledTimes(1);
    await render({ ...input, onReload: second });
    await advance(10000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await advance(1999);
    expect(second).not.toHaveBeenCalled();
    await advance(1);
    expect(second).toHaveBeenCalledTimes(1);
    const latest = vi.fn(async () => {});
    await advance(1000);
    await render({ ...input, onReload: latest });
    await advance(1000);
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("keeps observing after a rejected read without submitting or cancelling work", async () => {
    const reload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("fixture read failed"))
      .mockResolvedValue(undefined);
    const input = props({ onReload: reload });
    await render(input);
    await advance(4000);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(input.onRun).not.toHaveBeenCalled();
    expect(input.onCancel).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "canceled"])(
    "stops automatic reads when the authoritative projection becomes %s",
    async (status) => {
      const input = props();
      await render(input);
      await advance(2000);
      expect(input.onReload).toHaveBeenCalledTimes(1);
      await render({ ...input, workflows: [record(status)] });
      await advance(10000);
      expect(input.onReload).toHaveBeenCalledTimes(1);
      if (status === "completed")
        expect(container.textContent).toContain("交付结果");
    },
  );

  it("stops on hide and return, resumes on reopen, and does not reschedule after an in-flight read settles on unmount", async () => {
    const pending = deferred(),
      reload = vi.fn(() => pending.promise),
      input = props({ onReload: reload });
    await render(input);
    await advance(1000);
    await render({ ...input, active: false });
    await advance(10000);
    expect(reload).not.toHaveBeenCalled();
    await render(input);
    await advance(2000);
    expect(reload).toHaveBeenCalledTimes(1);
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "返回",
    )!;
    await act(async () => back.click());
    await advance(10000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-workflow-list]")).not.toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>("[data-workflow-open]")!
        .click(),
    );
    await advance(2000);
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    await act(async () => pending.resolve());
    await advance(10000);
    expect(reload).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
