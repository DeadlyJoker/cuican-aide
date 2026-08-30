import { describe, expect, it, vi } from "vitest";

import {
  inlineLocalResourceAttachments,
  stageLocalResourceAttachments,
} from "./localResourceAttachments";

function fakeFile({
  content,
  name,
  relativePath = "",
}: {
  content: string;
  name: string;
  relativePath?: string;
}): File {
  const bytes = new TextEncoder().encode(content);
  return {
    arrayBuffer: async () => bytes.buffer,
    lastModified: 42,
    name,
    size: bytes.byteLength,
    text: async () => content,
    webkitRelativePath: relativePath,
  } as File;
}

describe("local resource attachments", () => {
  it("reads selected files directly for the TypeScript conversation runtime", async () => {
    await expect(
      inlineLocalResourceAttachments({
        batchId: "inline-1",
        files: [fakeFile({ content: "launch on Friday", name: "brief.md" })],
        kind: "files",
      }),
    ).resolves.toEqual([
      {
        content: "launch on Friday",
        name: "brief.md",
        path: "local-attachment://inline-1/brief.md",
        resourceKind: "file",
      },
    ]);
  });

  it("keeps a folder as one chip while preserving every readable file", async () => {
    const mentions = await inlineLocalResourceAttachments({
      batchId: "inline-2",
      files: [
        fakeFile({
          content: "first",
          name: "a.md",
          relativePath: "docs/a.md",
        }),
        fakeFile({
          content: "second",
          name: "b.md",
          relativePath: "docs/nested/b.md",
        }),
      ],
      kind: "folder",
    });

    expect(mentions).toEqual([
      expect.objectContaining({
        name: "docs",
        path: "local-attachment://inline-2/docs",
        resourceKind: "folder",
      }),
    ]);
    expect(mentions[0]?.content).toContain("[附件：docs/a.md]");
    expect(mentions[0]?.content).toContain("[附件：docs/nested/b.md]");
  });

  it("stages selected files in the workspace and returns file mentions", async () => {
    const createDirectory = vi.fn(async () => ({}));
    const writeFile = vi.fn(async () => ({}));

    await expect(
      stageLocalResourceAttachments({
        batchId: "batch-1",
        client: { createDirectory, writeFile },
        cwd: "/repo",
        files: [
          fakeFile({ content: "hello", name: "README.md" }),
          fakeFile({ content: "{}", name: "config.json" }),
        ],
        kind: "files",
      }),
    ).resolves.toEqual([
      {
        name: "README.md",
        path: "/repo/.crewon/attachments/batch-1/README.md",
        resourceKind: "file",
      },
      {
        name: "config.json",
        path: "/repo/.crewon/attachments/batch-1/config.json",
        resourceKind: "file",
      },
    ]);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenNthCalledWith(
      1,
      "/repo/.crewon/attachments/batch-1/README.md",
      "aGVsbG8=",
    );
  });

  it("preserves a selected folder tree and returns one folder mention", async () => {
    const createDirectory = vi.fn(async () => ({}));
    const writeFile = vi.fn(async () => ({}));

    const result = await stageLocalResourceAttachments({
      batchId: "batch-2",
      client: { createDirectory, writeFile },
      cwd: "/repo",
      files: [
        fakeFile({
          content: "a",
          name: "a.md",
          relativePath: "docs/a.md",
        }),
        fakeFile({
          content: "b",
          name: "b.md",
          relativePath: "docs/nested/b.md",
        }),
      ],
      kind: "folder",
    });

    expect(result).toEqual([
      {
        name: "docs",
        path: "/repo/.crewon/attachments/batch-2/docs",
        resourceKind: "folder",
      },
    ]);
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      "/repo/.crewon/attachments/batch-2/docs/nested/b.md",
      "Yg==",
    );
  });

  it("requires a workspace before staging browser-selected files", async () => {
    await expect(
      stageLocalResourceAttachments({
        client: {
          createDirectory: vi.fn(),
          writeFile: vi.fn(),
        },
        cwd: "",
        files: [fakeFile({ content: "hello", name: "README.md" })],
        kind: "files",
      }),
    ).rejects.toThrow("请先选择工作空间");
  });
});
