import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import {
  TranscriptTeamProgress,
  teamProgressForThread,
} from "./TranscriptTeamProgress";

const props: ComponentProps<typeof TranscriptTeamProgress> = {
  locale: "zh",
  itemLabels: {
    commandLabel: "命令",
    crewonLabel: "CrewON",
    filesLabel: "文件",
    planLabel: "计划",
    reasoningLabel: "推理",
    youLabel: "你",
  },
  progress: {
    threadId: "main",
    messageId: "m1",
    content: "8位坐席的预算选型",
    phase: "working",
    runs: [
      {
        runId: "r1",
        memberName: "业务分析员",
        kind: "worker",
        status: "running",
        reconnecting: false,
      },
      {
        runId: "r2",
        memberName: "约束核验员",
        kind: "worker",
        status: "queued",
        reconnecting: false,
      },
    ],
  },
};
describe("TranscriptTeamProgress", () => {
  it("shows one user message and actual member states, not a fabricated final answer", () => {
    const markup = renderToStaticMarkup(<TranscriptTeamProgress {...props} />);
    expect(markup).toContain("执行中");
    expect(markup).toContain("排队中");
    expect(markup.split("8位坐席的预算选型")).toHaveLength(2);
    expect(markup).not.toContain("VERDICT");
    expect(markup).toMatchSnapshot();
  });
  it("labels interrupted observation as unknown instead of claiming current execution status", () => {
    const markup = renderToStaticMarkup(
      <TranscriptTeamProgress
        {...props}
        progress={{
          ...props.progress,
          runs: props.progress.runs.map((run) => ({
            ...run,
            reconnecting: true,
          })),
        }}
      />,
    );
    expect(markup).toContain("状态待确认");
    expect(markup).not.toContain(">执行中<");
  });
  it("keeps another thread's progress out of the conversation", () => {
    expect(
      teamProgressForThread({ id: "other" } as Thread, props.progress),
    ).toBeNull();
    expect(
      teamProgressForThread({ id: "main" } as Thread, props.progress),
    ).toBe(props.progress);
  });
  it("does not claim failed coordination canceled the accepted Runs", () => {
    const markup = renderToStaticMarkup(
      <TranscriptTeamProgress
        {...props}
        progress={{ ...props.progress, phase: "failed" }}
      />,
    );
    expect(markup).toContain("已提交的成员任务可能仍在执行");
    expect(markup).not.toContain("全部任务已取消");
  });
  it("does not hide recovered durable output behind stale progress", () => {
    const thread = {
      id: "main",
      turns: [
        {
          items: [
            { type: "userMessage", id: "m1" },
            { type: "agentMessage", text: "Recovered answer" },
          ],
        },
      ],
    } as unknown as Thread;
    expect(
      teamProgressForThread(thread, { ...props.progress, phase: "failed" }),
    ).toBeNull();
  });
});
