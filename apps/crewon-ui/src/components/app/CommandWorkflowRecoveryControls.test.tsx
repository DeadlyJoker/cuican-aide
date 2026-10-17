// @vitest-environment happy-dom
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandWorkflowRecoveryControls } from "./CommandWorkflowRecoveryControls";
import { ControlWorkflowIntentJournal } from "../../lib/control-runtime/controlWorkflowIntentJournal";
import { workflowIntentMemoryStorage } from "../../lib/control-runtime/controlWorkflowCommands.test-support";
import type { CrewonWorkflowRecord } from "../../lib/workflow/crewonWorkflow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type State = ComponentProps<typeof CommandWorkflowRecoveryControls>["state"];
const result: CrewonWorkflowRecord = {
  filePath: "control:workflow-version:version-1",
  savedAt: "2026-10-18T00:00:00.000Z",
  config: {
    workflowId: "version-1",
    name: "Release review",
    description: "Review",
    lead: "producer",
    status: "ready",
    resourceSource: "crewon",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
  },
  control: {
    source: "durable",
    workflowVersionId: "version-1",
    loaded: true,
    readOnlyReason: null,
    inputMode: "prompt",
    inputSchema: null,
    knownRunId: null,
  },
};
function fixture() {
  const storage = workflowIntentMemoryStorage();
  const journal = new ControlWorkflowIntentJournal({
    storage: () => storage,
    nextId: () => "original-intent",
    now: () => "2026-10-18T00:00:00.000Z",
  });
  const original = journal.create({
    contextId: `sha256:${"a".repeat(64)}`,
    workflowVersionId: "version-1",
    threadId: "thread-1",
    command: {
      kind: "review",
      locator: { runId: "root-1", nodeId: "gate", gateRequestId: "request-1" },
      body: {
        inputDigest: `sha256:${"b".repeat(64)}`,
        decision: "approved",
        comment: "  原意见  ",
        commentContext: "descendants-v1",
      },
    },
  });
  const state: State = {
    records: [result],
    pending: [original],
    busy: false,
    mode: "catalog",
    notice: null,
    previous: [],
    nextCursor: null,
    browse: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    previousPage: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    recover: vi.fn(async () => result),
  };
  return { state, original };
}
let root: Root, container: HTMLDivElement;
async function render(state: State, open = vi.fn()) {
  await act(async () => {
    root.render(
      <StrictMode>
        <CommandWorkflowRecoveryControls
          state={state}
          room={false}
          onOpen={open}
        />
      </StrictMode>,
    );
  });
  return open;
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Workflow explicit recovery controls", () => {
  it("renders the bounded recovery list without replaying and preserves its visual structure", async () => {
    const { state } = fixture();
    await render(state);
    expect(state.recover).not.toHaveBeenCalled();
    expect(container.textContent).toContain("有 1 个请求尚未确认结果");
    expect(container.innerHTML).toMatchSnapshot();
  });
  it("recovers only the clicked immutable record and opens its definition", async () => {
    const { state, original } = fixture(),
      open = await render(state);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="恢复原请求 original-intent"]',
        )!
        .click();
    });
    expect(state.recover).toHaveBeenCalledWith(original);
    expect(state.recover).toHaveBeenCalledTimes(1);
    expect(
      original.command.kind === "review" &&
        original.command.body.commentContext,
    ).toBe("descendants-v1");
    expect(open).toHaveBeenCalledWith("version-1");
  });
  it("keeps the original record and explains a changed context without opening or replacing the task", async () => {
    const { state, original } = fixture();
    state.recover = vi.fn(async () => {
      throw Error("workflow_recovery_context_changed");
    });
    const open = await render(state);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="恢复原请求 original-intent"]',
        )!
        .click();
    });
    expect(container.textContent).toContain("当前身份或执行配置已变化");
    expect(state.pending).toEqual([original]);
    expect(open).not.toHaveBeenCalled();
  });
});
