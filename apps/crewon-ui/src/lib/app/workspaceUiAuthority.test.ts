import { describe, expect, it, vi } from "vitest";

import {
  isLegacyWorkspacePanelItem,
  workspaceCapabilityHandlersForAuthority,
  workspaceCwdForAuthority,
} from "./workspaceUiAuthority";

describe("Workspace UI authority", () => {
  it("never reaches legacy AppServer workspace actions in Control mode", async () => {
    const legacy = {
      attachWorkspaceContext: vi.fn(async () => undefined),
      readWorkspaceDiff: vi.fn(async () => undefined),
      readWorkspaceFiles: vi.fn(async () => undefined),
    };
    const control = {
      attachWorkspaceContext: vi.fn(async () => undefined),
      readWorkspaceDiff: vi.fn(async () => undefined),
      readWorkspaceFiles: vi.fn(async () => undefined),
    };
    const handlers = workspaceCapabilityHandlersForAuthority({
      authority: "control",
      control,
      legacy,
    });

    await handlers.readWorkspaceFiles();
    await handlers.readWorkspaceDiff();
    await handlers.attachWorkspaceContext("/Users/private/control-secret");

    expect({
      legacyCalls: {
        attach: legacy.attachWorkspaceContext.mock.calls,
        diff: legacy.readWorkspaceDiff.mock.calls,
        files: legacy.readWorkspaceFiles.mock.calls,
      },
      controlCalls: {
        attach: control.attachWorkspaceContext.mock.calls,
        diff: control.readWorkspaceDiff.mock.calls,
        files: control.readWorkspaceFiles.mock.calls,
      },
      cwd: workspaceCwdForAuthority("control", "/Users/private/control-secret"),
    }).toEqual({
      legacyCalls: { attach: [], diff: [], files: [] },
      controlCalls: {
        attach: [["/Users/private/control-secret"]],
        diff: [[]],
        files: [[]],
      },
      cwd: null,
    });
  });

  it("preserves the legacy cohort and only identifies path-backed panel items", async () => {
    const legacy = {
      attachWorkspaceContext: vi.fn(async () => undefined),
      readWorkspaceDiff: vi.fn(async () => undefined),
      readWorkspaceFiles: vi.fn(async () => undefined),
    };
    const handlers = workspaceCapabilityHandlersForAuthority({
      authority: "legacy",
      control: legacy,
      legacy,
    });

    await handlers.readWorkspaceFiles();
    await handlers.readWorkspaceDiff();
    await handlers.attachWorkspaceContext("/repo/project");

    expect({
      legacyCalls: {
        attach: legacy.attachWorkspaceContext.mock.calls,
        diff: legacy.readWorkspaceDiff.mock.calls,
        files: legacy.readWorkspaceFiles.mock.calls,
      },
      cwd: workspaceCwdForAuthority("legacy", " /repo/project "),
      panelItems: [
        isLegacyWorkspacePanelItem({ kind: "directory", path: "/repo" }),
        isLegacyWorkspacePanelItem({
          intent: "attach-context",
          kind: "file",
          path: "/repo/file.ts",
        }),
        isLegacyWorkspacePanelItem({
          action: { type: "plugin" },
          path: "/plugin/readme",
        }),
      ],
    }).toEqual({
      legacyCalls: {
        attach: [["/repo/project"]],
        diff: [[]],
        files: [[]],
      },
      cwd: "/repo/project",
      panelItems: [true, true, false],
    });
  });
});
