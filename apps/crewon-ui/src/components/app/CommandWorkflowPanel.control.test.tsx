// @vitest-environment happy-dom
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandWorkflowPanel } from "./CommandWorkflowPanel";
import type {
  CrewonWorkflowExecution,
  CrewonWorkflowRecord,
} from "../../lib/workflow/crewonWorkflow";
import { workflowCommandsSnapshotFixture } from "../../lib/control-runtime/controlWorkflowCommands.test-support";
import type { WorkflowIntent } from "../../lib/control-runtime/controlWorkflowIntentJournal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Props = ComponentProps<typeof CommandWorkflowPanel>;
function record(status = "running"): CrewonWorkflowRecord {
  return {
    filePath: "control:workflow-version:version-1",
    savedAt: "2026-10-18T00:00:00.000Z",
    config: {
      workflowId: "version-1",
      name: "Release review",
      description: "Review and verify",
      lead: "producer",
      status,
      resourceSource: "crewon",
      createdAt: 1,
      updatedAt: 2,
      nodes: [
        {
          nodeId: "gate-one",
          type: "humanGate",
          title: "First review",
          instruction: "Review evidence",
        },
        {
          nodeId: "gate-two",
          type: "humanGate",
          title: "Second review",
          instruction: "Review independently",
        },
      ],
      runs: [
        {
          executionId: "run-1",
          status,
          input: "Original input",
          output: "",
          error: null,
          createdAt: 1,
          updatedAt: 2,
          executedNodes: ["gate-one", "gate-two"].map((nodeId, index) => ({
            nodeId,
            nodeType: "humanGate",
            title: index ? "Second review" : "First review",
            status:
              status === "waitingForApproval" ? "waitingForApproval" : status,
            output: "",
            error: null,
          })),
        },
      ],
    },
    control: {
      source: "durable",
      workflowVersionId: "version-1",
      loaded: true,
      readOnlyReason: null,
      inputMode: "json",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string" } },
      },
      knownRunId: "run-1",
      root: workflowCommandsSnapshotFixture().run,
    },
  };
}
function execution(): CrewonWorkflowExecution {
  return {
    workflowId: "version-1",
    executionId: "run-1",
    status: "running",
    output: "",
    error: null,
    executedNodes: [],
  };
}
function props(changes: Partial<Props> = {}): Props {
  return {
    defaultOpenWorkflowId: "version-1",
    status: "ready",
    workflows: [record()],
    onRun: vi.fn(async () => execution()),
    onCancel: vi.fn(async () => execution()),
    onResolveGate: vi.fn(async () => execution()),
    onReload: vi.fn(async () => {}),
    onInspect: vi.fn(async () => {}),
    ...changes,
  };
}
let root: Root, container: HTMLDivElement;
async function render(input: Props) {
  await act(async () => {
    root.render(
      <StrictMode>
        <CommandWorkflowPanel {...input} />
      </StrictMode>,
    );
  });
}
async function type(selector: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("durable Workflow room controls", () => {
  it("shows the next unfinished node after approval instead of returning to a completed producer", async () => {
    const value = record();
    value.config.runs![0]!.executedNodes[0]!.status = "completed";
    value.config.runs![0]!.executedNodes[1]!.status = "pending";
    await render(props({ workflows: [value] }));
    expect(
      container.querySelector(".workflow-room-title-block")!.textContent,
    ).toContain("当前阶段：Second review");
  });
  const pendingStart = (): WorkflowIntent => ({
    version: "v1",
    id: "pending-start",
    contextId: `sha256:${"a".repeat(64)}`,
    workflowVersionId: "other-version",
    threadId: "thread-1",
    createdAt: "2026-10-18T00:00:00Z",
    command: {
      kind: "start",
      body: {
        workflowVersionId: "other-version",
        threadId: "thread-1",
        input: { prompt: "Original input" },
      },
    },
  });
  it("blocks a new start on the same main Thread across versions, but leaves another main Thread usable", async () => {
    const empty = record("ready");
    empty.config.runs = [];
    empty.control!.knownRunId = null;
    const input = props({
      workflows: [empty],
      executionContext: { threadId: "thread-1", pending: [pendingStart()] },
    });
    await render(input);
    expect(
      container.querySelector<HTMLTextAreaElement>("#workflow-message-input")!
        .disabled,
    ).toBe(true);
    expect(container.textContent).toContain("请恢复原请求");
    await render({
      ...input,
      executionContext: { threadId: "thread-2", pending: [pendingStart()] },
    });
    expect(
      container.querySelector<HTMLTextAreaElement>("#workflow-message-input")!
        .disabled,
    ).toBe(false);
    expect(input.onRun).not.toHaveBeenCalled();
  });
  it("does not hide parallel approvals because another original submission awaits recovery", async () => {
    const input = props({
      workflows: [record("waitingForApproval")],
      executionContext: { threadId: "thread-1", pending: [pendingStart()] },
    });
    await render(input);
    expect(
      container.querySelectorAll('[aria-label="选择确认环节"] option'),
    ).toHaveLength(2);
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "批准并继续",
      )!.disabled,
    ).toBe(false);
  });
  it("labels a lost submission reply as unknown rather than declaring execution failed", async () => {
    const empty = record("ready");
    empty.config.runs = [];
    empty.control!.knownRunId = null;
    const input = props({
      workflows: [empty],
      onRun: vi.fn(async () => {
        throw Error("workflow_command_unconfirmed");
      }),
    });
    await render(input);
    await type("#workflow-message-input", '{"topic":"Original input"}');
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.querySelector("strong")!.textContent).toBe("请求结果待确认");
    expect(alert.textContent).toContain("请使用恢复原请求");
    expect(input.onRun).toHaveBeenCalledTimes(1);
  });
  it("uses only the selected known root for progress refresh", async () => {
    vi.useFakeTimers();
    const input = props();
    await render(input);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(input.onReload).toHaveBeenCalledWith({
      workflowVersionId: "version-1",
      runId: "run-1",
    });
    expect(input.onInspect).not.toHaveBeenCalled();
    expect(input.onRun).not.toHaveBeenCalled();
  });
  it("shows the JSON schema and passes the actual JSON text instead of inventing a prompt field", async () => {
    const empty = record("ready");
    empty.config.runs = [];
    empty.control!.knownRunId = null;
    const input = props({ workflows: [empty] });
    await render(input);
    expect(container.textContent).toContain("输入格式（JSON）");
    expect(
      container.querySelector<HTMLTextAreaElement>("#workflow-message-input")
        ?.placeholder,
    ).toBe("按输入格式填写 JSON…");
    await type("#workflow-message-input", '{"topic":"  original  "}');
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(input.onRun).toHaveBeenCalledWith(empty, '{"topic":"  original  "}');
    expect(input.onReload).not.toHaveBeenCalled();
  });
  it("keeps legacy records read-only and does not poll or resume their running marker", async () => {
    vi.useFakeTimers();
    const old = record();
    old.control!.source = "legacy";
    old.control!.readOnlyReason = "旧版记录仅供查看";
    const input = props({ workflows: [old] });
    await render(input);
    expect(container.textContent).toContain("旧版记录仅供查看");
    expect(
      container.querySelector('[aria-label="取消当前协作流运行"]'),
    ).toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>("#workflow-message-input")!
        .disabled,
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(input.onReload).not.toHaveBeenCalled();
    expect(input.onRun).not.toHaveBeenCalled();
  });
  it("selects an explicit parallel Gate and preserves the original UTF-8 review whitespace", async () => {
    const input = props({ workflows: [record("waitingForApproval")] });
    await render(input);
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(
        '[aria-label="选择确认环节"]',
      )!;
      select.value = "gate-two";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const text = "  同意\n保持原文  ";
    await type(".workflow-gate-card textarea", text);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "批准并继续")!
        .click();
    });
    expect(input.onResolveGate).toHaveBeenCalledWith(
      input.workflows[0],
      "run-1",
      "gate-two",
      "approve",
      text,
    );
  });
  it("disables a confirmed approval while waiting for the next snapshot without fabricating node completion", async () => {
    const value = record("waitingForApproval");
    value.control!.awaitingSnapshot = true;
    const input = props({ workflows: [value] });
    await render(input);
    expect(container.textContent).toContain("请求已确认，正在同步任务状态。");
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "批准并继续",
      )!.disabled,
    ).toBe(true);
    expect(input.onResolveGate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("等待你确认");
  });
  it("keeps failed verifier evidence separate and loads only that explicit node on demand", async () => {
    const value = record("failed");
    value.config.runs![0]!.error = "control_workflow_verification_failed";
    value.config.runs![0]!.executedNodes = [
      {
        nodeId: "verify",
        nodeType: "verification",
        title: "Independent verifier",
        status: "failed",
        output: "",
        error: "control_workflow_verification_failed",
        threadId: "child-thread",
      },
    ];
    const read = vi.fn(async () => "VERDICT: FAIL\nMissing evidence");
    await render(props({ workflows: [value], onReadEvidence: read }));
    expect(read).not.toHaveBeenCalled();
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "查看验证详情")!
        .click();
    });
    expect(read).toHaveBeenCalledWith({
      workflow: value,
      executionId: "run-1",
      nodeId: "verify",
      signal: expect.any(AbortSignal),
    });
    expect(container.textContent).toContain("Missing evidence");
    expect(value.config.runs![0]!.executedNodes[0]!.output).toBe("");
  });
});
