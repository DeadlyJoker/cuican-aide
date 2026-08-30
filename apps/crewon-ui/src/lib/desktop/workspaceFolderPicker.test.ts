import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canPickWorkspaceFolder,
  pickWorkspaceFolder,
} from "./workspaceFolderPicker";

const pickDirectory = vi.fn();

function withDesktopBridge() {
  vi.stubGlobal("window", {
    crewonDesktop: { version: 1, workspace: { pickDirectory } },
    location: { search: "" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  pickDirectory.mockReset();
});

describe("pickWorkspaceFolder", () => {
  it("reports no native dialog without the desktop bridge", async () => {
    expect({
      available: canPickWorkspaceFolder(),
      picked: await pickWorkspaceFolder(),
      dialogCalls: pickDirectory.mock.calls.length,
    }).toEqual({ available: false, picked: null, dialogCalls: 0 });
  });

  it("asks the host for one directory and returns its absolute path", async () => {
    withDesktopBridge();
    pickDirectory.mockResolvedValue("/Users/me/project");

    const picked = await pickWorkspaceFolder("新增空间");

    expect({ picked, options: pickDirectory.mock.calls }).toEqual({
      picked: "/Users/me/project",
      options: [["新增空间"]],
    });
  });

  it("treats a dismissed dialog and a failed one alike", async () => {
    withDesktopBridge();
    pickDirectory.mockResolvedValueOnce(null);
    pickDirectory.mockRejectedValueOnce(new Error("no dialog"));

    expect([await pickWorkspaceFolder(), await pickWorkspaceFolder()]).toEqual([
      null,
      null,
    ]);
  });
});
