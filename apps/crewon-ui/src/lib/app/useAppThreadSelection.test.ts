import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import { selectedThreadWorkspaceCwd } from "./useAppThreadSelection";

describe("selectedThreadWorkspaceCwd", () => {
  it("keeps workspace-less selected threads out of the draft workspace", () => {
    expect(
      selectedThreadWorkspaceCwd({
        draftWorkspaceCwd: "/repo/frontend",
        selectedThread: { cwd: null } as unknown as Thread,
        threads: [{ cwd: "/repo/backend" } as unknown as Thread],
      }),
    ).toBe("");
  });

  it("uses the draft workspace only for new conversations", () => {
    expect(
      selectedThreadWorkspaceCwd({
        draftWorkspaceCwd: "/repo/frontend",
        selectedThread: null,
        threads: [],
      }),
    ).toBe("/repo/frontend");
  });

  it("keeps an explicit draft workspace when other workspaces have history", () => {
    expect(
      selectedThreadWorkspaceCwd({
        draftWorkspaceCwd: "/repo/frontend",
        selectedThread: null,
        threads: [{ cwd: "/repo/backend" } as unknown as Thread],
      }),
    ).toBe("/repo/frontend");
  });

  it("keeps an explicitly workspace-less draft unbound", () => {
    expect(
      selectedThreadWorkspaceCwd({
        draftWorkspaceCwd: null,
        selectedThread: null,
        threads: [{ cwd: "/repo/backend" } as unknown as Thread],
      }),
    ).toBe("");
  });
});
