import type { ActiveAgentVersionCatalogResponse } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import { controlAgentCatalogRecords } from "../office/controlAgentCatalog";
import { agentPlatformControlAgentCatalogAdapter } from "./agentPlatformControlAgentCatalog";

describe("Agent Platform Control Agent catalog", () => {
  it("shows an active cloud Agent by its platform name", () => {
    const catalog: ActiveAgentVersionCatalogResponse = {
      releaseId: "release-cloud-1",
      activatedAt: "2026-08-31T00:00:00.000Z",
      defaultAgentVersionId: "local-desktop-runtime",
      data: [
        {
          agentVersionId: "agent-platform:112:27f52cc6a239da326b364c25ddf30067",
          contentDigest: `sha256:${"a".repeat(64)}`,
          runtimeGeneration: "desktop-runtime",
          policySnapshotId: "policy-local-1",
          model: {
            adapterName: "responses",
            adapterVersion: "v1",
            modelId: "gpt-5.5",
          },
          createdAt: "2026-08-31T00:00:00.000Z",
        },
      ],
    };

    expect(
      controlAgentCatalogRecords(catalog, "zh", [
        agentPlatformControlAgentCatalogAdapter([
          { id: 112, name: "智能采购助手" },
        ]),
      ]),
    ).toMatchInlineSnapshot(`
      [
        {
          "config": {
            "accent": "violet",
            "agentId": "agent-platform:112:27f52cc6a239da326b364c25ddf30067",
            "glyph": "A",
            "mcp": [],
            "model": "gpt-5.5",
            "models": [
              "gpt-5.5",
            ],
            "name": "智能采购助手",
            "permission": "按需确认",
            "permissions": [
              "按需确认",
            ],
            "role": "云端可用 · gpt-5.5",
            "skills": [],
            "systemPrompt": "",
          },
          "filePath": "control:agent-version:agent-platform:112:27f52cc6a239da326b364c25ddf30067",
        },
      ]
    `);
  });
});
