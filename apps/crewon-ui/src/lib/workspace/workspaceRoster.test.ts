import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  forgetWorkspace,
  mergeWorkspaceRoster,
  nextActiveWorkspace,
  normalizeWorkspacePath,
  readWorkspaceRoster,
  rememberWorkspace,
  writeWorkspaceRoster,
  type WorkspaceRosterEntry,
} from "./workspaceRoster";

const roster: WorkspaceRosterEntry[] = [
  { path: "/repo/api", usedAt: 300 },
  { path: "/repo/web", usedAt: 200 },
  { path: "/repo/docs", usedAt: 100 },
];

/** These tests run without a DOM, so the roster needs a storage to talk to. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("workspaceRoster", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("treats trailing separators and blanks as the same folder", () => {
    expect(normalizeWorkspacePath("  /repo/web/  ")).toBe("/repo/web");
    expect(normalizeWorkspacePath("/repo/web")).toBe("/repo/web");
    expect(normalizeWorkspacePath("   ")).toBe("");
  });

  it("removes a workspace without touching the rest of the roster", () => {
    expect(forgetWorkspace(roster, "/repo/web/")).toEqual([
      { path: "/repo/api", usedAt: 300 },
      { path: "/repo/docs", usedAt: 100 },
    ]);
  });

  it("moves a re-opened workspace to the front instead of duplicating it", () => {
    expect(rememberWorkspace(roster, "/repo/docs", 400)).toEqual([
      { path: "/repo/docs", usedAt: 400 },
      { path: "/repo/api", usedAt: 300 },
      { path: "/repo/web", usedAt: 200 },
    ]);
  });

  it("falls back to the most recent remaining workspace after a removal", () => {
    expect(nextActiveWorkspace(roster, "/repo/api")).toBe("/repo/web");
    expect(nextActiveWorkspace([{ path: "/only", usedAt: 1 }], "/only")).toBe(
      null,
    );
  });

  it("adopts folders that only conversations know about", () => {
    expect(
      mergeWorkspaceRoster(
        [{ path: "/repo/api", usedAt: 300 }],
        ["/repo/api/", "/legacy/thread", null, undefined, "   "],
        50,
      ),
    ).toEqual([
      { path: "/repo/api", usedAt: 300 },
      { path: "/legacy/thread", usedAt: 50 },
    ]);
  });

  it("round-trips the roster per account and ignores corrupt payloads", () => {
    writeWorkspaceRoster("user-1", roster);
    expect(readWorkspaceRoster("user-1")).toEqual(roster);
    expect(readWorkspaceRoster("user-2")).toEqual([]);

    localStorage.setItem("crewon:workspace-roster:user-3", "not json");
    expect(readWorkspaceRoster("user-3")).toEqual([]);

    localStorage.setItem(
      "crewon:workspace-roster:user-4",
      JSON.stringify([{ path: "" }, { path: "/kept" }, 7]),
    );
    expect(readWorkspaceRoster("user-4")).toEqual([
      { path: "/kept", usedAt: 0 },
    ]);
  });
});
