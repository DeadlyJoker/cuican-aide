import { describe, expect, it } from "vitest";

import {
  joinPath,
  pathBaseName,
  pathDirName,
  resolveSearchPath,
} from "./pathUtils";

describe("path utils", () => {
  it("joins unix and windows paths with the existing separator", () => {
    expect(joinPath("/tmp/work/", "file.txt")).toBe("/tmp/work/file.txt");
    expect(joinPath("C:\\work\\", "file.txt")).toBe("C:\\work\\file.txt");
  });

  it("keeps absolute search paths and resolves relative paths", () => {
    expect(resolveSearchPath("/repo", "/var/log/app.log")).toBe("/var/log/app.log");
    expect(resolveSearchPath("C:\\repo", "C:\\logs\\app.log")).toBe(
      "C:\\logs\\app.log",
    );
    expect(resolveSearchPath("/repo", "src/App.tsx")).toBe("/repo/src/App.tsx");
  });

  it("extracts basename and dirname across separators", () => {
    expect(pathBaseName("/repo/src/App.tsx")).toBe("App.tsx");
    expect(pathBaseName("C:\\repo\\src\\App.tsx")).toBe("App.tsx");
    expect(pathDirName("/repo/src/App.tsx")).toBe("/repo/src");
    expect(pathDirName("C:\\repo\\src\\App.tsx")).toBe("C:\\repo\\src");
  });
});
