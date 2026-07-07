import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type {
  ApprovalRequest,
  LibraryPanel,
  OfficeConfig,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  handleOfficeApprovalDecisionAction,
  type OfficeApprovalDecision,
} from "./officeApprovalActions";

type CapturedOfficeApprovalState = {
  ensuredThreads: number;
  lastDecision: {
    approvalId: string;
    decision: OfficeApprovalDecision;
    message: OfficeMessage;
  } | null;
  libraryPanel: LibraryPanel | null;
  notice: NoticeState | null;
};

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    actor: "Reviewer",
    glyph: "R",
    accent: "blue",
    action: "Write report",
    detail: "Draft a short report",
    risk: "medium",
    time: "now",
    ...overrides,
  };
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Coordinate work",
    threadId: "office-thread",
    backendStatus: "connected",
    members: [],
    messages: [],
    tasks: [],
    activity: {
      trace: [],
      approvals: [approval()],
      budget: [],
      budgetCapUsd: 0,
      artifacts: [],
      runs: [],
    },
    ...overrides,
  };
}

function officeConfig(workspaceConfig: OfficeWorkspace): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: workspaceConfig,
  };
}

function panel(workspaceConfig: OfficeWorkspace = workspace()): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Workspace",
    items: [],
    workspace: workspaceConfig,
  };
}

function state(initialPanel: LibraryPanel | null = panel()): CapturedOfficeApprovalState {
  return {
    ensuredThreads: 0,
    lastDecision: null,
    libraryPanel: initialPanel,
    notice: null,
  };
}

function setLibraryPanel(captured: CapturedOfficeApprovalState) {
  return (updater: (panel: LibraryPanel | null) => LibraryPanel | null) => {
    captured.libraryPanel = updater(captured.libraryPanel);
  };
}

describe("office approval actions", () => {
  it("records a local decision and notice when disconnected", async () => {
    const captured = state();
    const handled = await handleOfficeApprovalDecisionAction({
      decideOfficeApproval: async () => {
        throw new Error("unexpected backend call");
      },
      decision: "denied",
      ensureOfficeThread: async () => {
        captured.ensuredThreads += 1;
        return "office-thread";
      },
      id: "approval-1",
      isConnected: false,
      locale: "en",
      panel: captured.libraryPanel,
      setLibraryPanel: setLibraryPanel(captured),
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.ensuredThreads).toBe(0);
    expect(captured.notice).toEqual({
      text: "Denied: Reviewer · Write report",
      tone: "warning",
    });
    expect(
      captured.libraryPanel?.workspace?.activity?.approvals?.[0]?.decision,
    ).toBe("denied");
  });

  it("persists a connected decision and saves the returned config", async () => {
    const captured = state();
    const savedWorkspace = workspace({
      threadId: "saved-thread",
      messages: [
        {
          author: "System",
          glyph: "⌗",
          accent: "green",
          time: "now",
          kind: "system",
          text: "saved",
        },
      ],
    });
    const handled = await handleOfficeApprovalDecisionAction({
      decideOfficeApproval: async (
        _panel,
        _workspace,
        _threadId,
        approvalId,
        decision,
        message,
      ) => {
        captured.lastDecision = { approvalId, decision, message };
        return officeConfig(savedWorkspace);
      },
      decision: "approved",
      ensureOfficeThread: async () => {
        captured.ensuredThreads += 1;
        return "saved-thread";
      },
      id: "approval-1",
      isConnected: true,
      locale: "en",
      panel: captured.libraryPanel,
      setLibraryPanel: setLibraryPanel(captured),
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.ensuredThreads).toBe(1);
    expect(captured.lastDecision).toEqual({
      approvalId: "approval-1",
      decision: "approved",
      message: {
        author: "System",
        glyph: "⌗",
        accent: "green",
        time: "now",
        kind: "system",
        text: "Approved approval: Reviewer · Write report",
      },
    });
    expect(captured.notice).toEqual({
      text: "Approved: Reviewer · Write report",
      tone: "success",
    });
    expect(captured.libraryPanel?.workspace?.threadId).toBe("saved-thread");
    expect(captured.libraryPanel?.workspace?.messages).toEqual(
      savedWorkspace.messages,
    );
  });

  it("skips backend persistence when the approval is missing", async () => {
    const captured = state();
    const handled = await handleOfficeApprovalDecisionAction({
      decideOfficeApproval: async () => {
        throw new Error("unexpected backend call");
      },
      decision: "approved",
      ensureOfficeThread: async () => {
        captured.ensuredThreads += 1;
        return "office-thread";
      },
      id: "missing-approval",
      isConnected: true,
      locale: "en",
      panel: captured.libraryPanel,
      setLibraryPanel: setLibraryPanel(captured),
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.ensuredThreads).toBe(0);
    expect(captured.notice).toEqual({
      text: "Approved: ",
      tone: "success",
    });
  });

  it("surfaces backend failures after the optimistic update", async () => {
    const captured = state();
    const handled = await handleOfficeApprovalDecisionAction({
      decideOfficeApproval: async () => {
        throw new Error("approval failed");
      },
      decision: "approved",
      ensureOfficeThread: async () => "office-thread",
      id: "approval-1",
      isConnected: true,
      locale: "en",
      panel: captured.libraryPanel,
      setLibraryPanel: setLibraryPanel(captured),
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.notice).toEqual({
      text: "approval failed",
      tone: "warning",
    });
    expect(captured.libraryPanel?.workspace?.messages).toEqual([
      {
        author: "System",
        glyph: "⌗",
        accent: "green",
        time: "now",
        kind: "system",
        text: "Approved approval: Reviewer · Write report",
      },
    ]);
  });
});
