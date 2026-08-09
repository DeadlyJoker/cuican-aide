import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canPickWorkspaceFolder,
  pickWorkspaceFolder,
} from "./workspaceFolderPicker";

const open = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

function withDesktopBridge() {
  Object.defineProperty(globalThis, "isTauri", {
    configurable: true,
    value: true,
  });
}

afterEach(() => {
  delete (globalThis as { isTauri?: boolean }).isTauri;
  open.mockReset();
});

describe("pickWorkspaceFolder", () => {
  it("reports no native dialog without the desktop bridge", async () => {
    expect({
      available: canPickWorkspaceFolder(),
      picked: await pickWorkspaceFolder(),
      dialogCalls: open.mock.calls.length,
    }).toEqual({ available: false, picked: null, dialogCalls: 0 });
  });

  it("asks the host for a single directory and returns its absolute path", async () => {
    withDesktopBridge();
    open.mockResolvedValue("/Users/me/project");

    const picked = await pickWorkspaceFolder("新增空间");

    expect({ picked, options: open.mock.calls }).toEqual({
      picked: "/Users/me/project",
      options: [[{ directory: true, multiple: false, title: "新增空间" }]],
    });
  });

  it("treats a dismissed dialog and a failed one alike", async () => {
    withDesktopBridge();
    open.mockResolvedValueOnce(null);
    open.mockRejectedValueOnce(new Error("no dialog plugin"));

    expect([await pickWorkspaceFolder(), await pickWorkspaceFolder()]).toEqual([
      null,
      null,
    ]);
  });
});
