import { describe, expect, it, vi } from "vitest";

import {
  controlBrowserSettingsPanel,
  readControlBrowserSettingsPanel,
} from "./controlBrowserSettings";

const RELEASE_ID = `sha256:${"a".repeat(64)}`;
const ACTIVATED_AT = "2026-08-19T00:00:00Z";

describe("Control Browser settings", () => {
  it("reads bounded pages and projects only Web capability status", async () => {
    const listActiveCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        activatedAt: ACTIVATED_AT,
        data: [capability("read_file")],
        nextCursor: "page-2",
        releaseId: RELEASE_ID,
      })
      .mockResolvedValueOnce({
        activatedAt: ACTIVATED_AT,
        data: [capability("web_search")],
        nextCursor: null,
        releaseId: RELEASE_ID,
      });

    const panel = await readControlBrowserSettingsPanel(
      { listActiveCapabilities },
      "en",
    );

    expect(listActiveCapabilities.mock.calls).toEqual([
      [{ cursor: null, limit: 100 }],
      [{ cursor: "page-2", limit: 100 }],
    ]);
    expect(panel).toEqual(
      controlBrowserSettingsPanel(
        { activatedAt: ACTIVATED_AT, releaseId: RELEASE_ID },
        [capability("read_file"), capability("web_search")],
        "en",
      ),
    );
    expect(panel.body).toContain("web_search");
    expect(panel.body).not.toContain("read_file");
  });

  it("fails closed when the active release changes between pages", async () => {
    const listActiveCapabilities = vi
      .fn()
      .mockResolvedValueOnce({
        activatedAt: ACTIVATED_AT,
        data: [],
        nextCursor: "page-2",
        releaseId: RELEASE_ID,
      })
      .mockResolvedValueOnce({
        activatedAt: ACTIVATED_AT,
        data: [],
        nextCursor: null,
        releaseId: `sha256:${"b".repeat(64)}`,
      });

    await expect(
      readControlBrowserSettingsPanel({ listActiveCapabilities }, "en"),
    ).rejects.toThrow("capability_catalog_changed");
  });
});

function capability(name: string) {
  return {
    agentVersionDigest: `sha256:${"b".repeat(64)}`,
    agentVersionId: "agent-version-1",
    description: `${name} description`,
    execution: "parallel" as const,
    inputFormat: "jsonSchema" as const,
    kind: "function" as const,
    name,
  };
}
