import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import {
  type LibraryPanel,
  type LibraryPanelAction,
  type OfficeConfig,
} from "../domain/crewonDomain";
import { handleLibraryOfficeAction } from "./libraryOfficeActions";
import { newDraftOfficeWorkspace } from "../office/officeWorkspace";

type CapturedOfficeState = {
  configCreates: Array<{
    goal: string;
    subtitle: string;
    threadId?: string | null;
    title: string;
  }>;
  configWrites: OfficeConfig[];
  libraryPanel: LibraryPanel | null;
  notice: NoticeState | null;
};

class UnsupportedRpcError extends Error {}

function panel(): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Library",
    items: [],
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    createOfficeConfig?: (
      params: {
        goal: string;
        subtitle: string;
        threadId?: string | null;
        title: string;
      },
      state: CapturedOfficeState,
    ) => Promise<{ config: OfficeConfig; filePath: string } | null>;
  } = {},
): Promise<{ handled: boolean; state: CapturedOfficeState }> {
  const state: CapturedOfficeState = {
    configCreates: [],
    configWrites: [],
    libraryPanel: panel(),
    notice: null,
  };

  const handled = await handleLibraryOfficeAction({
    action,
    createOfficeConfig: async (params) => {
      if (options.createOfficeConfig) {
        return options.createOfficeConfig(params, state);
      }
      state.configCreates.push(params);
      return {
        filePath: "/workspace/.crewon/offices/office.json",
        config: {
          title: params.title,
          subtitle: params.subtitle,
          workspace: newDraftOfficeWorkspace(params.title, "en"),
        },
      };
    },
    isUnsupportedRpcError: (error) => error instanceof UnsupportedRpcError,
    locale: "en",
    now: () => new Date("2026-06-18T14:30:00Z"),
    setLibraryPanel: ((panelOrUpdater) => {
      state.libraryPanel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(state.libraryPanel)
          : panelOrUpdater;
    }) as ((panel: LibraryPanel | null) => void) &
      ((updater: (panel: LibraryPanel | null) => LibraryPanel | null) => void),
    setNotice: (notice) => {
      state.notice = notice;
    },
    writeOfficeConfig: async (config) => {
      state.configWrites.push(config);
      return "/workspace/.crewon/offices/fallback.json";
    },
  });

  return { handled, state };
}

describe("library office actions", () => {
  it("leaves unrelated actions for the app handler", async () => {
    const { handled, state } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
    expect(state.libraryPanel).toEqual(panel());
  });

  it("creates draft office configs without starting a single-chat thread", async () => {
    const { handled, state } = await handleAction({
      id: "create-office",
      label: "Create office",
    });

    expect(handled).toBe(true);
    expect(state.configCreates).toEqual([
      {
        goal: expect.stringContaining("Coordinate multi-agent work"),
        subtitle: "New office · configuration stage",
        threadId: null,
        title: expect.stringContaining("New office"),
      },
    ]);
    expect(state.configWrites).toEqual([]);
    expect(state.libraryPanel).toMatchObject({
      kind: "office",
      subtitle: "New office · configuration stage",
      body: "Backend record: /workspace/.crewon/offices/office.json",
      workspace: {
        backendStatus: "local",
        members: [expect.objectContaining({ name: "Coordinator" })],
      },
    });
    expect(state.libraryPanel?.workspace?.threadId).toBeUndefined();
  });

  it("falls back to legacy config writes when office create is unsupported", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-office",
        label: "Create office",
      },
      {
        createOfficeConfig: async (params, currentState) => {
          currentState.configCreates.push(params);
          throw new UnsupportedRpcError("unsupported");
        },
      },
    );

    expect(handled).toBe(true);
    expect(state.configWrites.map((config) => config.workspace.threadId)).toEqual([
      undefined,
    ]);
    expect(state.libraryPanel?.body).toBe(
      "Backend record: /workspace/.crewon/offices/fallback.json",
    );
  });

  it("shows a failure panel and notice when office config creation fails", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-office",
        label: "Create office",
      },
      {
        createOfficeConfig: async () => {
          throw new Error("Unable to create office config");
        },
      },
    );

    expect(handled).toBe(true);
    expect(state.notice).toEqual({
      text: "Unable to create office config",
      tone: "warning",
    });
    expect(state.libraryPanel?.error).toBe(state.notice?.text);
    expect(state.configWrites).toEqual([]);
  });
});
