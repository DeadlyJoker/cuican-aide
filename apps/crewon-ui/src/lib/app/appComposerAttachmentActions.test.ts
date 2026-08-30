import { describe, expect, it, vi } from "vitest";

import {
  addLocalComposerResources,
  platformResourceMentionPath,
  withPlatformResourceMention,
} from "./appComposerAttachmentActions";

function textFile(name: string, content: string): File {
  const bytes = new TextEncoder().encode(content);
  return {
    arrayBuffer: async () => bytes.buffer,
    lastModified: 42,
    name,
    size: bytes.byteLength,
    text: async () => content,
    webkitRelativePath: "",
  } as File;
}

describe("composer attachment actions", () => {
  it("keeps local runtime resources out of the remote platform namespace", () => {
    expect(
      platformResourceMentionPath({
        execution: "local",
        id: -2,
        type: "mcp_servers",
      }),
    ).toBe("crewon://mcp_servers/-2");
  });

  it("adds readable files without a native server connection", async () => {
    const onStaged = vi.fn();
    const setNotice = vi.fn();

    await addLocalComposerResources({
      client: null,
      connected: false,
      cwd: "",
      files: [textFile("notes.md", "customer outcome")],
      kind: "files",
      resolveBackendCwd: async () => null,
      setNotice,
      onStaged,
    });

    expect(onStaged).toHaveBeenCalledWith([
      expect.objectContaining({
        content: "customer outcome",
        name: "notes.md",
        resourceKind: "file",
      }),
    ]);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("keeps selected Skill content on its single composer chip", () => {
    const mention = {
      content: "Check the release evidence.",
      kind: "skill" as const,
      name: "Release review",
      path: "agent-platform://skills/9",
    };

    expect(withPlatformResourceMention([], mention)).toEqual([
      {
        content: "Check the release evidence.",
        kind: "skill",
        name: "Release review",
        path: "agent-platform://skills/9",
        resourceKind: "skill",
      },
    ]);
    expect(withPlatformResourceMention(withPlatformResourceMention([], mention), mention)).toHaveLength(1);
  });
});
