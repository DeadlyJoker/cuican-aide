import type { ControlApiClient } from "@crewon/control-client";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { controlOfficeRecord } from "../../lib/office/controlOfficeRuntime";
import { createControlCommandOfficeRoomAdapter } from "./AppCommandOfficeRoomAdapter";
import { ControlOfficeRoomView } from "./ControlOfficeRoom";

const office = {
  schemaVersion: "crewon.office-definition.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 2,
  title: "Release office",
  members: [
    {
      memberId: "member-1",
      displayName: "Release agent",
      agentVersionId: "agent-version-1",
    },
  ],
  executionTargets: [
    { targetId: "target-1", agentVersionId: "agent-version-1" },
  ],
  createdByActorId: "actor-1",
  createdAt: "2026-08-14T00:00:00.000Z",
};

describe("ControlOfficeRoomView", () => {
  it("remounts the stateful room when the Office authority changes", () => {
    const room = createControlCommandOfficeRoomAdapter({
      client: {} as ControlApiClient,
      locale: "en",
      threadId: "thread-1",
    }).render(controlOfficeRecord(office), vi.fn(), vi.fn());

    expect(isValidElement(room)).toBe(true);
    expect((room as ReactElement).key).toBe("office-version-1");
  });

  it("renders the explicit Workflow delegation authority", () => {
    const markup = renderToStaticMarkup(
      <ControlOfficeRoomView
        busy={false}
        input={'{"topic":"release"}'}
        locale="zh"
        office={office}
        onBack={vi.fn()}
        onInputChange={vi.fn()}
        onStart={vi.fn()}
        onWorkflowVersionChange={vi.fn()}
        runId="run-1"
        threadId="thread-1"
        workflows={[
          {
            workflowId: "workflow-1",
            workflowVersionId: "workflow-version-1",
            contentDigest: `sha256:${"a".repeat(64)}`,
            name: "Release workflow",
            description: "Build and verify",
            createdAt: "2026-08-14T00:00:00.000Z",
          },
        ]}
        workflowVersionId="workflow-version-1"
      />,
    );

    expect(markup).toMatchSnapshot();
  });

  it("fails closed when no WorkflowVersion is published", () => {
    const markup = renderToStaticMarkup(
      <ControlOfficeRoomView
        busy={false}
        input="{}"
        locale="en"
        office={office}
        onBack={vi.fn()}
        onInputChange={vi.fn()}
        onStart={vi.fn()}
        onWorkflowVersionChange={vi.fn()}
        runId={null}
        threadId="thread-1"
        workflows={[]}
        workflowVersionId=""
      />,
    );

    expect(markup).toMatchSnapshot();
  });
});
