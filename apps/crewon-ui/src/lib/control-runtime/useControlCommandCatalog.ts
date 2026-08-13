import { useEffect, useState } from "react";
import type { AgentVersionView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import type { ExecutionTargetOption } from "../scene/sceneCatalog";
import type { CommandModelOption } from "../thread/threadRuntimeSettings";

export type ControlCommandCatalog = Readonly<{
  modelOptionsByTarget: Readonly<Record<string, CommandModelOption[]>>;
  targets: ExecutionTargetOption[];
}>;

export function controlCommandCatalog(
  agentVersions: readonly AgentVersionView[],
  defaultAgentVersionId: string,
): ControlCommandCatalog {
  const activeVersions = agentVersions.filter(
    (version, index, all) =>
      version.agentVersionId.length > 0 &&
      version.model.modelId.length > 0 &&
      all.findIndex(
        (candidate) => candidate.agentVersionId === version.agentVersionId,
      ) === index,
  );
  const defaultVersion = activeVersions.find(
    (version) => version.agentVersionId === defaultAgentVersionId,
  );
  if (defaultVersion === undefined) {
    return { modelOptionsByTarget: {}, targets: [] };
  }

  const modelOptionsByTarget = Object.fromEntries(
    activeVersions.map((version) => [
      `agent:${version.agentVersionId}`,
      [modelOption(version, false)],
    ]),
  );
  modelOptionsByTarget.crewon = [modelOption(defaultVersion, true)];

  return {
    modelOptionsByTarget,
    targets: [
      {
        detail: `Control · ${defaultVersion.model.modelId}`,
        kind: "crewon",
        label: "CrewON · 单 Agent",
        strategy: "single",
        value: "crewon",
      },
      ...activeVersions.map((version) => ({
        detail: `${version.agentVersionId} · ${version.model.modelId}`,
        group: "single" as const,
        kind: "agent" as const,
        label: version.agentVersionId,
        strategy: "single" as const,
        value: `agent:${version.agentVersionId}`,
      })),
    ],
  };
}

function modelOption(
  version: AgentVersionView,
  isDefault: boolean,
): CommandModelOption {
  return {
    detail: version.model.adapterName,
    isDefault,
    label: version.model.modelId,
    value: version.model.modelId,
  };
}

export function useControlCommandCatalog(params: {
  client: ControlApiClient | null;
  connected: boolean;
}): ControlCommandCatalog | null {
  const [catalog, setCatalog] = useState<ControlCommandCatalog | null>(null);

  useEffect(() => {
    if (!params.connected || params.client === null) {
      setCatalog(null);
      return undefined;
    }
    let current = true;
    void Promise.all([
      params.client.getActiveAgentVersionCatalog(),
      params.client.getModelProviderSettings(),
    ]).then(
      ([agentCatalog, providerSettings]) => {
        if (!current) {
          return;
        }
        const settings = providerSettings.settings;
        const activeProvider = settings.providers.find(
          (provider) =>
            provider.providerId === settings.activeProviderId &&
            provider.isActive,
        );
        setCatalog(
          settings.runtimeAvailability === "available" && activeProvider
            ? controlCommandCatalog(
                agentCatalog.data,
                agentCatalog.defaultAgentVersionId,
              )
            : { modelOptionsByTarget: {}, targets: [] },
        );
      },
      () => {
        if (current) {
          setCatalog({ modelOptionsByTarget: {}, targets: [] });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [params.client, params.connected]);

  return catalog;
}
