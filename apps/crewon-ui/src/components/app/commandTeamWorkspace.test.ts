import { describe, expect, it } from "vitest";

import {
  commandTeamWorkspaceUrlWithoutLegacyCwd,
  legacyCommandTeamWorkspaceCwdFromSearch,
} from "./commandTeamWorkspace";

describe("command Team workspace routing", () => {
  it("reads the workspace an old link pinned to the Team page", () => {
    expect(
      legacyCommandTeamWorkspaceCwdFromSearch(
        "?cwd=%2Frepo%2Fsingle-chat&teamCwd=%2Frepo%2Fgroup-chat",
      ),
    ).toBe("/repo/group-chat");
  });

  it("reports no legacy workspace when a link only carries the sidebar cwd", () => {
    expect(
      legacyCommandTeamWorkspaceCwdFromSearch("?cwd=%2Frepo%2Fsingle-chat"),
    ).toBe("");
  });

  it("drops the legacy parameter without touching the cwd or active view", () => {
    const nextLocation = commandTeamWorkspaceUrlWithoutLegacyCwd(
      "http://127.0.0.1:5175/?cwd=%2Frepo%2Fsingle-chat&teamCwd=%2Frepo%2Fgroup-chat#view-team",
    );
    const parsed = new URL(nextLocation, "http://127.0.0.1:5175");

    expect({
      hash: parsed.hash,
      cwd: parsed.searchParams.get("cwd"),
      teamCwd: parsed.searchParams.get("teamCwd"),
    }).toMatchInlineSnapshot(`
      {
        "cwd": "/repo/single-chat",
        "hash": "#view-team",
        "teamCwd": null,
      }
    `);
  });
});
