import type { Thread } from "@crewon-ui-model/v2/Thread";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CommandProjectBoardView,
  CommandTaskBoard,
  commandTaskStage,
} from "./CommandTaskBoard";

function thread(
  id: string,
  status: Thread["status"],
  turnStatus: "completed" | "failed" | "inProgress" = "completed",
): Thread {
  return {
    id,
    name: `${id} title`,
    preview: `${id} preview`,
    status,
    turns: [
      {
        status: turnStatus,
      },
    ],
    updatedAt: id === "active" ? 30 : id === "failed" ? 20 : 10,
  } as unknown as Thread;
}

describe("CommandTaskBoard", () => {
  it("projects live Thread and Turn state into bounded board stages", () => {
    expect([
      commandTaskStage(thread("active", { type: "active", activeFlags: [] })),
      commandTaskStage(thread("failed", { type: "idle" }, "failed")),
      commandTaskStage(thread("ready", { type: "idle" })),
    ]).toEqual(["active", "attention", "ready"]);
  });

  it("snapshots a user-visible task board backed by real conversations", () => {
    const markup = renderToStaticMarkup(
      <CommandTaskBoard
        locale="zh"
        selectedThreadId="active"
        threads={[
          thread("ready", { type: "idle" }),
          thread("failed", { type: "idle" }, "failed"),
          thread("active", { type: "active", activeFlags: [] }),
        ]}
      />,
    );

    expect(markup).toContain('data-task-stage="active"');
    expect(markup).toContain('data-task-stage="attention"');
    expect(markup).toContain('data-task-stage="ready"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toMatchSnapshot();
  });

  it("renders the migration-era project destination with live tasks", () => {
    const markup = renderToStaticMarkup(
      <CommandProjectBoardView
        active
        locale="zh"
        selectedThreadId="active"
        threads={[thread("active", { type: "active", activeFlags: [] })]}
        onNewTask={() => undefined}
        onSelectThread={() => undefined}
      />,
    );

    expect(markup).toContain("项目与执行");
    expect(markup).toContain("按真实会话和运行状态组织");
    expect(markup).toContain('data-thread-id="active"');
    expect(markup).not.toMatch(/running 56%|待批准|GitHub MCP 授权/);
    expect(markup).toMatchSnapshot();
  });
});
