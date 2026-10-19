// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  installedModuleTaskFixture,
  clickModuleTask,
  moduleTaskUntil,
  MODULE_TASK_OPERATION,
  settleModuleTask,
} from "./InstalledPluginModuleTaskContext.test-support";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const fixtures: Awaited<ReturnType<typeof installedModuleTaskFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  document.body.replaceChildren();
});
async function fixture() {
  const value = await installedModuleTaskFixture();
  fixtures.push(value);
  return value;
}

const packageConfigured =
  (
    globalThis as unknown as {
      process: { env: Record<string, string | undefined> };
    }
  ).process.env.CREWON_TEST_KREA_PLUGIN_DIR !== undefined;

// The ordinary UI suite has no producer. The explicit package command always supplies this fixture;
// an explicitly configured missing, empty or corrupt directory remains a hard failure.
describe.runIf(packageConfigured)(
  "actual external Krea UI → original Control task/runtime (named HTTP responses, no real payer/provider)",
  () => {
    it("requires an explicit Thread action, observes actual revision, queries the original operation twice, and follows the original resumable SSE", async () => {
      const f = await fixture();
      await f.render(true);
      await moduleTaskUntil(() => {
        expect(f.diagnostics).toEqual([]);
        expect(
          f.container.querySelector(
            '[data-independent-plugin-version="1.0.0"]',
          ),
        ).not.toBeNull();
      });
      expect(
        f.requests.filter(
          (request) =>
            request.method === "POST" && request.path === "/api/v1/threads",
        ),
      ).toHaveLength(0);
      expect(f.actionRequests()).toHaveLength(0);
      expect(
        f.container.querySelector<HTMLButtonElement>(
          '[data-action="image.generate"]',
        )!.disabled,
      ).toBe(true);
      await clickModuleTask(f.container, "创建任务");
      await moduleTaskUntil(() =>
        expect(
          f.container.querySelector<HTMLButtonElement>(
            '[data-action="image.generate"]',
          )!.disabled,
        ).toBe(false),
      );
      const prompt = f.container.querySelector<HTMLTextAreaElement>(
        '[aria-label="画面描述"]',
      )!;
      prompt.value = "Named UI path: a rainy city";
      await clickModuleTask(f.container, "创建生图任务");
      await moduleTaskUntil(() =>
        expect(f.runStreams.get("run-1")).toHaveLength(1),
      );
      expect(f.actionRequests()[0]!.body).toEqual({
        action: "image.generate",
        input: {
          threadId: "thread-1",
          expectedThreadRevision: 1,
          idempotencyKey: expect.any(String),
          input: { prompt: prompt.value },
        },
      });
      expect(f.receipts.snapshot()).toHaveLength(1);
      expect(
        f.requests.some(
          (request) =>
            request.path ===
            "/api/v1/extensions/crewon.comfyui-krea2/tasks/run-1",
        ),
      ).toBe(true);
      expect(f.callbacks.onThread).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "thread-1",
          turns: [expect.objectContaining({ id: "run-1" })],
        }),
      );
      const first = f.runStreams.get("run-1")![0]!;
      await act(async () => {
        first.send(
          f.event("run-1", 1, "run.created", { threadId: "thread-1" }),
        );
        first.send(f.event("run-1", 2, "run.started", {}));
        first.send(
          f.event("run-1", 3, "segment.started", {
            segmentId: "segment-1",
            attempt: 1,
          }),
        );
        first.send(
          f.event("run-1", 4, "model.output.delta", {
            segmentId: "segment-1",
            delta: "Actual SSE decoder",
          }),
        );
        await settleModuleTask();
      });
      await moduleTaskUntil(() =>
        expect(f.callbacks.onTextDelta).toHaveBeenCalledWith(
          "thread-1",
          "Actual SSE decoder",
        ),
      );
      f.runs.set("run-1", {
        ...f.runs.get("run-1")!,
        revision: 4,
        lastSequence: 4,
      });
      first.finish();
      await moduleTaskUntil(() =>
        expect(f.runStreams.get("run-1")).toHaveLength(2),
      );
      const streamRequests = f.requests.filter((request) =>
        request.path.startsWith("/api/v1/runs/run-1/events"),
      );
      expect(
        streamRequests.map((request) => request.headers.get("last-event-id")),
      ).toEqual([null, "4"]);
      await act(async () => {
        f.runStreams.get("run-1")![1]!.send(
          f.event("run-1", 4, "model.output.delta", {
            segmentId: "segment-1",
            delta: "Actual SSE decoder",
          }),
        );
        await settleModuleTask();
      });
      expect(f.callbacks.onTextDelta.mock.calls).toEqual([
        ["thread-1", "Actual SSE decoder"],
      ]);
      expect(f.callbacks.onStreamError).not.toHaveBeenCalled();
      await moduleTaskUntil(() =>
        expect(
          f.container.querySelector('[aria-label="查询生成记录"]'),
        ).not.toBeNull(),
      );
      await act(async () => {
        const source = f.container.querySelector<HTMLSelectElement>(
          '[aria-label="查询生成记录"]',
        )!;
        source.value = JSON.stringify(["run-1", MODULE_TASK_OPERATION]);
        source.dispatchEvent(new Event("change", { bubbles: true }));
        await settleModuleTask();
      });
      await clickModuleTask(f.container, "查询原生成结果");
      await moduleTaskUntil(() => expect(f.actionRequests()).toHaveLength(2));
      await moduleTaskUntil(() =>
        expect(
          f.container.querySelector<HTMLButtonElement>(
            '[data-action="image.query"]',
          )!.disabled,
        ).toBe(false),
      );
      await clickModuleTask(f.container, "查询原生成结果");
      await moduleTaskUntil(() => expect(f.actionRequests()).toHaveLength(3));
      for (const request of f.actionRequests().slice(1))
        expect(request.body).toMatchObject({
          action: "image.query",
          input: { sourceRunId: "run-1", operationId: MODULE_TASK_OPERATION },
        });
      expect(
        f
          .actionRequests()
          .map(
            (request) =>
              (request.body!.input as { expectedThreadRevision: number })
                .expectedThreadRevision,
          ),
      ).toEqual([1, 2, 3]);
      const keys = f
        .actionRequests()
        .map(
          (request) =>
            (request.body!.input as { idempotencyKey: string }).idempotencyKey,
        );
      expect(new Set(keys).size).toBe(3);
      expect(f.container.textContent).toContain("krea.png");
      expect(
        f.requests.some((request) => request.path.includes("/turns")),
      ).toBe(false);
      expect(
        f.requests.every(
          (request) =>
            request.headers.get("authorization") ===
            "Bearer named-module-user-session",
        ),
      ).toBe(true);
      expect(f.diagnostics).toEqual([]);
    });

    it("keeps a same-account late committed task after navigation, then reopens and verifies it before actual runtime adoption", async () => {
      const f = await fixture();
      await f.render(true);
      await moduleTaskUntil(() => {
        expect(f.diagnostics).toEqual([]);
        expect(
          f.container.querySelector<HTMLButtonElement>(
            '[data-action="image.generate"]',
          ),
        ).not.toBeNull();
      });
      await clickModuleTask(f.container, "创建任务");
      await moduleTaskUntil(() =>
        expect(
          f.container.querySelector<HTMLButtonElement>(
            '[data-action="image.generate"]',
          )!.disabled,
        ).toBe(false),
      );
      const gate = f.gateAction();
      await clickModuleTask(f.container, "创建生图任务");
      expect(f.actionRequests()).toHaveLength(1);
      await f.render(false);
      expect(f.container.textContent).toBe("");
      expect(f.actionRequests()[0]!.signal?.aborted).toBe(false);
      expect(f.receipts.snapshot()).toHaveLength(0);
      gate.resolve();
      await act(settleModuleTask);
      await moduleTaskUntil(() =>
        expect(f.receipts.snapshot()).toHaveLength(1),
      );
      expect(f.callbacks.onThread).not.toHaveBeenCalled();
      await f.render(true, "thread-1");
      await moduleTaskUntil(() =>
        expect(f.callbacks.onThread).toHaveBeenCalledWith(
          expect.objectContaining({ id: "thread-1" }),
        ),
      );
      expect(f.actionRequests()).toHaveLength(1);
      expect(
        f.requests.filter(
          (request) =>
            request.method === "POST" && request.path === "/api/v1/threads",
        ),
      ).toHaveLength(1);
      expect(
        f.container.querySelector('[aria-label="已受理任务"]'),
      ).not.toBeNull();
      expect(f.container.textContent).toContain("任务 1 · 执行中");
      expect(f.diagnostics).toEqual([]);
    });
  },
);
