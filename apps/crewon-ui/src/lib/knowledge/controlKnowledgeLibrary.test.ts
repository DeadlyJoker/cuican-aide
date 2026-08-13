import { describe, expect, it, vi } from "vitest";

import type { ControlApiClient } from "@crewon/control-client";
import type { KnowledgeView } from "@crewon/contracts";
import {
  ControlKnowledgeLibraryError,
  createControlKnowledge,
  listControlKnowledge,
  readControlKnowledge,
} from "./controlKnowledgeLibrary";

function knowledge(knowledgeId: string): KnowledgeView {
  return {
    schemaVersion: "crewon.knowledge.v0",
    knowledgeId,
    kind: "memory",
    sourceId: "thread:1",
    title: `Decision ${knowledgeId}`,
    content: "Use Control authority",
    contentDigest: `sha256:${knowledgeId}`,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("Control Knowledge library adapter", () => {
  it("loads bounded cursor pages from Control authority", async () => {
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ data: [knowledge("1")], nextCursor: "page-2" })
      .mockResolvedValueOnce({ data: [knowledge("2")], nextCursor: null });

    await expect(
      listControlKnowledge({ listKnowledge } as unknown as ControlApiClient),
    ).resolves.toEqual({
      data: [knowledge("1"), knowledge("2")],
      truncated: false,
    });
    expect(listKnowledge.mock.calls).toEqual([
      [{ limit: 100 }],
      [{ cursor: "page-2", limit: 100 }],
    ]);
  });

  it("stops safely when Control repeats a cursor", async () => {
    const listKnowledge = vi
      .fn()
      .mockResolvedValueOnce({ data: [knowledge("1")], nextCursor: "repeat" })
      .mockResolvedValueOnce({ data: [knowledge("2")], nextCursor: "repeat" });

    await expect(
      listControlKnowledge({ listKnowledge } as unknown as ControlApiClient),
    ).resolves.toEqual({
      data: [knowledge("1"), knowledge("2")],
      truncated: true,
    });
    expect(listKnowledge).toHaveBeenCalledTimes(2);
  });

  it("reads a Knowledge detail by its Control ID", async () => {
    const getKnowledge = vi.fn(async () => ({ knowledge: knowledge("1") }));

    await expect(
      readControlKnowledge(
        { getKnowledge } as unknown as ControlApiClient,
        " knowledge-1 ",
      ),
    ).resolves.toEqual(knowledge("1"));
    expect(getKnowledge).toHaveBeenCalledWith("knowledge-1");
  });

  it("creates Knowledge with caller-owned idempotency", async () => {
    const createKnowledge = vi.fn(async () => ({
      disposition: "committed" as const,
      knowledge: knowledge("1"),
    }));

    await expect(
      createControlKnowledge(
        { createKnowledge } as unknown as ControlApiClient,
        {
          kind: "memory",
          sourceId: " thread:1 ",
          title: " Decision ",
          content: " Control only ",
          idempotencyKey: " create-1 ",
        },
      ),
    ).resolves.toEqual(knowledge("1"));
    expect(createKnowledge).toHaveBeenCalledWith(
      {
        kind: "memory",
        sourceId: "thread:1",
        title: "Decision",
        content: "Control only",
      },
      "create-1",
    );
  });

  it("exposes a stable safe error without leaking backend details", async () => {
    const listKnowledge = vi.fn(async () => {
      throw new Error("postgres password=secret");
    });

    const result = listControlKnowledge({
      listKnowledge,
    } as unknown as ControlApiClient).catch((error: unknown) => error);
    await expect(result).resolves.toBeInstanceOf(ControlKnowledgeLibraryError);
    await expect(result).resolves.toMatchObject({
      message: "Control Knowledge list failed",
      operation: "list",
    });
  });
});
