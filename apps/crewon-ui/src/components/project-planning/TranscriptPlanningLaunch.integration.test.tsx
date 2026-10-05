// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import { describe, expect, it, vi } from "vitest";
import { TranscriptTurn } from "../TranscriptTurn";
import {
  ProjectPlanningScope,
  ProjectPlanningRunScope,
} from "./ProjectPlanningScope";
import { planningLaunchFixture } from "../../lib/plugins/projectPlanningLaunch.test-support";
import { createProjectPlanningLaunch } from "../../lib/plugins/projectPlanningLaunch";
import { createProjectPlanningLaunchIntentStore } from "../../lib/plugins/projectPlanningLaunchIntent";

describe("original transcript streaming and project confirmation", () => {
  it("shows a completed bound suggestion outside collapsed process details, executes only on confirmation, and cold-remounts with reads", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const f = planningLaunchFixture(),
      container = document.createElement("div"),
      root = createRoot(container),
      openWorkbench = vi.fn();
    const item: Extract<ThreadItem, { type: "dynamicToolCall" }> = {
      type: "dynamicToolCall",
      id: "original-call",
      namespace: null,
      tool: "crewon_project_propose",
      arguments: {},
      status: "completed",
      success: true,
      durationMs: 2,
      contentItems: [{ type: "inputText", text: JSON.stringify(f.proposal) }],
    };
    const turn: Turn = {
      id: "original-run",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "user-idea",
          clientId: null,
          content: [
            {
              type: "text",
              text: "把雨夜重逢的想法做成两集短剧",
              text_elements: [],
            },
          ],
        },
        item,
      ],
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
    };
    let launch = f.launch;
    const render = (value: Turn, threadId = "original-thread") =>
      root.render(
        <ProjectPlanningScope
          value={{
            threadId,
            canOpen: () => true,
            open: vi.fn(),
            openWorkbench,
            launch,
          }}
        >
          <ProjectPlanningRunScope runId={value.id}>
            <TranscriptTurn
              turn={value}
              turnIndex={0}
              locale="zh"
              itemLabels={{
                commandLabel: "命令",
                crewonLabel: "CrewON",
                filesLabel: "文件",
                planLabel: "计划",
                reasoningLabel: "思考",
                youLabel: "你",
              }}
              crewonLabel="CrewON"
              hasWorkbench={false}
              shouldShowThinking={false}
              hidesDurableFinalWhileStreaming={false}
              isLatestResponse
            />
          </ProjectPlanningRunScope>
        </ProjectPlanningScope>,
      );
    try {
      await act(async () =>
        render({
          ...turn,
          status: "inProgress",
          completedAt: null,
          items: [
            turn.items[0],
            { ...item, status: "inProgress", success: null },
          ],
        }),
      );
      expect(container.querySelector(".project-planning-proposal")).toBeNull();
      expect(f.calls).toHaveLength(0);
      await act(async () => render(turn));
      const process = container.querySelector<HTMLButtonElement>(
        ".turn-process-summary",
      );
      expect(process).not.toBeNull();
      if (process?.getAttribute("aria-expanded") === "true")
        await act(async () => process.click());
      expect(
        container.querySelector(".turn-process-summary[aria-expanded=false]"),
      ).not.toBeNull();
      expect(
        container.querySelectorAll(".project-planning-proposal"),
      ).toHaveLength(1);
      expect(
        container
          .querySelector(".project-planning-proposal")!
          .closest(".turn-process-details"),
      ).toBeNull();
      expect(container.textContent).toContain("把雨夜重逢的想法做成两集短剧");
      expect(f.calls).toHaveLength(0);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            ".project-planning-proposal button.primary",
          )!
          .click();
      });
      for (
        let i = 0;
        i < 100 && f.launch.snapshot(f.proposal).phase === "working";
        i++
      )
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      expect(
        f.calls.filter((c) =>
          /\.(createProject|attach|start)$/u.test(c.action),
        ),
      ).toHaveLength(3);
      expect(container.textContent).toContain("文字计划：等待执行");
      const count = f.calls.length;
      launch = createProjectPlanningLaunch(
        createProjectPlanningLaunchIntentStore(
          f.storage,
          "actual-account-original-api",
        ),
        f.transport,
      );
      await act(async () => render(turn));
      for (
        let i = 0;
        i < 100 && launch.snapshot(f.proposal).phase === "working";
        i++
      )
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      expect(
        f.calls
          .slice(count)
          .every((c) => /\.(getProject|getBinding|get)$/u.test(c.action)),
      ).toBe(true);
      await act(async () => render(turn, "another-thread"));
      expect(container.querySelector(".project-planning-proposal")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
