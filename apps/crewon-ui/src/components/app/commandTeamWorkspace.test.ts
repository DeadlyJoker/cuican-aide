import { describe, expect, it } from "vitest";

import {
  commandTeamWorkspaceCwdFromSearch,
  commandTeamWorkspaceUrl,
} from "./commandTeamWorkspace";

describe("command Team workspace routing", () => {
  it("uses the single-chat cwd as a backward-compatible default", () => {
    expect(
      commandTeamWorkspaceCwdFromSearch(
        "?cwd=%2Frepo%2Fsingle-chat",
        "/repo/single-chat",
      ),
    ).toBe("/repo/single-chat");
  });

  it("uses the routed single-chat cwd instead of a stale render fallback", () => {
    expect(
      commandTeamWorkspaceCwdFromSearch(
        "?cwd=%2Frepo%2Fhistory-entry",
        "/repo/stale-render",
      ),
    ).toBe("/repo/history-entry");
  });

  it("restores an independently persisted Team cwd", () => {
    expect(
      commandTeamWorkspaceCwdFromSearch(
        "?cwd=%2Frepo%2Fsingle-chat&teamCwd=%2Frepo%2Fgroup-chat",
        "/repo/single-chat",
      ),
    ).toBe("/repo/group-chat");
  });

  it("persists Team cwd without changing the single-chat cwd or active view", () => {
    const nextLocation = commandTeamWorkspaceUrl(
      "http://127.0.0.1:5175/?cwd=%2Frepo%2Fsingle-chat#view-team",
      "/repo/group-chat",
    );
    const parsed = new URL(nextLocation, "http://127.0.0.1:5175");

    expect({
      hash: parsed.hash,
      singleChatCwd: parsed.searchParams.get("cwd"),
      teamCwd: parsed.searchParams.get("teamCwd"),
    }).toMatchInlineSnapshot(`
      {
        "hash": "#view-team",
        "singleChatCwd": "/repo/single-chat",
        "teamCwd": "/repo/group-chat",
      }
    `);
  });
});
