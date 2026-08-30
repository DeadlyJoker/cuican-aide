import type { ActiveAgentVersionCatalogResponse } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import { controlCommandModelOptionsFromCatalog } from "./useAppCommandModelOptions";

describe("Control command model options", () => {
  it("exposes the default and its active model variants, not unrelated Agents", () => {
    const catalog = {
      releaseId: `sha256:${"a".repeat(64)}`,
      activatedAt: "2026-08-23T00:00:00.000Z",
      defaultAgentVersionId: "agent-default",
      data: [
        {
          agentVersionId: "agent-other",
          contentDigest: `sha256:${"b".repeat(64)}`,
          runtimeGeneration: "ts-v0",
          policySnapshotId: "policy-other",
          model: {
            adapterName: "responses-http",
            adapterVersion: "1",
            modelId: "other-model",
          },
          createdAt: "2026-08-23T00:00:00.000Z",
        },
        {
          agentVersionId: "agent-default",
          contentDigest: `sha256:${"c".repeat(64)}`,
          runtimeGeneration: "ts-v0",
          policySnapshotId: "policy-default",
          model: {
            adapterName: "responses-http",
            adapterVersion: "1",
            modelId: "default-model",
          },
          createdAt: "2026-08-23T00:00:00.000Z",
        },
        {
          agentVersionId: "agent-default:model-0123456789abcdef01234567",
          contentDigest: `sha256:${"d".repeat(64)}`,
          runtimeGeneration: "ts-v0",
          policySnapshotId: "policy-default",
          model: {
            adapterName: "responses-http",
            adapterVersion: "1",
            modelId: "alternate-model",
          },
          createdAt: "2026-08-23T00:00:00.000Z",
        },
      ],
    } satisfies ActiveAgentVersionCatalogResponse;

    expect(controlCommandModelOptionsFromCatalog(catalog)).toEqual([
      {
        isDefault: true,
        label: "default-model",
        value: "default-model",
      },
      {
        isDefault: false,
        label: "alternate-model",
        value: "alternate-model",
      },
    ]);
  });
});
