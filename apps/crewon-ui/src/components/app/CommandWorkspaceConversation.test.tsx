import type { Thread } from "@crewon-protocol/v2/Thread";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommandThreadRoom } from "./CommandWorkspaceConversation";

describe("CommandThreadRoom", () => {
  it("snapshots a durable Cloud Agent result as a standard conversation", () => {
    const thread = {
      id: "cloud-thread-1",
      threadSource: "crewon_cloud_agent_provider_binding_v1",
      name: "Cloud delivery review",
      preview: "Delivery review completed",
      cwd: "/repo/frontend",
      createdAt: 1,
      updatedAt: 2,
      status: { type: "idle" },
      turns: [
        {
          id: "cloud-turn-1",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1_000,
          error: null,
          itemsView: "full",
          items: [
            {
              id: "cloud-user-message-1",
              type: "userMessage",
              clientId: "cloud-request-1",
              content: [
                {
                  type: "text",
                  text: "Review the delivery boundary and return the result.",
                  text_elements: [],
                },
              ],
            },
            {
              id: "cloud-agent-message-1",
              type: "agentMessage",
              text: "## Review complete\n\nThe boundary is stable and ready for verification.",
              phase: null,
              memoryCitation: null,
            },
          ],
        },
      ],
    } as unknown as Thread;

    const markup = renderToStaticMarkup(
      <CommandThreadRoom
        activeTurnId={null}
        cwd="/repo/frontend"
        locale="en"
        selectedThread={thread}
        streamingText=""
        workMode="code"
        onModeChange={() => undefined}
      />,
    );

    expect(markup).toMatchSnapshot();
    expect(markup).not.toContain("agentPlatform/chat");
    expect(markup).not.toContain("providerRunId");
    expect(markup).not.toContain("Team execution completed");
  });
});
