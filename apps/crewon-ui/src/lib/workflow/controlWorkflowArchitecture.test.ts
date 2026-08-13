import { describe, expect, it } from "vitest";

describe("Control Workflow architecture", () => {
  it("stays on the TypeScript Control boundary without legacy seams", () => {
    const sources = {
      ...import.meta.glob("./controlWorkflow*.ts", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
      ...import.meta.glob("../../components/app/ControlWorkflowPanel.tsx", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
      ...import.meta.glob("../../components/app/ControlWorkflowPanelView.tsx", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
      ...import.meta.glob("../../components/app/CommandWorkspaceViews.tsx", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
      ...import.meta.glob("../../components/app/CommandWorkspace.tsx", {
        eager: true,
        import: "default",
        query: "?raw",
      }),
    } as Record<string, string>;
    const forbidden = [
      "app-server",
      "CommandWorkflowPanel",
      "CrewonWorkflowExecution",
      "executionTargetClient",
    ];
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith("controlWorkflowArchitecture.test.ts"))
      .flatMap(([path, source]) =>
        forbidden
          .filter((snippet) => source.includes(snippet))
          .map((snippet) => `${path}:${snippet}`),
      );

    expect(offenders).toEqual([]);
  });

  it("does not reintroduce legacy execution target or schedule composition", () => {
    const appSource = import.meta.glob("../../App.tsx", {
      eager: true,
      import: "default",
      query: "?raw",
    })["../../App.tsx"] as string;

    expect(appSource).not.toContain("executionTargetClient={null}");
    expect(appSource).not.toContain("scheduleClient");
  });
});
