import { describe, expect, it } from "vitest";

import {
  isPlaceholderBackendCwd,
  preferredBackendCwd,
} from "./workspaceCwd";

describe("workspace cwd helpers", () => {
  it("identifies placeholder demo cwd values", () => {
    expect(isPlaceholderBackendCwd("/Users/me/work/crewon")).toBe(true);
    expect(isPlaceholderBackendCwd("/repo")).toBe(false);
    expect(isPlaceholderBackendCwd("")).toBe(false);
    expect(isPlaceholderBackendCwd(null)).toBe(false);
  });

  it("prefers a real current cwd over backend thread cwd values", () => {
    expect(
      preferredBackendCwd(" /repo/current ", [{ cwd: "/repo/other" }]),
    ).toBe("/repo/current");
  });

  it("falls back to the first real backend thread cwd", () => {
    expect(
      preferredBackendCwd("/Users/me/work/crewon", [
        { cwd: "/Users/me/demo" },
        { cwd: "/repo/backend" },
      ]),
    ).toBe("/repo/backend");
  });
});
