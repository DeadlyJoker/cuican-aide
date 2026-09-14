// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SkillInvocationSpec,
  SkillMethod,
  SkillVersion,
} from "@crewon/domain/demonstrated-skill";
import type {
  DemonstratedSkillClient,
  DemonstratedSkillDetail,
  SkillExecutionAttempt,
  SkillExecutionInput,
} from "../../lib/skill/demonstratedSkillClient";
import { DemonstratedSkillPanel } from "./DemonstratedSkillPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const method: SkillMethod = {
  name: "每周销售汇总",
  purpose: "汇总指定日期的销售数据",
  steps: ["选择日期", "导出并核对销售数据"],
  parameters: [
    { name: "date", label: "报表日期", type: "string", required: true },
  ],
  requiredToolRefs: ["browser"],
  completionCriteria: ["总额与来源一致"],
  knownExceptions: ["无数据时说明原因"],
  runtimeRequirements: ["登录销售系统"],
};
const version: SkillVersion = {
  schemaVersion: "crewon.skill-version.v1",
  ref: {
    skillId: "skill-1",
    versionId: "v1",
    contentDigest: `sha256:${"a".repeat(64)}`,
  },
  method,
  markdown: "# 每周销售汇总",
  createdAt: "2026-09-14T00:00:00Z",
  source: {
    recordingId: "rec-1",
    revision: 1,
    contentDigest: `sha256:${"b".repeat(64)}`,
    provenance: "recording",
  },
};
const invocation = {
  schemaVersion: "crewon.skill-invocation.v1" as const,
  skill: version.ref,
  parameters: { date: "2026-09-21" },
  requiredToolRefs: ["browser"],
};
function detail(): DemonstratedSkillDetail {
  return {
    skill: {
      skillId: "skill-1",
      revision: 3,
      draft: method,
      source: version.source,
      disabled: false,
      deleted: false,
      activatedVersionIds: [],
    },
    versions: [version],
    executions: [],
  };
}

describe("DemonstratedSkillPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: DemonstratedSkillDetail;
  let client: DemonstratedSkillClient;
  const onAddToSchedule = vi.fn();
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    current = detail();
    onAddToSchedule.mockReset();
    client = {
      list: vi.fn(async () => [current.skill]),
      listGenerations: vi.fn(async () => []),
      readGeneration: vi.fn(),
      startGeneration: vi.fn(),
      collectGeneration: vi.fn(),
      applyGeneration: vi.fn(),
      read: vi.fn(async () => structuredClone(current)),
      saveDraft: vi.fn(async () => {}),
      createVersion: vi.fn(async () => {}),
      startExecution: vi.fn(async () => {}),
      reviewExecution: vi.fn(async () => {}),
      activate: vi.fn(async () => {}),
      setDisabled: vi.fn(async () => {}),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render(
    deliveryTarget?: SkillInvocationSpec["deliveryTarget"],
  ) {
    await act(async () =>
      root.render(
        <DemonstratedSkillPanel
          skillId="skill-1"
          client={client}
          executionTarget={{
            threadId: "thread-1",
            expectedThreadRevision: 9,
            agentVersionId: "agent-v2",
          }}
          deliveryTarget={deliveryTarget}
          onAddToSchedule={onAddToSchedule}
        />,
      ),
    );
  }
  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  async function fill(label: string, value: string) {
    const node = container.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(`[aria-label="${label}"]`)!;
    await act(async () => {
      const prototype =
        node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        node,
        value,
      );
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function chooseApproveForMe() {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="本次任务工具审批"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        ),
    );
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-value="approveForMe"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
    );
  }

  it("snapshots purpose, method, variables, dependencies, criteria and exceptions without pretending a trial passed", async () => {
    await render();
    expect(container.textContent).toContain("待试跑");
    expect(container.textContent).toContain("已保存版本保持不变");
    expect(button("确认激活").disabled).toBe(true);
    expect(container.innerHTML).toMatchSnapshot();
  });

  it.each(["unmount", "replace-client"] as const)(
    "does not submit a prepared trial after %s",
    async (change) => {
      let resolve!: (value: {
        threadId: string;
        expectedThreadRevision: number;
        agentVersionId: null;
      }) => void;
      const prepareExecutionTarget = vi.fn(
        () =>
          new Promise<{
            threadId: string;
            expectedThreadRevision: number;
            agentVersionId: null;
          }>((done) => {
            resolve = done;
          }),
      );
      await act(async () =>
        root.render(
          <DemonstratedSkillPanel
            skillId="skill-1"
            client={client}
            executionTarget={null}
            prepareExecutionTarget={prepareExecutionTarget}
          />,
        ),
      );
      await fill("试跑参数：报表日期", "2026-09-21");
      await click("开始试跑");
      const nextClient = {
        ...client,
        read: vi.fn(async () => {
          throw new Error("new_account_offline");
        }),
        startExecution: vi.fn(),
      };
      await act(async () =>
        root.render(
          change === "unmount" ? null : (
            <DemonstratedSkillPanel
              skillId="skill-1"
              client={nextClient}
              executionTarget={null}
            />
          ),
        ),
      );
      await act(async () =>
        resolve({
          threadId: "old-thread",
          expectedThreadRevision: 9,
          agentVersionId: null,
        }),
      );
      expect(client.startExecution).not.toHaveBeenCalled();
      expect(nextClient.startExecution).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain(method.name);
      expect(client.read).toHaveBeenCalledTimes(1);
    },
  );

  it("edits a draft with revision checking and never writes an immutable version", async () => {
    await render();
    await fill("用途", "按部门汇总指定日期的销售数据");
    await click("保存草稿");
    expect(client.saveDraft).toHaveBeenCalledWith(
      "skill-1",
      3,
      expect.objectContaining({ purpose: "按部门汇总指定日期的销售数据" }),
    );
    expect(client.createVersion).not.toHaveBeenCalled();
    expect(version.method.purpose).toBe("汇总指定日期的销售数据");
  });

  it("requires concrete parameters and sends a real execution command pinned to the chosen version", async () => {
    await render();
    expect(button("开始试跑").disabled).toBe(true);
    await fill("试跑参数：报表日期", "2026-09-21");
    await click("开始试跑");
    expect(client.startExecution).toHaveBeenCalledWith("skill-1", {
      executionId: expect.any(String),
      threadId: "thread-1",
      expectedThreadRevision: 9,
      agentVersionId: "agent-v2",
      purpose: "trial",
      toolPermissionMode: "requestApproval",
      invocation,
    });
    expect(button("确认激活").disabled).toBe(true);
  });

  it.each(["trial", "execute"] as const)(
    "sends explicit approval delegation for %s as a task-level command field",
    async (purpose) => {
      current.skill.activatedVersionIds = ["v1"];
      await render();
      await fill("试跑参数：报表日期", "2026-09-21");
      await chooseApproveForMe();
      await click(purpose === "trial" ? "开始试跑" : "运行此版本");
      expect(client.startExecution).toHaveBeenCalledWith(
        "skill-1",
        expect.objectContaining({
          purpose,
          toolPermissionMode: "approveForMe",
          invocation,
        }),
      );
      const command = vi.mocked(client.startExecution).mock.calls[0][1];
      expect(command.invocation).not.toHaveProperty("toolPermissionMode");
    },
  );

  it("defaults execution approval independently of the Composer and leaves schedule approval to its own form", async () => {
    current.skill.activatedVersionIds = ["v1"];
    await render();
    await fill("试跑参数：报表日期", "2026-09-21");
    await click("运行此版本");
    expect(client.startExecution).toHaveBeenCalledWith(
      "skill-1",
      expect.objectContaining({ toolPermissionMode: "requestApproval" }),
    );
    await click("添加到日程");
    expect(onAddToSchedule).toHaveBeenCalledWith({
      title: method.name,
      invocation,
    });
  });

  it("freezes approval before preparation, retains it through ACK retries and remount, then resets the next attempt", async () => {
    let saved: SkillExecutionAttempt | null = null;
    const store = {
      get: () => saved,
      set: (next: SkillExecutionAttempt | null) => {
        saved = next;
      },
    };
    let finishPreparation!: (value: {
      threadId: string;
      expectedThreadRevision: number;
      agentVersionId: null;
    }) => void;
    const prepare = vi.fn(
      () =>
        new Promise<{
          threadId: string;
          expectedThreadRevision: number;
          agentVersionId: null;
        }>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const mount = () => (
      <DemonstratedSkillPanel
        skillId="skill-1"
        client={client}
        executionTarget={null}
        prepareExecutionTarget={prepare}
        executionAttemptStore={store}
      />
    );
    client.startExecution = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost_ack"))
      .mockImplementation(async (_id: string, input: SkillExecutionInput) => {
        current.executions = [
          {
            executionId: input.executionId,
            invocation: input.invocation,
            command: { toolPermissionMode: input.toolPermissionMode },
            purpose: input.purpose,
            runId: "confirmed-run",
            status: "queued",
            verification: "unknown",
            review: null,
            createdAt: "2026-09-14T00:00:00Z",
          },
        ];
      });
    await act(async () => root.render(mount()));
    await fill("试跑参数：报表日期", "2026-09-21");
    await chooseApproveForMe();
    await click("开始试跑");
    expect(store.get()).toMatchObject({
      toolPermissionMode: "approveForMe",
      command: null,
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="本次任务工具审批"]',
      )!.disabled,
    ).toBe(true);
    await act(async () =>
      finishPreparation({
        threadId: "prepared-thread",
        expectedThreadRevision: 1,
        agentVersionId: null,
      }),
    );
    const first = vi.mocked(client.startExecution).mock.calls[0][1];
    await act(async () => root.render(null));
    await act(async () => root.render(mount()));
    expect(
      container.querySelector('[aria-label="本次任务工具审批"]')!.textContent,
    ).toBe("帮我批准");
    await click("重试原试跑");
    expect(vi.mocked(client.startExecution).mock.calls[1][1]).toEqual(first);
    expect(prepare).toHaveBeenCalledOnce();
    expect(store.get()).toBeNull();
    expect(
      container.querySelector('[aria-label="运行记录"]')?.textContent,
    ).toContain("本次任务工具审批：帮我批准");
    expect(
      container.querySelector('[aria-label="本次任务工具审批"]')!.textContent,
    ).toBe("请求批准");
    await click("开始试跑");
    expect(store.get()).toMatchObject({
      toolPermissionMode: "requestApproval",
    });
    expect(store.get()!.executionId).not.toBe(first.executionId);
  });

  it("restores legacy pending attempts with default approval while preserving their original command body", async () => {
    const command: SkillExecutionInput = {
      executionId: "legacy-attempt",
      threadId: "thread-1",
      expectedThreadRevision: 1,
      agentVersionId: null,
      purpose: "trial",
      invocation,
    };
    const attempt: SkillExecutionAttempt = {
      executionId: command.executionId,
      purpose: "trial",
      invocation,
      command,
    };
    await act(async () =>
      root.render(
        <DemonstratedSkillPanel
          skillId="skill-1"
          client={client}
          executionTarget={command}
          executionAttemptStore={{ get: () => attempt, set: () => {} }}
        />,
      ),
    );
    expect(
      container.querySelector('[aria-label="本次任务工具审批"]')!.textContent,
    ).toBe("请求批准");
    await click("重试原试跑");
    expect(client.startExecution).toHaveBeenCalledWith("skill-1", command);
    expect(command).not.toHaveProperty("toolPermissionMode");
  });

  it("resets an unsubmitted approval choice when the authenticated client changes", async () => {
    await render();
    await chooseApproveForMe();
    client = { ...client, startExecution: vi.fn() };
    await render();
    expect(
      container.querySelector('[aria-label="本次任务工具审批"]')!.textContent,
    ).toBe("请求批准");
  });

  it.each(["simulated", "unknown"] as const)(
    "does not accept %s completion as an activation proof",
    async (verification) => {
      current.executions = [
        {
          executionId: "e1",
          invocation,
          purpose: "trial",
          runId: "r1",
          status: "completed",
          verification,
          createdAt: "2026-09-14T00:00:00Z",
          review: {
            confirmedAt: "2026-09-14T00:01:00Z",
            criteria: ["总额与来源一致"],
            coverage: ["new-date"],
          },
        },
      ];
      await render();
      expect(button("确认激活").disabled).toBe(true);
      expect(container.querySelector('[aria-label="核对试跑结果"]')).toBeNull();
    },
  );

  it("requires user result checking and new material before activation; leaves uncovered cases visible", async () => {
    current.executions = [
      {
        executionId: "e1",
        invocation,
        purpose: "trial",
        runId: "r1",
        status: "completed",
        verification: "real",
        createdAt: "2026-09-14T00:00:00Z",
        review: null,
      },
    ];
    await render();
    expect(button("确认激活").disabled).toBe(true);
    await fill("结果核对说明", "已核对 9 月 21 日报表，销售总额与来源一致。");
    const check = async (label: string) =>
      act(async () =>
        container
          .querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
          .click(),
      );
    await check("已核对：总额与来源一致");
    await check("使用了新日期");
    current.executions = [
      {
        ...current.executions[0],
        review: {
          confirmedAt: "2026-09-14T00:01:00Z",
          criteria: ["总额与来源一致"],
          coverage: ["new-date"],
        },
      },
    ];
    await click("确认核对结果");
    expect(client.reviewExecution).toHaveBeenCalledWith("skill-1", "e1", {
      criteria: ["总额与来源一致"],
      coverage: ["new-date"],
      resultNote: "已核对 9 月 21 日报表，销售总额与来源一致。",
    });
    expect(container.textContent).toContain("尚未覆盖：新输入、已知异常");
    await click("确认激活");
    expect(client.activate).toHaveBeenCalledWith("skill-1", 3, version.ref);
  });

  it("only schedules activated fixed versions and blocks new executions while disabled", async () => {
    current.skill.activatedVersionIds = ["v1"];
    await render();
    await fill("试跑参数：报表日期", "2026-09-21");
    await chooseApproveForMe();
    await click("添加到日程");
    expect(onAddToSchedule).toHaveBeenCalledWith({
      title: method.name,
      invocation,
    });
    current.skill.disabled = true;
    await click("禁用 Skill");
    expect(client.setDisabled).toHaveBeenCalledWith("skill-1", 3, true);
    expect(button("开始试跑").disabled).toBe(true);
    expect(button("添加到日程").disabled).toBe(true);
  });

  it("shows contract samples explicitly and cannot activate even if they claim a successful real trial", async () => {
    current.skill.source = {
      ...version.source,
      provenance: "contract-fixture",
    };
    current.versions = [{ ...version, source: current.skill.source }];
    current.executions = [
      {
        executionId: "e1",
        invocation,
        purpose: "trial",
        runId: "r1",
        status: "completed",
        verification: "real",
        createdAt: "2026-09-14T00:00:00Z",
        review: {
          confirmedAt: "now",
          criteria: ["总额与来源一致"],
          coverage: ["new-date"],
        },
      },
    ];
    await render();
    expect(container.textContent).toContain("契约样本");
    expect(button("确认激活").disabled).toBe(true);
  });

  it("preserves the authorized delivery target when adding a fixed version to a schedule", async () => {
    const deliveryTarget: NonNullable<SkillInvocationSpec["deliveryTarget"]> = {
      schemaVersion: "crewon.delivery-target.v1",
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
      targetId: "thread-deliveries",
    };
    current.skill.activatedVersionIds = ["v1"];
    await render(deliveryTarget);
    await fill("试跑参数：报表日期", "2026-09-21");
    await click("添加到日程");
    expect(onAddToSchedule).toHaveBeenCalledWith({
      title: method.name,
      invocation: { ...invocation, deliveryTarget },
    });
  });
});
