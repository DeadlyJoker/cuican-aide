import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  OfficeComposer,
  insertOfficeAttachmentReference,
  insertOfficeMemberMention,
  insertOfficeSlashCommand,
  officeComposerCopy,
  officeComposerInputState,
  officePendingDeliveryCopy,
} from "./OfficeComposer";

const members = [
  {
    agentId: "planner",
    memberId: "member-planner",
    name: "Planner",
    role: "Lead",
    glyph: "P",
    accent: "blue" as const,
    status: "online",
  },
  {
    agentId: "reviewer",
    memberId: "member-reviewer",
    name: "Reviewer",
    role: "Quality",
    glyph: "R",
    accent: "green" as const,
    status: "offline",
  },
];
const slashCommands = [
  {
    id: "skill:review",
    kind: "skill" as const,
    label: "Review",
    meta: "Skill",
    description: "Review the current change",
    token: "$review",
    mention: { kind: "skill" as const, name: "Review", path: "/skills/review" },
  },
  {
    id: "mcp:files",
    kind: "mcp" as const,
    label: "Filesystem",
    meta: "MCP",
    description: "Read workspace files",
    token: "$filesystem",
    mention: { name: "Filesystem", path: "mcp://filesystem" },
  },
];

describe("OfficeComposer", () => {
  it("keeps only attachment visible while exposing real member and slash palettes", () => {
    const markup = renderToStaticMarkup(
      <OfficeComposer
        draft=""
        isSubmitting={false}
        isStopping={false}
        locale="en"
        members={members}
        onAttachContext={vi.fn()}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        pendingDelivery={null}
        runtimeMode="idle"
        slashCommands={slashCommands}
      />,
    );

    expect(markup).toContain("Planner");
    expect(markup).toContain("Reviewer");
    expect(markup).toContain(
      'class="command-input office-global-composer office-shared-composer"',
    );
    expect(markup).toContain('data-command-composer="true"');
    expect(markup).toContain('aria-label="Add attachment"');
    expect(markup).toContain("Review the current change");
    expect(markup).toContain("Read workspace files");
    expect(markup).not.toContain("workspace-dropdown");
    expect(markup).not.toContain("model-dropdown");
    expect(markup).not.toContain("permission-dropdown");
    expect(markup).toContain(
      "Office manager receives messages without @ · type @ for members or / for Skill and MCP",
    );
  });

  it("shows duplicate member labels as distinct structured mention targets", () => {
    const duplicateMembers = [
      {
        ...members[0],
        memberId: "member-alex-reviewer",
        name: "Alex",
        role: "Reviewer",
      },
      {
        ...members[1],
        memberId: "member-alex-builder",
        name: "Alex",
        role: "Builder",
      },
    ];
    const markup = renderToStaticMarkup(
      <OfficeComposer
        draft=""
        isSubmitting={false}
        isStopping={false}
        locale="en"
        members={duplicateMembers}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        pendingDelivery={null}
        runtimeMode="idle"
      />,
    );

    expect(markup).toContain('title="@Alex（Reviewer）"');
    expect(markup).toContain('title="@Alex（Builder）"');
  });

  it("makes directed routing explicit without turning the message private", () => {
    const markup = renderToStaticMarkup(
      <OfficeComposer
        draft="@Reviewer check the boundary"
        isSubmitting={false}
        isStopping={false}
        locale="en"
        members={members}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        pendingDelivery={null}
        runtimeMode="idle"
      />,
    );

    expect(markup).toContain("Visible to the room · directed to @Reviewer");
    expect(markup).not.toContain("office-composer-target-control");
  });

  it("inserts a selected member at the current selection", () => {
    expect(insertOfficeMemberMention("请先检查", "Reviewer", 2, 2)).toEqual({
      caret: 13,
      value: "请先 @Reviewer 检查",
    });
  });

  it("inserts slash capabilities and attachment references at the caret", () => {
    expect(insertOfficeSlashCommand("请先检查", "$review", 2, 2)).toEqual({
      caret: 12,
      value: "请先 /$review 检查",
    });
    expect(
      insertOfficeAttachmentReference("请检查", "/repo/README.md", 1, 1),
    ).toEqual({
      caret: 21,
      value: "请 附件：/repo/README.md 检查",
    });
  });

  it("keeps add-requirement send and whole-run stop as separate actions", () => {
    const markup = renderToStaticMarkup(
      <OfficeComposer
        draft="Continue with the evidence"
        isSubmitting={false}
        isStopping={false}
        locale="en"
        members={members}
        onDraftChange={vi.fn()}
        onStop={vi.fn()}
        onSubmit={vi.fn()}
        pendingDelivery={null}
        runtimeMode="managerActive"
      />,
    );

    expect(markup).toContain("Add requirement");
    expect(markup).toContain("Stop current Office run");
    expect(markup).toContain("Manager running · send adds a requirement");
    expect(markup).toContain('data-runtime-mode="managerActive"');
  });

  it("keeps a queued receipt read-only and retryable with the same draft", () => {
    const markup = renderToStaticMarkup(
      <OfficeComposer
        draft="Continue with the evidence"
        isSubmitting={false}
        isStopping={false}
        locale="en"
        members={members}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        pendingDelivery={{
          type: "queued",
          afterRunId: "run-active",
          position: 2,
        }}
        runtimeMode="queued"
      />,
    );

    expect(markup).toContain("Retry queued message");
    expect(markup).toContain("Queued · position 2 · same receipt retained");
    expect(markup).toContain('readOnly=""');
    expect(markup).not.toContain("Stop current Office run");
  });

  it("keeps an oversized UTF-8 draft editable while blocking submit", () => {
    const markup = renderToStaticMarkup(
      <OfficeComposer
        draft={"验".repeat(301)}
        isSubmitting={false}
        isStopping={false}
        locale="zh"
        members={members}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        pendingDelivery={null}
        runtimeMode="idle"
      />,
    );

    const textarea = markup.match(/<textarea[^>]*>/)?.[0] ?? "";
    expect(textarea).toContain('aria-invalid="true"');
    expect(textarea).not.toContain("disabled");
    expect(markup).toContain("消息超过 900 字节，请缩短后发送");
    expect(markup).toContain("903/900 字节");
  });

  it("snapshots the visible runtime-state contract", () => {
    expect({
      managerConversationActive: officeComposerCopy(
        "managerConversationActive",
        "en",
      ),
      managerActive: officeComposerCopy("managerActive", "en"),
      oversizedInput: officeComposerInputState("验".repeat(301), "en"),
      processingReceipt: officePendingDeliveryCopy(
        { type: "processing", phase: "recovering", retryAfterMs: 250 },
        "en",
      ),
      queuedReceipt: officePendingDeliveryCopy(
        { type: "queued", afterRunId: "run-active", position: 2 },
        "en",
      ),
      childActive: officeComposerCopy("childActive", "en"),
      canceling: officeComposerCopy("canceling", "en"),
      queued: officeComposerCopy("queued", "en"),
    }).toMatchInlineSnapshot(`
      {
        "canceling": {
          "placeholder": "The current task is stopping; new messages will queue safely…",
          "sendLabel": "Queue message",
          "status": "Stopping · new messages will be queued",
        },
        "childActive": {
          "placeholder": "Send context to the manager to queue safely around member work…",
          "sendLabel": "Send to manager",
          "status": "Members running · the manager will queue new messages",
        },
        "managerActive": {
          "placeholder": "Add a requirement for the manager's current task…",
          "sendLabel": "Add requirement",
          "status": "Manager running · send adds a requirement",
        },
        "managerConversationActive": {
          "placeholder": "Continue the conversation; explicit work upgrades it to a task…",
          "sendLabel": "Continue chat",
          "status": "Manager replying · chat stays conversational until work is explicit",
        },
        "oversizedInput": {
          "bytes": 903,
          "counter": "903/900 bytes",
          "overLimit": true,
          "status": "Message exceeds 900 bytes; shorten it before sending",
        },
        "processingReceipt": {
          "placeholder": "Message processing; send again to query and retry the same receipt…",
          "sendLabel": "Retry processing message",
          "status": "Processing · recovering · same receipt retained",
        },
        "queued": {
          "placeholder": "Work is already in progress; the server will queue this in order…",
          "sendLabel": "Queue next",
          "status": "Work queued · the server owns the next action",
        },
        "queuedReceipt": {
          "placeholder": "Message queued; send again to retry the same receipt…",
          "sendLabel": "Retry queued message",
          "status": "Queued · position 2 · same receipt retained",
        },
      }
    `);
  });
});
