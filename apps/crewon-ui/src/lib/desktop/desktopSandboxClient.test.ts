import { describe, expect, it, vi } from "vitest";

import {
  createDesktopSandboxClient,
  type DesktopSandboxInvoke,
} from "./desktopSandboxClient";

describe("desktopSandboxClient", () => {
  it("maps every right-panel capability to the selected desktop workspace", async () => {
    const directory = {
      root: "/workspace",
      path: "/workspace/src",
      entries: [],
      truncated: false,
    };
    const file = {
      path: "/workspace/src/main.ts",
      content: "export {};\n",
      byteLength: 11,
      truncated: false,
    };
    const diff = { cwd: "/workspace", diff: "diff --git a/x b/x\n" };
    const command = {
      cwd: "/workspace",
      exitCode: 0,
      stderr: "",
      stdout: "ok\n",
    };
    const invoke = vi
      .fn<DesktopSandboxInvoke>()
      .mockResolvedValueOnce(directory)
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce(diff)
      .mockResolvedValueOnce(command);
    const client = createDesktopSandboxClient(invoke);

    await expect(
      client.listSandboxDirectory("ignored-thread", "/workspace/src"),
    ).resolves.toEqual(directory);
    await expect(
      client.readSandboxFile("ignored-thread", "/workspace/src/main.ts"),
    ).resolves.toEqual(file);
    await expect(client.readSandboxDiff("ignored-thread")).resolves.toEqual(
      diff,
    );
    await expect(
      client.runSandboxCommand("ignored-thread", {
        command: "pnpm test",
        cwd: "/workspace",
      }),
    ).resolves.toEqual(command);
    expect(invoke.mock.calls).toEqual([
      ["desktop_sandbox_list_directory", { path: "/workspace/src" }],
      ["desktop_sandbox_read_file", { path: "/workspace/src/main.ts" }],
      ["desktop_sandbox_read_diff"],
      [
        "desktop_sandbox_run_command",
        { request: { command: "pnpm test", cwd: "/workspace" } },
      ],
    ]);
  });

  it("keeps native failure codes actionable without leaking arbitrary values", async () => {
    const client = createDesktopSandboxClient(
      vi
        .fn<DesktopSandboxInvoke>()
        .mockRejectedValueOnce("desktop_sandbox_workspace_unbound")
        .mockRejectedValueOnce({ privatePath: "/Users/private/project" }),
    );

    await expect(client.readSandboxDiff(null)).rejects.toThrow(
      "desktop_sandbox_workspace_unbound",
    );
    await expect(client.readSandboxDiff(null)).rejects.toThrow(
      "desktop_sandbox_unavailable",
    );
  });
});
