import { useEffect, useState } from "react";
import type { ActiveAgentVersionCatalogResponse } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import type { AppServerClient } from "../app-server/appServer";
import { controlDefaultModelVersions } from "../control-runtime/controlModelCatalog";
import {
  commandModelOptionsFromModels,
  fallbackCommandModelOptions,
  type CommandModelOption,
} from "../thread/threadRuntimeSettings";

export function useAppCommandModelOptions({
  client,
  connectionAttempt,
  isConnected,
}: {
  client: Pick<AppServerClient, "listModels"> | null;
  connectionAttempt: number;
  isConnected: boolean;
}): CommandModelOption[] {
  const [modelOptions, setModelOptions] = useState<CommandModelOption[]>(
    fallbackCommandModelOptions,
  );

  useEffect(() => {
    let cancelled = false;
    if (!isConnected || !client) {
      setModelOptions(fallbackCommandModelOptions);
      return;
    }
    client
      .listModels()
      .then((response) => {
        if (cancelled) {
          return;
        }
        /*
         * A live catalog is authoritative: merged-in fallbacks would keep
         * offering slugs the signed-in account cannot run (for example
         * gpt-5-mini on a ChatGPT plan), and every turn with such a model
         * fails with a backend 400. Only fall back when the catalog is
         * empty.
         */
        const backendOptions = commandModelOptionsFromModels(response.data);
        setModelOptions(
          backendOptions.length > 0
            ? backendOptions
            : fallbackCommandModelOptions,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setModelOptions(fallbackCommandModelOptions);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, connectionAttempt, isConnected]);

  return modelOptions;
}

export function controlCommandModelOptionsFromCatalog(
  catalog: ActiveAgentVersionCatalogResponse,
): CommandModelOption[] {
  return controlDefaultModelVersions(catalog).map((version, index) => ({
    isDefault: index === 0,
    label: version.model.modelId,
    value: version.model.modelId,
  }));
}

/** Control exposes only models backed by active immutable AgentVersions. */
export function useControlCommandModelOptions({
  client,
  connected,
}: {
  client: Pick<ControlApiClient, "getActiveAgentVersionCatalog"> | null;
  connected: boolean;
}): CommandModelOption[] {
  const [modelOptions, setModelOptions] = useState<CommandModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!connected || !client) {
      setModelOptions([]);
      return;
    }
    client
      .getActiveAgentVersionCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setModelOptions(controlCommandModelOptionsFromCatalog(catalog));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelOptions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, connected]);

  return modelOptions;
}
