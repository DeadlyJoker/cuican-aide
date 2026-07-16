import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import { handleLibraryOfficeAction } from "./libraryOfficeActions";

type CapturedOfficeState = {
  libraryPanel: LibraryPanel | null;
  notice: NoticeState | null;
};

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
): Promise<{ handled: boolean; state: CapturedOfficeState }> {
  const state: CapturedOfficeState = {
    libraryPanel: panel(),
    notice: null,
  };

  const handled = await handleLibraryOfficeAction({
    action,
    locale: "en",
    setNotice: (notice) => {
      state.notice = notice;
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

  it("blocks the removed quick-create flow and points users to Team", async () => {
    const { handled, state } = await handleAction({
      id: "create-office",
      label: "Create office",
    });

    expect(handled).toBe(true);
    expect(state.libraryPanel).toEqual(panel());
    expect(state.notice).toEqual({
      text: "Create the Office from Team with a real name, goal, and members; legacy quick-create is disabled.",
      tone: "warning",
    });
  });
});
