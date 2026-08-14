import { describe, expect, it, vi } from "vitest";
import type { CreateKnowledgeRequest } from "@crewon/contracts";

import { importControlKnowledgeFiles } from "./controlKnowledgeFileAttachments";

function file(
  name: string,
  content: string | Uint8Array,
  relativePath = "",
): File {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    arrayBuffer: async () => bytes.buffer,
    name,
    size: bytes.byteLength,
    webkitRelativePath: relativePath,
  } as File;
}

describe("Control Knowledge file attachments", () => {
  it("validates every file before creating immutable Knowledge", async () => {
    const createKnowledge = vi.fn(
      async (input: CreateKnowledgeRequest, _idempotencyKey: string) => ({
        disposition: "committed" as const,
        knowledge: {
          schemaVersion: "crewon.knowledge.v0" as const,
          knowledgeId:
            input.title === "README.md" ? "knowledge-1" : "knowledge-2",
          kind: input.kind,
          sourceId: input.sourceId,
          title: input.title,
          content: input.content,
          contentDigest: `sha256:${(input.title === "README.md" ? "a" : "b").repeat(64)}`,
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      }),
    );

    const result = await importControlKnowledgeFiles({
      client: { createKnowledge } as never,
      files: [file("README.md", "hello"), file("notes.txt", "world")],
      kind: "files",
      locale: "en",
    });

    expect(createKnowledge).toHaveBeenCalledTimes(2);
    expect(createKnowledge.mock.calls[0]?.[0]).toEqual({
      kind: "source",
      sourceId: expect.stringMatching(/^local-file:[a-f0-9]{64}$/u),
      title: "README.md",
      content: "hello",
    });
    expect(createKnowledge.mock.calls[1]?.[0]).toEqual({
      kind: "source",
      sourceId: expect.stringMatching(/^local-file:[a-f0-9]{64}$/u),
      title: "notes.txt",
      content: "world",
    });
    for (const [input, idempotencyKey] of createKnowledge.mock.calls) {
      expect(idempotencyKey).toBe(
        `knowledge-file:${input.sourceId.slice("local-file:".length)}`,
      );
    }
    expect(result).toEqual([
      {
        reference: {
          knowledgeId: "knowledge-1",
          contentDigest: `sha256:${"a".repeat(64)}`,
        },
        sourceId: createKnowledge.mock.calls[0]?.[0].sourceId,
        title: "README.md",
      },
      {
        reference: {
          knowledgeId: "knowledge-2",
          contentDigest: `sha256:${"b".repeat(64)}`,
        },
        sourceId: createKnowledge.mock.calls[1]?.[0].sourceId,
        title: "notes.txt",
      },
    ]);
  });

  it("preserves a folder-relative title", async () => {
    const createKnowledge = vi.fn(async (input: CreateKnowledgeRequest) => ({
      disposition: "committed" as const,
      knowledge: {
        schemaVersion: "crewon.knowledge.v0" as const,
        knowledgeId: "knowledge-folder",
        ...input,
        contentDigest: `sha256:${"c".repeat(64)}`,
        createdAt: "2026-08-14T00:00:00.000Z",
      },
    }));
    await importControlKnowledgeFiles({
      client: { createKnowledge } as never,
      files: [file("readme.md", "folder", "docs/readme.md")],
      kind: "folder",
      locale: "zh",
    });

    expect(createKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ title: "docs/readme.md" }),
      expect.stringMatching(/^knowledge-file:[a-f0-9]{64}$/u),
    );
  });

  it("rejects limits and invalid UTF-8 before any durable write", async () => {
    const createKnowledge = vi.fn();
    await expect(
      importControlKnowledgeFiles({
        client: { createKnowledge } as never,
        files: Array.from({ length: 5 }, (_, index) =>
          file(`${index}.txt`, "value"),
        ),
        kind: "files",
        locale: "en",
      }),
    ).rejects.toThrow("4 more files");
    await expect(
      importControlKnowledgeFiles({
        client: { createKnowledge } as never,
        files: [file("binary.dat", new Uint8Array([0xff]))],
        kind: "files",
        locale: "en",
      }),
    ).rejects.toThrow("UTF-8 text files");
    expect(createKnowledge).not.toHaveBeenCalled();
  });
});
