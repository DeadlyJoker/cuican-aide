import type { Model } from "@crewon-protocol/v2/Model";
import { describe, expect, it } from "vitest";

import {
  commandComposerRuntimeSettings,
  commandModelOptionsFromModels,
  mergeCommandModelOptions,
} from "./threadRuntimeSettings";

function model(overrides: Partial<Model>): Model {
  return {
    additionalSpeedTiers: [],
    availabilityNux: null,
    defaultReasoningEffort: null,
    defaultServiceTier: null,
    description: "",
    displayName: overrides.model ?? "model",
    hidden: false,
    id: overrides.model ?? "model",
    inputModalities: [],
    isDefault: false,
    model: overrides.model ?? "model",
    serviceTiers: [],
    supportedReasoningEfforts: [],
    supportsPersonality: false,
    upgrade: null,
    upgradeInfo: null,
    ...overrides,
  } as Model;
}

describe("thread runtime settings", () => {
  it("builds concrete command model options from backend models", () => {
    expect(
      commandModelOptionsFromModels([
        model({ model: "gpt-5.5", displayName: "GPT 5.5" }),
        model({ model: "gpt-5.6-sol", displayName: "GPT 5.6 Sol", isDefault: true }),
        model({ model: "gpt-5.5", displayName: "duplicate" }),
        model({ model: "hidden-model", hidden: true }),
      ]),
    ).toEqual([
      {
        detail: "GPT 5.6 Sol",
        isDefault: true,
        label: "gpt-5.6-sol",
        value: "gpt-5.6-sol",
      },
      {
        detail: "GPT 5.5",
        isDefault: false,
        label: "gpt-5.5",
        value: "gpt-5.5",
      },
    ]);
  });

  it("keeps backend models first and adds missing newer model ids", () => {
    expect(
      mergeCommandModelOptions(
        [
          {
            isDefault: true,
            label: "gpt-5.4-mini",
            value: "gpt-5.4-mini",
          },
          { label: "gpt-5.4", value: "gpt-5.4" },
        ],
        [
          { label: "gpt-5.6-sol", value: "gpt-5.6-sol" },
          { label: "gpt-5.6", value: "gpt-5.6" },
          { label: "gpt-5.4", value: "gpt-5.4" },
        ],
      ),
    ).toEqual([
      {
        isDefault: true,
        label: "gpt-5.4-mini",
        value: "gpt-5.4-mini",
      },
      { label: "gpt-5.4", value: "gpt-5.4" },
      { label: "gpt-5.6-sol", value: "gpt-5.6-sol" },
      { label: "gpt-5.6", value: "gpt-5.6" },
    ]);
  });

  it("maps command composer permission choices to thread runtime settings", () => {
    expect(
      commandComposerRuntimeSettings({
        model: "gpt-5.6-sol",
        permission: "approve-for-me",
      }),
    ).toEqual({
      approvalPolicy: "on-failure",
      model: "gpt-5.6-sol",
      sandboxMode: "workspace-write",
    });
    expect(
      commandComposerRuntimeSettings({
        model: "gpt-5.5",
        permission: "request-approval",
      }),
    ).toEqual({
      approvalPolicy: "on-request",
      model: "gpt-5.5",
      sandboxMode: "workspace-write",
    });
    expect(
      commandComposerRuntimeSettings({
        model: "gpt-5",
        permission: "full-access",
      }),
    ).toEqual({
      approvalPolicy: "never",
      model: "gpt-5",
      sandboxMode: "danger-full-access",
    });
  });
});
