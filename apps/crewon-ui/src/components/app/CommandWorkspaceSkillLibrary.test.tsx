// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillVersion } from "@crewon/domain/demonstrated-skill";
import type {
  DemonstratedSkillDetail,
  SkillExecutionInput,
} from "../../lib/skill/demonstratedSkillClient";
import {
  SkillLibraryHost,
  type SkillLibraryControlClient,
} from "../skill/SkillLibraryHost";
import { CommandWorkspace } from "./CommandWorkspace";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";
import * as platformClient from "../../lib/agent-platform/agentPlatformClient";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const version: SkillVersion = {
  schemaVersion: "crewon.skill-version.v1",
  ref: {
    skillId: "skill-1",
    versionId: "version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
  },
  method: {
    name: "销售汇总",
    purpose: "汇总指定日期销售额",
    steps: ["打开销售报表", "按日期筛选并汇总"],
    parameters: [
      { name: "date", label: "日期", type: "string", required: true },
    ],
    requiredToolRefs: ["browser"],
    completionCriteria: ["总额与来源一致"],
    knownExceptions: ["无数据时说明"],
    runtimeRequirements: [],
  },
  source: {
    recordingId: "recording-1",
    revision: 1,
    contentDigest: `sha256:${"b".repeat(64)}`,
    provenance: "recording",
  },
  createdAt: "2026-09-14T00:00:00Z",
  markdown: "# 销售汇总",
};

describe("Skill library host integration", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: DemonstratedSkillDetail;
  let control: SkillLibraryControlClient;
  let posts: SkillExecutionInput[];
  let dropNextPost: boolean;
  const onSelectThread = vi.fn();
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    posts = [];
    dropNextPost = false;
    onSelectThread.mockReset();
    current = {
      skill: {
        skillId: "skill-1",
        revision: 2,
        draft: version.method,
        source: version.source,
        disabled: false,
        deleted: false,
        activatedVersionIds: [],
      },
      versions: [version],
      executions: [],
    };
    control = {
      requestSkill: vi.fn(async (path, init) => {
        if (
          path === "/api/v1/skills/skill-1/generations" &&
          init?.method === "GET"
        )
          return Response.json({ generations: [] });
        if (path.startsWith("/api/v1/skills?") || path === "/api/v1/skills")
          return Response.json({ skills: [current.skill] });
        if (path === "/api/v1/skills/skill-1" && init?.method === "GET")
          return Response.json(current);
        if (
          path === "/api/v1/skills/skill-1/executions" &&
          init?.method === "POST"
        ) {
          const input = JSON.parse(String(init.body)) as SkillExecutionInput;
          posts.push(input);
          if (dropNextPost) {
            dropNextPost = false;
            throw new Error("connection_closed_before_ack");
          }
          current.executions = [
            {
              executionId: input.executionId,
              invocation: input.invocation,
              purpose: input.purpose,
              runId: "run-1",
              status: "queued",
              verification: "unknown",
              review: null,
              createdAt: "2026-09-14T00:00:00Z",
            },
          ];
          return Response.json(current.executions[0]);
        }
        throw new Error(`Unexpected test request: ${path}`);
      }),
      createThread: vi.fn(async () => ({
        thread: { threadId: "real-thread-1", revision: 1 },
      })),
      getThread: vi.fn(async () => ({
        thread: { threadId: "real-thread-1", revision: 4, status: "active" },
      })),
      getRun: vi.fn(async () => ({
        run: { runId: "run-1", threadId: "real-thread-1" },
      })),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "crewonDesktop");
  });
  async function render(selectedThreadId: string | null = null) {
    await act(async () =>
      root.render(
        <SkillLibraryHost
          controlClient={control}
          selectedThreadId={selectedThreadId}
          selectedThreadTitle={selectedThreadId ? "订单交付任务" : undefined}
          onSelectThread={onSelectThread}
        />,
      ),
    );
  }
  function button(label: string) {
    const found = [...container.querySelectorAll("button")].find(
      (node) =>
        node.textContent === label || node.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  async function prepareTrial(selectedThreadId: string | null = null) {
    await render(selectedThreadId);
    await click("打开示教 Skill：销售汇总");
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="试跑参数：日期"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "2026-09-21");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("removes all prior account Skill data when the next account list fails", async () => {
    await render();
    expect(container.textContent).toContain("销售汇总");
    const nextControl = {
      ...control,
      requestSkill: vi.fn(async () => {
        throw new Error("account_b_unavailable");
      }),
    };
    await act(async () =>
      root.render(<SkillLibraryHost controlClient={nextControl} />),
    );
    expect(container.textContent).not.toContain("销售汇总");
    expect(container.textContent).not.toContain("汇总指定日期销售额");
    expect(container.textContent).toContain("暂时无法读取示教 Skill");
    expect(
      container.querySelector(".demonstrated-skill-library-card"),
    ).toBeNull();
  });

  it("does not continue an old account thread preparation into a Skill execution after switching accounts", async () => {
    let resolve!: (value: {
      thread: { threadId: string; revision: number };
    }) => void;
    control.createThread = vi.fn(
      () =>
        new Promise<{ thread: { threadId: string; revision: number } }>(
          (done) => {
            resolve = done;
          },
        ),
    );
    await prepareTrial();
    await click("开始试跑");
    const nextControl = {
      ...control,
      requestSkill: vi.fn(async () => Response.json({ skills: [] })),
    };
    await act(async () =>
      root.render(<SkillLibraryHost controlClient={nextControl} />),
    );
    await act(async () =>
      resolve({ thread: { threadId: "real-thread-1", revision: 1 } }),
    );
    expect(control.getThread).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(
      nextControl.requestSkill.mock.calls.every(
        (call) =>
          (call as unknown as [string, RequestInit])[1]?.method !== "POST",
      ),
    ).toBe(true);
  });

  it("does not open an old account Run after its delayed lookup resolves in another account", async () => {
    await prepareTrial();
    await click("开始试跑");
    let resolve!: (value: { run: { runId: string; threadId: string } }) => void;
    control.getRun = vi.fn(
      () =>
        new Promise<{ run: { runId: string; threadId: string } }>((done) => {
          resolve = done;
        }),
    );
    await click("查看运行结果");
    const nextControl = {
      ...control,
      requestSkill: vi.fn(async () => Response.json({ skills: [] })),
    };
    await act(async () =>
      root.render(
        <SkillLibraryHost
          controlClient={nextControl}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    await act(async () =>
      resolve({ run: { runId: "run-1", threadId: "old-private-thread" } }),
    );
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("opens an imported Skill by authoritative id even when it is outside the current catalog page or search", async () => {
    const onOpenRequestHandled = vi.fn();
    const requestSkill = control.requestSkill;
    control.requestSkill = vi.fn((path, init) =>
      path.startsWith("/api/v1/skills?")
        ? Promise.resolve(Response.json({ skills: [] }))
        : requestSkill(path, init),
    );
    await act(async () =>
      root.render(
        <SkillLibraryHost
          controlClient={control}
          query="unrelated search"
          openRequest={{ requestId: "import-1", skillId: "skill-1" }}
          onOpenRequestHandled={onOpenRequestHandled}
        />,
      ),
    );
    expect(
      container.querySelector('[aria-label="试跑参数：日期"]'),
    ).not.toBeNull();
    expect(onOpenRequestHandled).toHaveBeenCalledWith("import-1");
    expect(control.createThread).not.toHaveBeenCalled();
  });

  it("routes the main workspace to an imported Skill and clears incompatible catalog filters", async () => {
    const snapshot = vi
      .spyOn(platformClient, "readAgentPlatformSnapshot")
      .mockResolvedValue(emptyAgentPlatformSnapshot);
    const onOpenRequestHandled = vi.fn();
    const originalUrl = window.location.href;
    window.history.replaceState(null, "", "#view-agents");
    function workspace(open = false) {
      return (
        <CommandWorkspace
          composerValue=""
          connectionState="disconnected"
          cwd=""
          isSending={false}
          workMode="code"
          workspaceAuthority="control"
          skillControlClient={control}
          skillOpenRequest={
            open ? { requestId: "handoff-main", skillId: "skill-1" } : null
          }
          onSkillOpenRequestHandled={onOpenRequestHandled}
          onAttachContext={() => {}}
          onChangeComposerValue={() => {}}
          onModeChange={() => {}}
          onRetryConnection={() => {}}
          onSend={() => {}}
        />
      );
    }
    try {
      await act(async () => root.render(workspace()));
      const cloud = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".catalog-location-filter button",
        ),
      ].find((item) => item.textContent === "云端")!;
      await act(async () => cloud.click());
      expect(container.querySelector(".demonstrated-skill-library")).toBeNull();
      await act(async () => root.render(workspace(true)));
      expect(window.location.hash).toBe("#view-agents");
      expect(
        container.querySelector('[aria-label="试跑参数：日期"]'),
      ).not.toBeNull();
      expect(onOpenRequestHandled).toHaveBeenCalledWith("handoff-main");
      const local = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".catalog-location-filter button",
        ),
      ].find((item) => item.textContent === "本地")!;
      expect(local.getAttribute("aria-pressed")).toBe("true");
      expect(control.createThread).not.toHaveBeenCalled();
    } finally {
      snapshot.mockRestore();
      window.history.replaceState(null, "", originalUrl);
    }
  });

  it("loads the production list and creates an actual thread only when a valid trial is submitted", async () => {
    await prepareTrial();
    expect(control.createThread).not.toHaveBeenCalled();
    await click("开始试跑");
    expect(control.requestSkill).toHaveBeenCalledWith(
      "/api/v1/skills?limit=50",
      expect.objectContaining({ method: "GET" }),
    );
    expect(control.createThread).toHaveBeenCalledWith(
      { title: "Skill · 销售汇总" },
      `skill-thread:${posts[0].executionId}`,
    );
    expect(control.getThread).toHaveBeenCalledWith("real-thread-1");
    expect(posts[0]).toMatchObject({
      threadId: "real-thread-1",
      expectedThreadRevision: 4,
      agentVersionId: null,
      purpose: "trial",
      invocation: { skill: version.ref, parameters: { date: "2026-09-21" } },
    });
    expect(container.textContent).toContain("排队中");
    expect(container.textContent).toContain("真实性待验证");
  });

  function deliveryCatalog(threadId: string) {
    return {
      target: {
        schemaVersion: "crewon.delivery-target.v1" as const,
        tenantId: "tenant-1",
        spaceId: "space-1",
        threadId,
        targetId: "thread-deliveries" as const,
      },
      inputs: [],
      deliveries: [],
    };
  }

  function requireDelivery() {
    current.versions = [
      {
        ...version,
        method: {
          ...version.method,
          requiredToolRefs: ["delivery_catalog", "delivery_assemble"],
        },
      },
    ];
  }

  it("uses the selected task and its authoritative delivery target so previously uploaded files remain available", async () => {
    requireDelivery();
    control.delivery = { catalog: vi.fn(async (id) => deliveryCatalog(id)) };
    await prepareTrial("real-thread-1");
    expect(
      container.querySelector('[aria-label="执行任务"]')?.outerHTML,
    ).toMatchSnapshot();
    await click("打开执行任务");
    expect(onSelectThread).toHaveBeenCalledWith("real-thread-1");
    await click("开始试跑");
    expect(control.createThread).not.toHaveBeenCalled();
    expect(control.delivery.catalog).toHaveBeenCalledExactlyOnceWith(
      "real-thread-1",
    );
    expect(posts[0]).toMatchObject({
      threadId: "real-thread-1",
      expectedThreadRevision: 4,
      invocation: { deliveryTarget: deliveryCatalog("real-thread-1").target },
    });
  });

  it("keeps a pending task destination and file target frozen when the current task changes", async () => {
    requireDelivery();
    control.delivery = { catalog: vi.fn(async (id) => deliveryCatalog(id)) };
    dropNextPost = true;
    await prepareTrial("real-thread-1");
    await click("开始试跑");
    await render("different-thread");
    expect(container.textContent).toContain("原执行任务：real-thread-1");
    await click("重试原试跑");
    expect(posts[1]).toEqual(posts[0]);
    expect(control.delivery.catalog).toHaveBeenCalledTimes(1);
    expect(control.getThread).toHaveBeenCalledTimes(1);
  });

  it("keeps the original task on a preparation retry after its catalog response is lost", async () => {
    requireDelivery();
    control.delivery = { catalog: vi.fn(async (id) => deliveryCatalog(id)) };
    vi.mocked(control.delivery.catalog).mockRejectedValueOnce(
      new TypeError("lost_catalog_response"),
    );
    await prepareTrial("real-thread-1");
    await click("开始试跑");
    await render("different-thread");
    await click("重试原试跑");
    expect(control.getThread).toHaveBeenNthCalledWith(2, "real-thread-1");
    expect(posts[0].threadId).toBe("real-thread-1");
  });

  it("rejects a delivery catalog for a different task before submitting a Run", async () => {
    requireDelivery();
    control.delivery = {
      catalog: vi.fn(async () => deliveryCatalog("different-thread")),
    };
    await prepareTrial("real-thread-1");
    await click("开始试跑");
    expect(posts).toEqual([]);
    expect(container.textContent).toContain("执行任务的文件交付尚未准备好");
  });

  it("does not require the file service for a browser-only Skill in the selected task", async () => {
    await prepareTrial("real-thread-1");
    await click("开始试跑");
    expect(control.createThread).not.toHaveBeenCalled();
    expect(posts[0].threadId).toBe("real-thread-1");
    expect(posts[0].invocation).not.toHaveProperty("deliveryTarget");
  });

  it("keeps model draft generation in a separate task from the chosen input files", async () => {
    await prepareTrial("current-file-task");
    await click("让模型整理草稿");
    expect(control.createThread).toHaveBeenCalledTimes(1);
    expect(control.getThread).toHaveBeenCalledWith("real-thread-1");
    expect(posts).toEqual([]);
  });

  it("does not dispatch the old account's task after its delivery catalog resolves", async () => {
    requireDelivery();
    let resolve!: (value: ReturnType<typeof deliveryCatalog>) => void;
    control.delivery = {
      catalog: vi.fn(
        () =>
          new Promise<ReturnType<typeof deliveryCatalog>>((done) => {
            resolve = done;
          }),
      ),
    };
    await prepareTrial("real-thread-1");
    await click("开始试跑");
    const nextControl = {
      ...control,
      requestSkill: vi.fn(async () => Response.json({ skills: [] })),
    };
    await act(async () =>
      root.render(
        <SkillLibraryHost
          controlClient={nextControl}
          selectedThreadId="new-account-task"
        />,
      ),
    );
    await act(async () => resolve(deliveryCatalog("real-thread-1")));
    expect(posts).toEqual([]);
  });

  it("keeps new task creation available as an explicit destination", async () => {
    await prepareTrial("other-current-task");
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="执行任务"]',
    )!;
    await act(async () => {
      select.value = "new";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("开始试跑");
    expect(control.createThread).toHaveBeenCalledTimes(1);
    expect(posts[0].threadId).toBe("real-thread-1");
  });

  it("retries an uncertain execution response with the exact same thread, revision, parameters and execution ID", async () => {
    dropNextPost = true;
    await prepareTrial();
    await click("开始试跑");
    expect(container.textContent).toContain("本次提交状态待确认");
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="试跑参数：日期"]',
      )!.disabled,
    ).toBe(true);
    await click("重试原试跑");
    expect(control.createThread).toHaveBeenCalledTimes(1);
    expect(control.getThread).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(container.textContent).not.toContain("本次提交状态待确认");
    await click("开始试跑");
    expect(posts[2].executionId).not.toBe(posts[0].executionId);
    expect(control.createThread).toHaveBeenCalledTimes(2);
  });

  it("reuses the deterministic thread creation key when preparation loses its response", async () => {
    vi.mocked(control.createThread).mockRejectedValueOnce(
      new Error("lost_thread_response"),
    );
    await prepareTrial();
    await click("开始试跑");
    await click("重试原试跑");
    const calls = vi.mocked(control.createThread).mock.calls;
    expect(calls[1]).toEqual(calls[0]);
    expect(posts).toHaveLength(1);
    expect(calls[0][1]).toBe(`skill-thread:${posts[0].executionId}`);
  });

  it("keeps an uncertain command when the user leaves and reopens the Skill", async () => {
    dropNextPost = true;
    await prepareTrial();
    await click("开始试跑");
    await click("返回示教 Skill 列表");
    await click("打开示教 Skill：销售汇总");
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="试跑参数：日期"]',
      )!.value,
    ).toBe("2026-09-21");
    await click("重试原试跑");
    expect(posts[1]).toEqual(posts[0]);
    expect(control.createThread).toHaveBeenCalledTimes(1);
  });

  it("opens the authoritative thread read from the selected Run, not a guessed local thread", async () => {
    await prepareTrial();
    await click("开始试跑");
    await click("查看运行结果");
    expect(control.getRun).toHaveBeenCalledWith("run-1");
    expect(onSelectThread).toHaveBeenCalledWith("real-thread-1");
  });

  it("does not send a trial if the created thread cannot be verified as active", async () => {
    vi.mocked(control.getThread).mockResolvedValueOnce({
      thread: { threadId: "wrong-thread", revision: 4, status: "active" },
    });
    await prepareTrial();
    await click("开始试跑");
    expect(posts).toEqual([]);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("prepares a real task before browser review and only authorizes after an explicit click", async () => {
    current.versions = [
      {
        ...version,
        method: {
          ...version.method,
          requiredToolRefs: ["crewon_browser_act"],
        },
      },
    ];
    const bridge = {
      status: vi.fn(async () => null),
      authorize: vi.fn(async () => ({
        threadId: "real-thread-1",
        sessionId: "browser-session",
        revision: 1,
        mode: "perAction" as const,
      })),
      revoke: vi.fn(async () => {}),
    };
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: { browserExecution: bridge },
    });
    await prepareTrial();
    await click("开始试跑");
    expect(control.createThread).toHaveBeenCalledOnce();
    expect(posts).toEqual([]);
    expect(bridge.status).toHaveBeenCalledWith("real-thread-1");
    expect(bridge.authorize).not.toHaveBeenCalled();
    expect(container.textContent).toContain("本次授权方式：逐次确认");
    await click("允许此任务使用浏览器");
    expect(bridge.authorize).toHaveBeenCalledExactlyOnceWith({
      threadId: "real-thread-1",
    });
    expect(posts[0].invocation.requiredToolRefs).toEqual([
      "crewon_browser_act",
    ]);
  });

  it("does not start a scope-only Skill before the required browser scope is configured", async () => {
    current.versions = [
      {
        ...version,
        method: {
          ...version.method,
          requiredToolRefs: ["crewon_browser_act_scoped"],
        },
      },
    ];
    const bridge = {
      status: vi.fn(async () => null),
      authorize: vi.fn(),
      revoke: vi.fn(async () => {}),
    };
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: { browserExecution: bridge },
    });
    await prepareTrial();
    await click("开始试跑");
    expect(container.textContent).toContain("此技能需要限定范围授权");
    expect(container.textContent).not.toContain("按逐次确认开始试跑");
    expect(button("允许此任务使用浏览器").disabled).toBe(true);
    expect(bridge.authorize).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
});
