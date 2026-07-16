import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  OfficeMemoryReviewPanel,
  OfficeWorkspaceView,
  resolveOfficeMessageOutbox,
  submitOfficeDraft,
} from "./OfficeWorkspaceView";
import type {
  LibraryPanel,
  OfficeMemoryRecord,
} from "../../lib/domain/crewonDomain";

const panel: LibraryPanel = {
  kind: "office",
  title: "Frontend Office",
  subtitle: "Ship the UI architecture",
  body: "Coordinate the frontend refactor.",
  items: [],
  actions: [
    {
      id: "recruit-agent",
      label: "Recruit agent",
      tone: "primary",
    },
  ],
  workspace: {
    goal: "Make the frontend easier to extend.",
    backendStatus: "connected",
    recordId: "office-record-1",
    members: [
      {
        memberId: "member-planner",
        name: "Planner",
        role: "Lead",
        glyph: "P",
        accent: "blue",
        status: "Planning next split",
      },
      {
        memberId: "member-reviewer",
        name: "Reviewer",
        role: "Quality",
        glyph: "R",
        accent: "green",
        status: "Checking boundaries",
        online: false,
      },
    ],
    messages: [
      {
        author: "System",
        glyph: "S",
        accent: "slate",
        time: "10:00",
        text: "Office started",
        kind: "system",
      },
      {
        author: "Planner",
        glyph: "P",
        accent: "blue",
        time: "10:01",
        text: "@Reviewer check the component boundary.",
      },
    ],
    tasks: [
      {
        title: "Split office workspace",
        owner: "Planner",
        status: "doing",
      },
    ],
  },
};

function memory(
  overrides: Partial<OfficeMemoryRecord> = {},
): OfficeMemoryRecord {
  return {
    id: "memory-1",
    officeKey: "thread-1",
    scope: "office",
    member: null,
    agentId: null,
    kind: "decision",
    content: "Use the launch checklist",
    confidence: "medium",
    importance: "high",
    status: "pending",
    evidenceRefs: [{ runId: "run-1", threadId: "thread-1", turnId: "turn-1" }],
    keywords: ["launch"],
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
    lastUsedAt: "2026-06-20T01:00:00Z",
    usageCount: 2,
    ...overrides,
  };
}

describe("OfficeWorkspaceView", () => {
  it("reuses the same message id for an unchanged retry draft", () => {
    const createId = vi
      .fn()
      .mockReturnValueOnce("message-1")
      .mockReturnValueOnce("message-2");
    const first = resolveOfficeMessageOutbox(
      null,
      " Continue ",
      panel,
      createId,
    );
    const retry = resolveOfficeMessageOutbox(
      first,
      "Continue",
      panel,
      createId,
    );
    const changed = resolveOfficeMessageOutbox(
      retry,
      "Continue with tests",
      panel,
      createId,
    );

    expect(first).toEqual({
      clientUserMessageId: "message-1",
      mentions: [],
      officeIdentity: { kind: "recordId", value: "office-record-1" },
      text: "Continue",
    });
    expect(retry).toBe(first);
    expect(changed).toEqual({
      clientUserMessageId: "message-2",
      mentions: [],
      officeIdentity: { kind: "recordId", value: "office-record-1" },
      text: "Continue with tests",
    });
  });

  it("keeps canonical mentions stable across a queued message retry", () => {
    const createId = vi
      .fn()
      .mockReturnValueOnce("message-1")
      .mockReturnValueOnce("message-2");
    const mentions = [{ memberId: "member-reviewer" }];
    const first = resolveOfficeMessageOutbox(
      null,
      "@Reviewer continue",
      panel,
      createId,
      mentions,
    );
    const retry = resolveOfficeMessageOutbox(
      first,
      "@Reviewer continue",
      panel,
      createId,
      [{ memberId: "member-reviewer" }],
    );
    const changedRoute = resolveOfficeMessageOutbox(
      retry,
      "@Reviewer continue",
      panel,
      createId,
      [{ memberId: "member-builder" }],
    );

    expect(retry).toBe(first);
    expect(changedRoute).toMatchObject({
      clientUserMessageId: "message-2",
      mentions: [{ memberId: "member-builder" }],
    });
  });

  it("does not reuse an outbox across Office identities", () => {
    const createId = vi
      .fn()
      .mockReturnValueOnce("message-a")
      .mockReturnValueOnce("message-b");
    const first = resolveOfficeMessageOutbox(null, "Continue", panel, createId);
    const otherPanel: LibraryPanel = {
      ...panel,
      workspace: {
        ...panel.workspace!,
        recordId: "office-record-2",
      },
    };

    expect(
      resolveOfficeMessageOutbox(first, "Continue", otherPanel, createId),
    ).toMatchObject({
      clientUserMessageId: "message-b",
      officeIdentity: { kind: "recordId", value: "office-record-2" },
    });
  });

  it("clears an office draft only after a successful send", async () => {
    const onSuccess = vi.fn();
    const onSend = vi.fn().mockResolvedValue({
      delivery: null,
      disposition: "clearOutbox",
    });

    await expect(
      submitOfficeDraft({
        draft: "  Review the launch  ",
        isSubmitting: false,
        onSend,
        onSuccess,
      }),
    ).resolves.toEqual({
      delivery: null,
      disposition: "clearOutbox",
    });
    expect(onSend).toHaveBeenCalledWith("Review the launch");
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("preserves an office draft when sending fails", async () => {
    const onSuccess = vi.fn();
    const error = new Error("send failed");

    await expect(
      submitOfficeDraft({
        draft: "Keep this draft",
        isSubmitting: false,
        onSend: vi.fn().mockRejectedValue(error),
        onSuccess,
      }),
    ).rejects.toBe(error);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("retains the draft and receipt while a message is queued", async () => {
    const onSuccess = vi.fn();
    const delivery = {
      type: "queued" as const,
      afterRunId: "run-active",
      position: 2,
    };

    await expect(
      submitOfficeDraft({
        draft: "Keep this receipt",
        isSubmitting: false,
        onSend: vi.fn().mockResolvedValue({
          delivery,
          disposition: "retainOutbox",
        }),
        onSuccess,
      }),
    ).resolves.toEqual({
      delivery,
      disposition: "retainOutbox",
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("renders the focused chat workspace with a hidden member drawer", () => {
    const markup = renderToStaticMarkup(
      <OfficeWorkspaceView
        panel={panel}
        locale="en"
        onArtifact={vi.fn()}
        onBack={vi.fn()}
        onDelegationCancel={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationRetry={vi.fn()}
        onDecision={vi.fn()}
        onPanelAction={vi.fn()}
        onVerificationCancel={vi.fn()}
        onVerificationRetry={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(markup).toContain("Frontend Office");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Choose agent");
    expect(markup).toContain("Add member");
    expect(markup).toContain('class="office-members-drawer" hidden=""');
    expect(markup).not.toContain('class="office-tasks"');
    expect(markup).toMatchInlineSnapshot(
      `"<main class="office-workspace" aria-label="Frontend Office"><header class="office-top"><button type="button" class="office-back">Back</button><div class="office-top-title" title="Make the frontend easier to extend."><span>Office chat</span><h1>Frontend Office</h1><p>Leader · Office manager · 2 members</p></div><div class="office-tabs" role="tablist" aria-label="Office views"><button type="button" role="tab" aria-selected="true" data-active="true">Chat</button></div><div class="office-top-actions"><button type="button" aria-expanded="false">Members</button><span class="office-runtime-status" data-runtime-status="connected">Ready</span></div></header><div class="office-room-body"><section class="office-chat" aria-label="Group chat"><div aria-live="polite" aria-relevant="additions text" class="office-chat-stream" role="log"><div class="office-system">Office started</div><div class="office-bubble" data-kind="message" data-self="false"><span class="office-avatar office-avatar-sm" data-accent="blue" aria-hidden="true">P</span><div class="office-bubble-body"><div class="office-bubble-head"><strong>Planner</strong><span>10:01</span></div><p><span class="office-mention">@Reviewer</span> check the component boundary.</p></div></div></div><div class="office-shared-composer-shell" data-runtime-mode="idle"><form class="command-input office-global-composer office-shared-composer" data-command-composer="true"><label class="visually-hidden" for="office-message-input">Group chat input</label><textarea aria-describedby="office-composer-status office-composer-budget" aria-label="Group chat input" data-composer="" id="office-message-input" placeholder="Tell the manager agent the goal, context, or next step…" rows="2"></textarea><div class="input-tools" data-od-id="composer-tools"><div class="composer-controls" data-od-id="composer-control-row"><button aria-label="Add attachment" class="icon-action composer-plus-action office-composer-attach-action" disabled="" title="Add workspace attachment" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button></div><div class="composer-actions" data-od-id="composer-action-row"><button aria-busy="false" aria-label="Send" class="send-button" disabled="" title="Send" type="submit"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up" aria-hidden="true"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg></button></div></div><div class="context-palette office-member-palette" data-composer-palette="" hidden=""><div class="context-list" role="listbox"><button role="option" title="@Planner" type="button"><span>P</span><strong>Planner</strong><em>Lead</em></button><button role="option" title="@Reviewer" type="button"><span>R</span><strong>Reviewer</strong><em>Quality</em></button></div></div><div class="slash-palette office-slash-palette" data-composer-palette="" hidden=""><div class="slash-list" role="listbox"><p class="office-composer-palette-empty">No Skill or MCP capability is currently available.</p></div></div><div class="composer-state-row"><span aria-live="polite" class="composer-state" id="office-composer-status" role="status">Office manager receives messages without @ · type @ for members or / for Skill and MCP</span><span class="composer-input-budget" id="office-composer-budget">0/900 bytes</span></div></form></div></section><button type="button" class="office-members-backdrop" aria-label="Close members panel" hidden=""></button><div class="office-members-drawer" hidden=""><aside class="office-members" aria-label="Members"><div class="office-rail-head"><strong>Members</strong><div class="office-rail-head-actions"><span>3</span><button type="button" aria-label="Close members panel" title="Close"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><div class="office-member office-manager-member" data-office-manager="true"><span class="office-avatar" data-accent="cyan" aria-hidden="true">L<i class="office-presence" data-online="false"></i></span><span class="office-member-text"><strong>Office manager</strong><span>Leader Agent · receives goals, plans work, and coordinates members</span><em>Manager thread will be created before the first message</em></span><span class="office-manager-badge">Leader</span></div><div class="office-member"><span class="office-avatar" data-accent="blue" aria-hidden="true">P<i class="office-presence" data-online="true"></i></span><span class="office-member-text"><strong>Planner</strong><span>Lead</span><em>Planning next split</em></span></div><div class="office-member"><span class="office-avatar" data-accent="green" aria-hidden="true">R<i class="office-presence" data-online="false"></i></span><span class="office-member-text"><strong>Reviewer</strong><span>Quality</span><em>Checking boundaries</em></span></div><div class="office-recruit"><div class="office-rail-head"><strong>Choose agent</strong><button type="button" title="Refresh agents" aria-label="Refresh agents"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg></button></div><p class="office-recruit-empty">No recruitable agents yet.</p><button type="button" data-tone="primary" disabled=""><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user-plus" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="19" x2="19" y1="8" y2="14"></line><line x1="22" x2="16" y1="11" y2="11"></line></svg>Add member</button></div></aside></div></div></main>"`,
    );
  });

  it("derives a connected runtime state from an existing Office thread", () => {
    const markup = renderToStaticMarkup(
      <OfficeWorkspaceView
        panel={{
          ...panel,
          workspace: {
            ...panel.workspace!,
            backendStatus: undefined,
            threadId: "manager-thread",
          },
        }}
        locale="zh"
        onArtifact={vi.fn()}
        onBack={vi.fn()}
        onDelegationCancel={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationRetry={vi.fn()}
        onDecision={vi.fn()}
        onPanelAction={vi.fn()}
        onVerificationCancel={vi.fn()}
        onVerificationRetry={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(markup).toContain("已就绪");
    expect(markup).not.toContain("草稿");
  });

  it("renders add requirement and a separate whole-run stop action", () => {
    const activePanel: LibraryPanel = {
      ...panel,
      workspace: {
        ...panel.workspace!,
        threadId: "manager-thread",
        activity: {
          runs: [
            {
              id: "run-active",
              title: "Active run",
              status: "running",
              threadId: "manager-thread",
              turnId: "manager-turn",
            },
          ],
        },
      },
    };
    const markup = renderToStaticMarkup(
      <OfficeWorkspaceView
        activeTurnByThread={{ "manager-thread": "manager-turn" }}
        panel={activePanel}
        locale="en"
        onArtifact={vi.fn()}
        onBack={vi.fn()}
        onDelegationCancel={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationRetry={vi.fn()}
        onDecision={vi.fn()}
        onPanelAction={vi.fn()}
        onVerificationCancel={vi.fn()}
        onVerificationRetry={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(markup).toContain("Add requirement");
    expect(markup).toContain("Stop current Office run");
    expect(markup).toContain("Manager running · send adds a requirement");
  });

  it("wires an active conversation run into the shared composer without task controls", () => {
    const conversationPanel: LibraryPanel = {
      ...panel,
      workspace: {
        ...panel.workspace!,
        threadId: "manager-thread",
        activity: {
          runs: [
            {
              id: "conversation-active",
              title: "What is the current status?",
              status: "running",
              messageIntent: "conversation",
              threadId: "manager-thread",
              turnId: "manager-turn",
            },
            {
              id: "task-completed",
              title: "Completed task",
              status: "completed",
              messageIntent: "task",
              updatedAt: "2026-07-15T01:00:00Z",
            },
          ],
        },
        messages: [
          ...panel.workspace!.messages,
          {
            author: "Office manager",
            glyph: "组",
            accent: "blue",
            time: "10:02",
            text: "Current status is ready.",
            kind: "message",
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <OfficeWorkspaceView
        activeTurnByThread={{ "manager-thread": "manager-turn" }}
        panel={conversationPanel}
        locale="en"
        onArtifact={vi.fn()}
        onBack={vi.fn()}
        onDelegationCancel={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationRetry={vi.fn()}
        onDecision={vi.fn()}
        onPanelAction={vi.fn()}
        onVerificationCancel={vi.fn()}
        onVerificationRetry={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(markup).toContain("Continue chat");
    expect(markup).toContain("Current status is ready.");
    expect(markup).toContain('data-runtime-mode="managerConversationActive"');
    expect(markup).toContain("Stop current Office run");
  });

  it("renders pending memory review controls", () => {
    const markup = renderToStaticMarkup(
      <OfficeMemoryReviewPanel
        locale="en"
        status="pending"
        canDecide
        isLoading={false}
        nextCursor={null}
        error={null}
        pendingDecision={null}
        onDecision={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
        onStatusChange={vi.fn()}
        memories={[memory()]}
      />,
    );

    expect(markup).toContain("Use the launch checklist");
    expect(markup).toContain("Accept");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Updated 2026-06-20T00:00:00Z");
    expect(markup).toContain("Importance high");
    expect(markup).toContain("Last used 2026-06-20T01:00:00Z");
    expect(markup).toContain("Evidence run-1/thread-1/turn-1");
    expect(markup).toContain("Used 2");
    expect(markup).toContain("Keywords launch");
  });

  it("renders member context preview entrypoints for runnable office members", () => {
    const markup = renderToStaticMarkup(
      <OfficeWorkspaceView
        panel={{
          ...panel,
          workspace: {
            ...panel.workspace!,
            members: [
              {
                ...panel.workspace!.members[0],
                agentId: "agent-planner",
                runtime: {
                  contextPolicy: "sharedDigest",
                  memoryScope: "privateAndShared",
                  threadId: "planner-thread",
                },
              },
            ],
            activity: {
              runs: [
                {
                  id: "run-1",
                  status: "completed",
                  title: "Review launch context",
                  updatedAt: "2026-06-20T00:00:00Z",
                },
              ],
            },
          },
        }}
        locale="en"
        onArtifact={vi.fn()}
        onBack={vi.fn()}
        onDelegationCancel={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationRetry={vi.fn()}
        onDecision={vi.fn()}
        onMemberContextPreview={vi.fn()}
        onPanelAction={vi.fn()}
        onVerificationCancel={vi.fn()}
        onVerificationRetry={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(markup).toContain("Preview member context");
    expect(markup).toContain("sharedDigest / privateAndShared");
    expect(markup).toContain(`aria-expanded="false"`);
  });

  it("renders member memory identity for governance", () => {
    const markup = renderToStaticMarkup(
      <OfficeMemoryReviewPanel
        locale="en"
        status="pending"
        canDecide
        isLoading={false}
        nextCursor={null}
        error={null}
        pendingDecision={null}
        onDecision={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
        onStatusChange={vi.fn()}
        memories={[
          memory({
            scope: "member",
            member: "Reviewer",
            agentId: "agent-reviewer",
            kind: "preference",
            content: "Reviewer prefers reducer evidence before approval.",
          }),
        ]}
      />,
    );

    expect(markup).toContain("member");
    expect(markup).toContain("preference");
    expect(markup).toContain("Reviewer/agent-reviewer");
    expect(markup).toContain(
      "Reviewer prefers reducer evidence before approval.",
    );
  });

  it("renders accepted memory governance controls", () => {
    const markup = renderToStaticMarkup(
      <OfficeMemoryReviewPanel
        locale="en"
        status="accepted"
        canDecide
        isLoading={false}
        nextCursor={null}
        error={null}
        pendingDecision={null}
        onDecision={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
        onStatusChange={vi.fn()}
        memories={[memory({ status: "accepted" })]}
      />,
    );

    expect(markup).toContain("Use the launch checklist");
    expect(markup).toContain("Move to pending");
    expect(markup).toContain("Reject");
    expect(markup).not.toContain("Accept memory");
  });

  it("renders rejected memory governance controls", () => {
    const markup = renderToStaticMarkup(
      <OfficeMemoryReviewPanel
        locale="en"
        status="rejected"
        canDecide
        isLoading={false}
        nextCursor={null}
        error={null}
        pendingDecision={null}
        onDecision={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
        onStatusChange={vi.fn()}
        memories={[memory({ status: "rejected" })]}
      />,
    );

    expect(markup).toContain("Use the launch checklist");
    expect(markup).toContain("Move to pending");
    expect(markup).toContain("Accept");
    expect(markup).not.toContain("Reject memory");
  });

  it("renders memory pagination controls", () => {
    const markup = renderToStaticMarkup(
      <OfficeMemoryReviewPanel
        locale="en"
        status="pending"
        canDecide
        isLoading={false}
        nextCursor="24"
        error={null}
        pendingDecision={null}
        onDecision={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
        onStatusChange={vi.fn()}
        memories={[memory()]}
      />,
    );

    expect(markup).toContain("Use the launch checklist");
    expect(markup).toContain("Load more");
  });
});
