// @vitest-environment happy-dom
// Stateful simulated bridge: these tests do not claim native browser capture.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingExport } from "@crewon/contracts/recording";
import type {
  RecordingBridge,
  RecordingState,
} from "../../lib/desktop/recordingBridge";
import { RecordingWorkspace } from "./RecordingWorkspace";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function recordingFixture(
  status: RecordingExport["status"] = "completed",
): RecordingExport {
  return {
    schemaVersion: 1,
    recordingId: "simulated-recording",
    revision: 3,
    contentDigest: `sha256:${"0".repeat(64)}`,
    scope: { ownerId: "simulated-owner", workspaceId: null },
    authorization: {
      source: "desktop-user-start",
      authorizedAt: "2026-09-14T00:00:00.000Z",
      allowedOrigins: ["https://teaching.example"],
    },
    startedAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:02.000Z",
    status,
    steps: [
      {
        stepId: "simulated-step-1",
        sequence: 1,
        kind: "select",
        occurredAt: "2026-09-14T00:00:01.000Z",
        page: {
          origin: "https://teaching.example",
          routeTemplate: "https://teaching.example/orders",
          routeDigest: `sha256:${"0".repeat(64)}`,
        },
        target: {
          tag: "select",
          selector: "main>select",
          description: "选择控件",
          role: "combobox",
          accessibleName: "地区",
        },
        input: { classification: "ordinary", value: "华东" },
        note: null,
        evidenceIds: ["simulated-evidence"],
        outcome: "observed",
        reason: null,
        relatedStepId: null,
      },
      {
        stepId: "simulated-step-2",
        sequence: 2,
        kind: "unsupported",
        occurredAt: "2026-09-14T00:00:02.000Z",
        page: {
          origin: "https://teaching.example",
          routeTemplate: "https://teaching.example/orders",
          routeDigest: `sha256:${"0".repeat(64)}`,
        },
        target: null,
        input: { classification: "runtime-required" },
        note: null,
        evidenceIds: [],
        outcome: "unknown",
        reason: "frame-content-unavailable",
        relatedStepId: null,
      },
    ],
    evidence: [
      {
        evidenceId: "simulated-evidence",
        kind: "redacted-layout",
        mediaType: "image/svg+xml",
        byteLength: 100,
        contentDigest: `sha256:${"0".repeat(64)}`,
      },
    ],
    edits: [],
  };
}

function simulatedBridge(initial: RecordingExport | null = recordingFixture()) {
  let current = initial;
  function snapshot(): RecordingState {
    return structuredClone({
      recording: current,
      pageOrigin: current ? "https://teaching.example" : null,
      error: null,
      skillImportAvailable: false,
      recordings: current
        ? [
            {
              recordingId: current.recordingId,
              status: current.status,
              startedAt: current.startedAt,
            },
          ]
        : [],
    });
  }
  function revise(expectedRevision: number) {
    if (!current || expectedRevision !== current.revision)
      throw new Error("录制版本已变化，请刷新后重试。");
    current.revision += 1;
    return current;
  }
  const bridge = {
    open: vi.fn(async () => {}),
    state: vi.fn(async () => snapshot()),
    start: vi.fn(async (_url: string) => {
      current = recordingFixture("recording");
      return snapshot();
    }),
    navigate: vi.fn(async (_url: string) => snapshot()),
    control: vi.fn(
      async (request: Parameters<RecordingBridge["control"]>[0]) => {
        if (!current || current.recordingId !== request.recordingId)
          throw new Error("录制会话已变化，请重新选择录制。");
        // Controls act on the same live session even when source capture has
        // advanced its revision since the most recent renderer state poll.
        const next = current;
        next.revision += 1;
        next.status =
          request.command === "finish"
            ? "completed"
            : request.command === "pause"
              ? "paused"
              : "recording";
        return snapshot();
      },
    ),
    edit: vi.fn(async (request: Parameters<RecordingBridge["edit"]>[0]) => {
      const next = revise(request.expectedRevision);
      if (request.operation === "delete")
        next.steps = next.steps.filter(
          (step) => step.stepId !== request.stepId,
        );
      else
        next.steps = next.steps.map((step) =>
          step.stepId === request.stepId
            ? { ...step, note: request.note }
            : step,
        );
      return snapshot();
    }),
    select: vi.fn(async (_id: string) => snapshot()),
    remove: vi.fn(async (_id: string) => {
      current = null;
      return snapshot();
    }),
    export: vi.fn(async () => ({ cancelled: false })),
    handoff: vi.fn(async () => ({
      ok: true,
      message: "录制已交给 Skill 草稿入口。",
    })),
    evidence: vi.fn(
      async (_id: string) => "data:image/svg+xml;base64,PHN2Zy8+",
    ),
    bounds: vi.fn(
      async (_bounds: Parameters<RecordingBridge["bounds"]>[0]) => {},
    ),
  } satisfies RecordingBridge;
  return { bridge, snapshot };
}

let root: Root | undefined;
let container: HTMLDivElement;
async function mount(bridge: RecordingBridge) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RecordingWorkspace bridge={bridge} />));
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent) === label,
  );
  expect(button, `Button ${label}`).toBeDefined();
  await act(async () => button!.click());
}
async function input(label: string, value: string) {
  const node = container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RecordingWorkspace simulated component coverage", () => {
  it("presents the scope, saved steps and unsupported input without implying native verification", async () => {
    const { bridge } = simulatedBridge();
    await mount(bridge);
    expect(
      container.querySelector(".recording-boundary")!.textContent,
    ).toContain("密码、令牌和 Cookie 不采集");
    expect(container.querySelector(".recording-steps")!.textContent).toContain(
      "敏感输入未采集；运行时提供",
    );
    expect(container.querySelectorAll(".recording-step")).toHaveLength(2);
    expect({
      header: container.querySelector(".recording-header")!.outerHTML,
      review: container.querySelector(".recording-steps")!.outerHTML,
      controlLabels: Array.from(
        container.querySelectorAll(".recording-toolbar button"),
        (node) => ({
          text: node.textContent,
          disabled: node.hasAttribute("disabled"),
        }),
      ),
    }).toMatchInlineSnapshot(`
      {
        "controlLabels": [
          {
            "disabled": false,
            "text": "开始录制",
          },
          {
            "disabled": true,
            "text": "暂停",
          },
          {
            "disabled": true,
            "text": "继续",
          },
          {
            "disabled": true,
            "text": "结束录制",
          },
        ],
        "header": "<header class="recording-header"><div><span class="recording-brand">CrewON</span><h1>浏览器教学</h1></div><span class="recording-status" data-status="completed" role="status">已结束</span></header>",
        "review": "<ol class="recording-steps" aria-label="录制步骤"><li class="recording-step"><div class="recording-step-heading"><strong><span class="recording-step-number">1</span>选择 / 筛选</strong><span>已观察</span></div><p class="recording-step-target">地区</p><code class="recording-selector">main&gt;select</code><p>输入：<span>华东</span></p><div class="recording-step-actions"><button type="button">定位画面</button><button type="button" aria-label="删去第 1 步">删去此步</button></div><form class="recording-note"><input aria-label="第 1 步说明" maxlength="500" placeholder="补充说明（勿填写敏感信息）" value=""><button type="submit" disabled="">保存说明</button></form></li><li class="recording-step" data-unsupported="true"><div class="recording-step-heading"><strong><span class="recording-step-number">2</span>无法采集</strong><span>结果未知</span></div><p class="recording-step-target">https://teaching.example/orders</p><p>敏感输入未采集；运行时提供</p><p class="recording-step-reason">框架内部操作无法采集。</p><div class="recording-step-actions"><button type="button" aria-label="删去第 2 步">删去此步</button></div><form class="recording-note"><input aria-label="第 2 步说明" maxlength="500" placeholder="补充说明（勿填写敏感信息）" value=""><button type="submit" disabled="">保存说明</button></form></li></ol>",
      }
    `);
  });

  it("starts only from an entered address, pauses, resumes, and finishes with the current revision", async () => {
    const { bridge } = simulatedBridge(null);
    await mount(bridge);
    await input("教学页面地址", "https://teaching.example/orders?date=today");
    await act(async () =>
      container
        .querySelector(".recording-address")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(bridge.start).toHaveBeenCalledWith(
      "https://teaching.example/orders?date=today",
    );
    expect(
      container.querySelector<HTMLInputElement>(".recording-address input")!
        .value,
    ).toBe("https://teaching.example");
    await click("暂停");
    expect(bridge.control).toHaveBeenLastCalledWith({
      command: "pause",
      recordingId: "simulated-recording",
      expectedRevision: 3,
    });
    expect(container.querySelector('[role="status"]')!.textContent).toBe(
      "已暂停",
    );
    await click("继续");
    expect(bridge.control).toHaveBeenLastCalledWith({
      command: "resume",
      recordingId: "simulated-recording",
      expectedRevision: 4,
    });
    await click("结束录制");
    expect(bridge.control).toHaveBeenLastCalledWith({
      command: "finish",
      recordingId: "simulated-recording",
      expectedRevision: 5,
    });
    expect(container.querySelector('[role="status"]')!.textContent).toBe(
      "已结束",
    );
  });

  it("preserves step identities while annotating and deleting, previews safe evidence, and exports", async () => {
    const { bridge } = simulatedBridge();
    await mount(bridge);
    await input("第 1 步说明", "筛选华东地区");
    await act(async () =>
      container
        .querySelector(".recording-note")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(bridge.edit).toHaveBeenLastCalledWith({
      stepId: "simulated-step-1",
      operation: "annotate",
      note: "筛选华东地区",
      expectedRevision: 3,
    });
    await click("定位画面");
    expect(bridge.evidence).toHaveBeenCalledWith("simulated-evidence");
    expect(
      container.querySelector(".recording-evidence img")!.getAttribute("src"),
    ).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(
      container.querySelector(".recording-evidence")!.textContent,
    ).toContain("辅助定位图");
    await click("删去第 1 步");
    expect(bridge.edit).toHaveBeenLastCalledWith({
      stepId: "simulated-step-1",
      operation: "delete",
      note: null,
      expectedRevision: 4,
    });
    expect(container.querySelector(".recording-step-number")!.textContent).toBe(
      "2",
    );
    expect(container.querySelector(".recording-evidence")).toBeNull();
    await click("导出 JSON");
    expect(bridge.export).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("录制已导出。");
    await click("删除录制");
    expect(bridge.remove).not.toHaveBeenCalled();
    await click("确认删除");
    expect(bridge.remove).toHaveBeenCalledWith("simulated-recording");
    expect(container.querySelectorAll(".recording-step")).toHaveLength(0);
  });

  it("displays mutation conflicts and export cancellation without claiming success", async () => {
    const { bridge } = simulatedBridge();
    bridge.edit.mockRejectedValueOnce(
      new Error("录制版本已变化，请刷新后重试。"),
    );
    bridge.export.mockResolvedValueOnce({ cancelled: true });
    await mount(bridge);
    await click("删去第 1 步");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      "录制版本已变化",
    );
    expect(container.querySelectorAll(".recording-step")).toHaveLength(2);
    await click("导出 JSON");
    expect(container.textContent).toContain("已取消导出。");
    expect(container.textContent).not.toContain("录制已导出。");
  });

  it("never overlaps polling and ignores a stale state response after a user mutation", async () => {
    vi.useFakeTimers();
    const { bridge, snapshot } = simulatedBridge(recordingFixture("recording"));
    await mount(bridge);
    let release!: (state: RecordingState) => void;
    bridge.state.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const stale = snapshot();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(bridge.state).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(bridge.state).toHaveBeenCalledTimes(2);
    await click("暂停");
    await act(async () => release(stale));
    expect(container.querySelector('[role="status"]')!.textContent).toBe(
      "已暂停",
    );
    expect(bridge.bounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("opens a page before explicitly resuming an interrupted recording", async () => {
    const { bridge, snapshot } = simulatedBridge(
      recordingFixture("interrupted"),
    );
    bridge.state.mockResolvedValueOnce({ ...snapshot(), pageOrigin: null });
    await mount(bridge);
    await click("继续");
    expect(bridge.control).not.toHaveBeenCalled();
    await input("教学页面地址", "https://teaching.example/orders");
    await act(async () =>
      container
        .querySelector(".recording-address")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(bridge.navigate).toHaveBeenCalledWith(
      "https://teaching.example/orders",
    );
    expect(bridge.start).not.toHaveBeenCalled();
    await click("继续");
    expect(bridge.control).toHaveBeenCalledWith({
      command: "resume",
      recordingId: "simulated-recording",
      expectedRevision: 3,
    });
  });

  it("pauses the same recording when source events advance the revision between UI polls", async () => {
    const liveRecording = recordingFixture("recording");
    const { bridge } = simulatedBridge(liveRecording);
    await mount(bridge);
    liveRecording.steps.push({
      ...liveRecording.steps[0]!,
      stepId: "simulated-step-3",
      sequence: 3,
    });
    liveRecording.revision = 5;

    await click("暂停");

    expect(bridge.control).toHaveBeenCalledWith({
      command: "pause",
      recordingId: "simulated-recording",
      expectedRevision: 3,
    });
    expect(container.querySelector('[role="status"]')!.textContent).toBe(
      "已暂停",
    );
    expect(container.querySelector(".recording-footer")!.textContent).toContain(
      "修订 6",
    );
    expect(container.querySelectorAll(".recording-step")).toHaveLength(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("distinguishes safe PNG evidence and rejects unsupported image URIs", async () => {
    const { bridge } = simulatedBridge();
    bridge.evidence
      .mockResolvedValueOnce("data:image/png;base64,iVBORw0KGgo=")
      .mockResolvedValueOnce("https://untrusted.example/image.png");
    await mount(bridge);
    await click("定位画面");
    expect(
      container.querySelector(".recording-evidence")!.textContent,
    ).toContain("控件截图");
    expect(container.querySelector("img")!.src).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    await click("收起");
    await click("定位画面");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      "定位画面的格式不受支持。",
    );
    expect(container.querySelector(".recording-evidence")).toBeNull();
  });

  it("offers Skill handoff only with an available authenticated import entry and reports its result", async () => {
    const { bridge, snapshot } = simulatedBridge();
    await mount(bridge);
    await click("生成 Skill 草稿");
    expect(bridge.handoff).not.toHaveBeenCalled();
    bridge.state.mockResolvedValue({
      ...snapshot(),
      skillImportAvailable: true,
    });
    await act(async () => root!.unmount());
    container.remove();
    await mount(bridge);
    await click("生成 Skill 草稿");
    expect(bridge.handoff).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("录制已交给 Skill 草稿入口。");
    bridge.handoff.mockResolvedValueOnce({
      ok: false,
      message: "导入入口已断开，请重新连接。",
    });
    await click("生成 Skill 草稿");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      "导入入口已断开，请重新连接。",
    );
  });
});
