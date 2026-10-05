// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectPlanningProposal } from "@crewon/contracts/project-planning";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import {
  ProjectPlanningScope,
  ProjectPlanningRunScope,
} from "./ProjectPlanningScope";
import { transcriptProjectPlanningProposal } from "./projectPlanningProposal";
import { TranscriptProjectPlanningCard } from "./TranscriptProjectPlanningCard";
const digest = `sha256:${"a".repeat(64)}`;
export const proposal: ProjectPlanningProposal = {
  schemaVersion: "crewon.project-planning-proposal.v1",
  kind: "newProject",
  origin: { threadId: "thread", runId: "run", callId: "call" },
  capability: {
    capabilityId: digest,
    source: {
      pluginId: "example.drama",
      publisherId: "example.publisher",
      version: "18.0.0",
      packageDigest: digest,
      contributionId: "workbench",
    },
    title: "AI 短剧",
    kind: "short-drama",
    stages: ["brief", "outline", "script"],
    maximumEpisodes: 16,
    moduleAvailable: true,
    textPlansAvailable: true,
    executionReady: false,
  },
  input: {
    capabilityId: digest,
    title: "雨夜来信",
    briefText: "两位老友在雨夜重逢",
    instruction: "先做三集方案",
    start: "outline",
    target: "script",
    episodeCount: 3,
    adoption: "manual",
  },
};
const item: Extract<ThreadItem, { type: "dynamicToolCall" }> = {
  type: "dynamicToolCall",
  id: "call",
  namespace: null,
  tool: "crewon_project_propose",
  arguments: {},
  status: "completed",
  success: true,
  durationMs: 5,
  contentItems: [{ type: "inputText", text: JSON.stringify(proposal) }],
};
describe("original transcript planning suggestion", () => {
  it("renders a reviewable draft without any automatic navigation or execution", () => {
    const open = vi.fn();
    const html = renderToStaticMarkup(
      <ProjectPlanningScope
        value={{ threadId: "thread", canOpen: () => true, open }}
      >
        <ProjectPlanningRunScope runId="run">
          <TranscriptProjectPlanningCard item={item} locale="zh" />
        </ProjectPlanningRunScope>
      </ProjectPlanningScope>,
    );
    expect(html).toContain("雨夜来信");
    expect(html).toContain("分集大纲 → 分集剧本 · 3 集");
    expect(html).toContain("这条建议尚未开始执行");
    expect(open).not.toHaveBeenCalled();
    expect(html).toMatchSnapshot();
  });
  it("does not create a suggestion from failed, partial, foreign-origin or other tool output", () => {
    const origin = { threadId: "thread", runId: "run" };
    for (const changed of [
      { status: "inProgress" },
      { success: false },
      { namespace: "external" },
      { tool: "another_tool" },
      { id: "another-call" },
    ])
      expect(
        transcriptProjectPlanningProposal(
          { ...item, ...changed } as typeof item,
          origin,
        ),
      ).toBeNull();
    expect(
      transcriptProjectPlanningProposal(item, {
        ...origin,
        runId: "another-run",
      }),
    ).toBeNull();
    expect(
      transcriptProjectPlanningProposal(item, {
        ...origin,
        threadId: "another-thread",
      }),
    ).toBeNull();
    expect(
      transcriptProjectPlanningProposal(
        {
          ...item,
          contentItems: [{ type: "inputText", text: "x".repeat(8193) }],
        },
        origin,
      ),
    ).toBeNull();
    expect(
      renderToStaticMarkup(
        <TranscriptProjectPlanningCard item={item} locale="zh" />,
      ),
    ).toBe("");
  });
  it("uses only the explicit review click and fences a withdrawn plugin", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div"),
      root = createRoot(container),
      open = vi.fn();
    const render = (available: boolean) =>
      root.render(
        <ProjectPlanningScope
          value={{ threadId: "thread", canOpen: () => available, open }}
        >
          <ProjectPlanningRunScope runId="run">
            <TranscriptProjectPlanningCard item={item} locale="zh" />
          </ProjectPlanningRunScope>
        </ProjectPlanningScope>,
      );
    try {
      await act(async () => render(true));
      expect(open).not.toHaveBeenCalled();
      await act(async () => container.querySelector("button")!.click());
      expect(open).toHaveBeenCalledExactlyOnceWith(proposal);
      await act(async () => render(false));
      expect(container.querySelector("button")!.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
