import type { ActiveAgentVersionCatalogResponse } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import {
  controlAgentCatalogRecords,
  type ControlAgentCatalogAdapter,
} from "./controlAgentCatalog";

const localCatalog: ActiveAgentVersionCatalogResponse = {
  releaseId: "release-local-1",
  activatedAt: "2026-08-29T00:00:00.000Z",
  defaultAgentVersionId: "local-web-a1b2c3",
  data: [
    {
      agentVersionId: "local-web-a1b2c3",
      contentDigest: `sha256:${"a".repeat(64)}`,
      runtimeGeneration: "web-runtime-a1b2c3",
      policySnapshotId: "policy-local-1",
      model: {
        adapterName: "responses",
        adapterVersion: "v1",
        modelId: "gpt-5.5",
      },
      createdAt: "2026-08-29T00:00:00.000Z",
    },
    {
      agentVersionId: "local-web-a1b2c3:model-0123456789abcdef01234567",
      contentDigest: `sha256:${"b".repeat(64)}`,
      runtimeGeneration: "web-runtime-a1b2c3",
      policySnapshotId: "policy-local-1",
      model: {
        adapterName: "responses",
        adapterVersion: "v1",
        modelId: "gpt-5.6-sol",
      },
      createdAt: "2026-08-29T00:00:00.000Z",
    },
  ],
};

describe("Control Agent catalog", () => {
  it("presents the active Agent without leaking model variants as Agents", () => {
    expect(controlAgentCatalogRecords(localCatalog, "zh"))
      .toMatchInlineSnapshot(`
        [
          {
            "config": {
              "accent": "cyan",
              "agentId": "local-web-a1b2c3",
              "glyph": "L",
              "mcp": [],
              "model": "gpt-5.5",
              "models": [
                "gpt-5.5",
              ],
              "name": "本地执行智能体",
              "permission": "按需确认",
              "permissions": [
                "按需确认",
              ],
              "role": "本地可用 · gpt-5.5",
              "skills": [],
              "systemPrompt": "",
            },
            "filePath": "control:agent-version:local-web-a1b2c3",
          },
        ]
      `);
  });

  it("lets connectors customize presentation without replacing runtime truth", () => {
    const connector: ControlAgentCatalogAdapter = {
      id: "crm-provider",
      matches: () => true,
      presentation: () => ({
        accent: "violet",
        glyph: "C",
        name: "CRM Agent",
        role: "Connected through CRM provider",
      }),
    };

    const [record] = controlAgentCatalogRecords(localCatalog, "en", [
      connector,
    ]);

    expect(record).toEqual(
      expect.objectContaining({
        filePath: "control:agent-version:local-web-a1b2c3",
        config: expect.objectContaining({
          agentId: "local-web-a1b2c3",
          model: "gpt-5.5",
          name: "CRM Agent",
        }),
      }),
    );
  });

  it("rejects ambiguous connector registrations", () => {
    const connector: ControlAgentCatalogAdapter = {
      id: "duplicate",
      matches: () => false,
      presentation: () => ({
        accent: "cyan",
        glyph: "A",
        name: "unused",
        role: "unused",
      }),
    };

    expect(() =>
      controlAgentCatalogRecords(localCatalog, "en", [connector, connector]),
    ).toThrowError("control_agent_catalog_adapter_invalid");
  });
});
