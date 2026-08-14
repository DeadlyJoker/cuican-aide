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
  const duplicateVersionIds = new Set<string>();
  const seenVersionIds = new Set<string>();
  for (const version of agentVersions) {
    if (seenVersionIds.has(version.agentVersionId)) {
      duplicateVersionIds.add(version.agentVersionId);
    }
    seenVersionIds.add(version.agentVersionId);
  }
  if (duplicateVersionIds.size > 0) {
    return { modelOptionsByTarget: {}, targets: [] };
  }
  const activeVersions = agentVersions.filter(
    (version) =>
      version.agentVersionId.trim().length > 0 &&
      version.model.modelId.trim().length > 0,
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

export function authorizedControlCommandCatalog(params: {
  activeProviderAuthorized: boolean;
  agentVersions: readonly AgentVersionView[];
  defaultAgentVersionId: string;
  runtimeAvailable: boolean;
}): ControlCommandCatalog {
  if (!params.runtimeAvailable || !params.activeProviderAuthorized) {
    return { modelOptionsByTarget: {}, targets: [] };
  }
  return controlCommandCatalog(
    params.agentVersions,
    params.defaultAgentVersionId,
  );
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
          authorizedControlCommandCatalog({
            activeProviderAuthorized: activeProvider !== undefined,
            agentVersions: agentCatalog.data,
            defaultAgentVersionId: agentCatalog.defaultAgentVersionId,
            runtimeAvailable: settings.runtimeAvailability === "available",
          }),
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
