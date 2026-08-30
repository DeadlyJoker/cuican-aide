import { describe, expect, it } from "vitest";

import { draftWorkspaceCwdFromSearch } from "./useAppDraftWorkspaceState";

describe("draft workspace state", () => {
  it("restores an explicit workspace from the URL", () => {
    expect(
      draftWorkspaceCwdFromSearch(
        "?cwd=%2FUsers%2Fme%2Fprojects%2Fcrewon&view=office",
      ),
    ).toBe("/Users/me/projects/crewon");
  });

  it("leaves selection automatic when the URL has no workspace", () => {
    expect(draftWorkspaceCwdFromSearch("?view=office")).toBeUndefined();
  });

  it("restores an explicitly workspace-less draft", () => {
    expect(draftWorkspaceCwdFromSearch("?cwd=")).toBeNull();
    expect(draftWorkspaceCwdFromSearch("?cwd=%20%20")).toBeNull();
  });
});
