import type { ActiveAgentVersionCatalogResponse } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import {
  controlAgentVersionForModel,
  controlDefaultModelVersions,
  isControlModelVariant,
} from "./controlModelCatalog";

const catalog: ActiveAgentVersionCatalogResponse = {
  releaseId: `sha256:${"a".repeat(64)}`,
  activatedAt: "2026-08-29T00:00:00.000Z",
  defaultAgentVersionId: "agent-default",
  data: [
    version("agent-other", "other-model", "other-policy"),
    version("agent-default", "default-model"),
    version("agent-default:model-0123456789abcdef01234567", "alternate-model"),
    version("agent-default:model-not-a-release-hash", "forged-model"),
  ],
};

describe("Control model catalog", () => {
  it("keeps only structurally pinned variants in provider order", () => {
    expect(
      controlDefaultModelVersions(catalog).map(({ agentVersionId, model }) => [
        agentVersionId,
        model.modelId,
      ]),
    ).toEqual([
      ["agent-default", "default-model"],
      ["agent-default:model-0123456789abcdef01234567", "alternate-model"],
    ]);
  });

  it("routes model selection to one exact immutable AgentVersion", () => {
    expect(
      controlAgentVersionForModel(catalog, "alternate-model").agentVersionId,
    ).toBe("agent-default:model-0123456789abcdef01234567");
    expect(controlAgentVersionForModel(catalog, null).agentVersionId).toBe(
      "agent-default",
    );
    expect(() => controlAgentVersionForModel(catalog, "forged-model")).toThrow(
      "control_model_selection_mismatch",
    );
  });

  it("does not classify unrelated or forged AgentVersions as model variants", () => {
    expect(isControlModelVariant(catalog, catalog.data[0]!)).toBe(false);
    expect(isControlModelVariant(catalog, catalog.data[2]!)).toBe(true);
    expect(isControlModelVariant(catalog, catalog.data[3]!)).toBe(false);
  });
});

function version(
  agentVersionId: string,
  modelId: string,
  policySnapshotId = "policy-default",
) {
  return {
    agentVersionId,
    contentDigest: `sha256:${"b".repeat(64)}`,
    runtimeGeneration: "ts-v0",
    policySnapshotId,
    model: {
      adapterName: "responses-http",
      adapterVersion: "1",
      modelId,
    },
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}
