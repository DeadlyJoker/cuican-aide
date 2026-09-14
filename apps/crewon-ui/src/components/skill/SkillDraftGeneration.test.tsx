// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDemonstratedSkillClient,
  type SkillGenerationInput,
  type SkillGenerationView,
} from "../../lib/skill/demonstratedSkillClient";
import { SkillDraftGeneration } from "./SkillDraftGeneration";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const candidate = {
  name: "销售分析",
  purpose: "汇总并解释销售变化",
  steps: ["读取新日期的数据", "核对总额并解释变化"],
  parameters: [],
  requiredToolRefs: ["browser"],
  completionCriteria: ["总额可核对"],
  knownExceptions: ["来源缺失时停止并报告"],
  runtimeRequirements: ["运行时登录"],
} as const;
const projection = (): SkillGenerationView => ({
  generationId: "generation-1",
  skillId: "skill-1",
  expectedSkillRevision: 7,
  runId: "model-run-1",
  status: "completed",
  verification: "real",
  outcome: "candidate",
  candidate,
  reasonCode: null,
  appliedRevision: null,
  createdAt: "2026-09-14T00:00:00Z",
});

describe("model-generated Skill draft", () => {
  let root: Root;
  let container: HTMLDivElement;
  let server: SkillGenerationView | null;
  let posts: SkillGenerationInput[];
  let dropNextPost: boolean;
  let rejectRevision: boolean;
  const onApplied = vi.fn(async () => {});
  const prepareExecutionTarget = vi.fn(async () => ({
    threadId: "real-model-thread",
    expectedThreadRevision: 3,
    agentVersionId: null,
  }));
  let request: ReturnType<
    typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>
  >;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    server = null;
    posts = [];
    dropNextPost = false;
    rejectRevision = false;
    onApplied.mockClear();
    prepareExecutionTarget.mockClear();
    request = vi.fn(async (path, init) => {
      if (
        path === "/api/v1/skills/skill-1/generations" &&
        init?.method === "GET"
      )
        return Response.json({ generations: server ? [server] : [] });
      if (
        path === "/api/v1/skills/skill-1/generations" &&
        init?.method === "POST"
      ) {
        const input = JSON.parse(String(init.body)) as SkillGenerationInput;
        posts.push(input);
        if (rejectRevision) {
          rejectRevision = false;
          return Response.json(
            { error: { code: "skill_revision_conflict" } },
            { status: 409 },
          );
        }
        if (dropNextPost) {
          dropNextPost = false;
          throw new Error("lost_generation_ack");
        }
        server = {
          ...projection(),
          generationId: input.generationId,
          status: "running",
          outcome: "pending",
          candidate: null,
        };
        return Response.json(server);
      }
      if (path.endsWith("/collect")) {
        server = { ...server!, outcome: "candidate", candidate };
        return Response.json(server);
      }
      if (path.endsWith("/apply")) {
        server = { ...server!, appliedRevision: 8 };
        return Response.json(server);
      }
      if (server && path.endsWith(server.generationId))
        return Response.json(server);
      throw new Error(`Unexpected request ${path}`);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let client: ReturnType<typeof createDemonstratedSkillClient>;
  async function render(expectedSkillRevision = 7, draftDirty = false) {
    client ??= createDemonstratedSkillClient((path, init) =>
      request(path, init),
    );
    await act(async () =>
      root.render(
        <SkillDraftGeneration
          skillId="skill-1"
          expectedSkillRevision={expectedSkillRevision}
          draftDirty={draftDirty}
          disabled={false}
          client={client}
          executionTarget={null}
          prepareExecutionTarget={prepareExecutionTarget}
          onApplied={onApplied}
        />,
      ),
    );
  }
  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }

  it.each(["unmount", "replace-client"] as const)(
    "does not start model generation after target preparation and %s",
    async (change) => {
      let resolve!: (value: {
        threadId: string;
        expectedThreadRevision: number;
        agentVersionId: null;
      }) => void;
      prepareExecutionTarget.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await render();
      await click("让模型整理草稿");
      const nextClient = createDemonstratedSkillClient(async () =>
        Response.json({ generations: [] }),
      );
      await act(async () =>
        root.render(
          change === "unmount" ? null : (
            <SkillDraftGeneration
              skillId="skill-1"
              expectedSkillRevision={7}
              draftDirty={false}
              disabled={false}
              client={nextClient}
              executionTarget={null}
              onApplied={onApplied}
            />
          ),
        ),
      );
      await act(async () =>
        resolve({
          threadId: "old-model-thread",
          expectedThreadRevision: 3,
          agentVersionId: null,
        }),
      );
      expect(posts).toHaveLength(0);
      expect(onApplied).not.toHaveBeenCalled();
    },
  );

  it("does not notify or replace the next account draft when an earlier apply response arrives", async () => {
    server = projection();
    let resolve!: (value: Response) => void;
    const previousRequest = request.getMockImplementation()!;
    request.mockImplementation((path, init) =>
      path.endsWith("/apply")
        ? new Promise((done) => {
            resolve = done;
          })
        : previousRequest(path, init),
    );
    await render();
    await click("采用候选草稿");
    const nextClient = createDemonstratedSkillClient(async () =>
      Response.json({ generations: [] }),
    );
    await act(async () =>
      root.render(
        <SkillDraftGeneration
          skillId="skill-1"
          expectedSkillRevision={7}
          draftDirty={false}
          disabled={false}
          client={nextClient}
          executionTarget={null}
          onApplied={onApplied}
        />,
      ),
    );
    await act(async () =>
      resolve(Response.json({ ...projection(), appliedRevision: 8 })),
    );
    expect(onApplied).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(candidate.purpose);
    expect(container.textContent).not.toContain("候选已采用");
  });

  it("ignores a submitted generation result after switching accounts", async () => {
    let resolve!: (value: Response) => void;
    const previousRequest = request.getMockImplementation()!;
    request.mockImplementation((path, init) =>
      path.endsWith("/generations") && init?.method === "POST"
        ? new Promise((done) => {
            resolve = done;
          })
        : previousRequest(path, init),
    );
    await render();
    await click("让模型整理草稿");
    const nextClient = createDemonstratedSkillClient(async () =>
      Response.json({ generations: [] }),
    );
    await act(async () =>
      root.render(
        <SkillDraftGeneration
          skillId="skill-1"
          expectedSkillRevision={7}
          draftDirty={false}
          disabled={false}
          client={nextClient}
          executionTarget={null}
          onApplied={onApplied}
        />,
      ),
    );
    await act(async () => resolve(Response.json(projection())));
    expect(container.textContent).not.toContain(candidate.purpose);
    expect(container.textContent).not.toContain("候选草稿待审阅");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("uses a real model Run, validates its completed output, and only changes the draft after explicit adoption", async () => {
    await render();
    expect(container.textContent).toContain("预处理草稿");
    await click("让模型整理草稿");
    expect(posts[0]).toMatchObject({
      threadId: "real-model-thread",
      expectedThreadRevision: 3,
      agentVersionId: null,
      expectedSkillRevision: 7,
    });
    expect(prepareExecutionTarget).toHaveBeenCalledWith(posts[0].generationId);
    expect(onApplied).not.toHaveBeenCalled();
    expect(container.textContent).toContain("模型正在整理");
    server = { ...server!, status: "completed" };
    await click("更新生成状态");
    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(/\/collect$/),
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(container.textContent).toContain(candidate.purpose);
    expect(onApplied).not.toHaveBeenCalled();
    await click("采用候选草稿");
    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(/\/apply$/),
      expect.objectContaining({
        body: JSON.stringify({ expectedSkillRevision: 7 }),
      }),
    );
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it("retries an uncertain generation submission without changing its ID, route or draft revision", async () => {
    dropNextPost = true;
    await render();
    await click("让模型整理草稿");
    await click("重试原生成请求");
    expect(posts[1]).toEqual(posts[0]);
    expect(prepareExecutionTarget).toHaveBeenCalledTimes(1);
  });

  it("keeps the original request on revision conflict and only uses a new ID after an explicit current-draft request", async () => {
    rejectRevision = true;
    await render();
    await click("让模型整理草稿");
    expect(posts).toHaveLength(1);
    expect(button("重试原生成请求")).toBeDefined();
    await render(8);
    await click("按当前草稿重新生成");
    expect(posts[1].generationId).not.toBe(posts[0].generationId);
    expect(posts[1].expectedSkillRevision).toBe(8);
  });

  it.each(["simulated", "unknown"] as const)(
    "labels %s output and cannot adopt it as a real model draft",
    async (verification) => {
      server = { ...projection(), verification };
      await render();
      expect(button("采用候选草稿").disabled).toBe(true);
      expect(container.textContent).toContain("不能作为真实模型整理结果采用");
    },
  );

  it("keeps invalid output and stale or locally edited drafts from being applied", async () => {
    server = {
      ...projection(),
      outcome: "invalid",
      candidate: null,
      reasonCode: "skill_generation_output_invalid",
    };
    await render();
    expect(container.textContent).toContain("输出未通过结构校验");
    expect(onApplied).not.toHaveBeenCalled();
    server = projection();
    await click("更新生成状态");
    await render(8);
    expect(button("采用候选草稿").disabled).toBe(true);
    expect(container.textContent).toContain("草稿已更新");
    await render(7, true);
    expect(button("采用候选草稿").disabled).toBe(true);
    expect(container.textContent).toContain("先保存当前草稿修改");
  });
});
