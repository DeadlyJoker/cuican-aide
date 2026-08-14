import { describe, expect, it } from "vitest";

import {
  authorizedControlCommandCatalog,
  controlCommandCatalog,
} from "./useControlCommandCatalog";

describe("Control command catalog", () => {
  it("exposes only active Agent versions and their exact bound models", () => {
    const catalog = controlCommandCatalog(
      [
        {
          agentVersionId: "agent-version-default",
          contentDigest: "sha256:default",
          runtimeGeneration: "ts-v0",
          policySnapshotId: "policy-default",
          model: {
            adapterName: "responses-http",
            adapterVersion: "1",
            modelId: "gpt-control-default",
          },
          createdAt: "2026-08-13T00:00:00.000Z",
        },
        {
          agentVersionId: "agent-version-review",
          contentDigest: "sha256:review",
          runtimeGeneration: "ts-v0",
          policySnapshotId: "policy-review",
          model: {
            adapterName: "responses-http",
            adapterVersion: "1",
            modelId: "gpt-control-review",
          },
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      "agent-version-default",
    );

    expect(catalog).toEqual({
      modelOptionsByTarget: {
        "crewon": [
          {
            detail: "responses-http",
            isDefault: true,
            label: "gpt-control-default",
            value: "gpt-control-default",
          },
        ],
        "agent:agent-version-default": [
          {
            detail: "responses-http",
            isDefault: false,
            label: "gpt-control-default",
            value: "gpt-control-default",
          },
        ],
        "agent:agent-version-review": [
          {
            detail: "responses-http",
            isDefault: false,
            label: "gpt-control-review",
            value: "gpt-control-review",
          },
        ],
      },
      targets: [
        {
          detail: "Control · gpt-control-default",
          kind: "crewon",
          label: "CrewON · 单 Agent",
          strategy: "single",
          value: "crewon",
        },
        {
          detail: "agent-version-default · gpt-control-default",
          group: "single",
          kind: "agent",
          label: "agent-version-default",
          strategy: "single",
          value: "agent:agent-version-default",
        },
        {
          detail: "agent-version-review · gpt-control-review",
          group: "single",
          kind: "agent",
          label: "agent-version-review",
          strategy: "single",
          value: "agent:agent-version-review",
        },
      ],
    });
  });

  it("fails closed when the release has no exact default Agent version", () => {
    expect(controlCommandCatalog([], "missing")).toEqual({
      modelOptionsByTarget: {},
      targets: [],
    });
  });

  it("fails closed when the active release contains duplicate Agent version identities", () => {
    const version = {
      agentVersionId: "agent-version-duplicate",
      contentDigest: "sha256:duplicate",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy-duplicate",
      model: {
        adapterName: "responses-http",
        adapterVersion: "1",
        modelId: "gpt-control-duplicate",
      },
      createdAt: "2026-08-13T00:00:00.000Z",
    };

    expect(
      controlCommandCatalog(
        [version, { ...version, contentDigest: "sha256:other" }],
        version.agentVersionId,
      ),
    ).toEqual({ modelOptionsByTarget: {}, targets: [] });
  });

  it("does not expose active versions when runtime provider authorization is unavailable", () => {
    const agentVersions = [
      {
        agentVersionId: "agent-version-active",
        contentDigest: "sha256:active",
        runtimeGeneration: "ts-v0",
        policySnapshotId: "policy-active",
        model: {
          adapterName: "responses-http",
          adapterVersion: "1",
          modelId: "gpt-control-active",
        },
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    ];

    expect(
      authorizedControlCommandCatalog({
        activeProviderAuthorized: false,
        agentVersions,
        defaultAgentVersionId: "agent-version-active",
        runtimeAvailable: true,
      }),
    ).toEqual({ modelOptionsByTarget: {}, targets: [] });
    expect(
      authorizedControlCommandCatalog({
        activeProviderAuthorized: true,
        agentVersions,
        defaultAgentVersionId: "agent-version-active",
        runtimeAvailable: false,
      }),
    ).toEqual({ modelOptionsByTarget: {}, targets: [] });
  });
});
