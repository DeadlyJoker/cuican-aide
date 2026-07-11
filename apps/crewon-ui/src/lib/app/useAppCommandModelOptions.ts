import { useEffect, useState } from "react";

import type { AppServerClient } from "../app-server/appServer";
import {
  commandModelOptionsFromModels,
  fallbackCommandModelOptions,
  mergeCommandModelOptions,
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
        const nextOptions = mergeCommandModelOptions(
          commandModelOptionsFromModels(response.data),
        );
        setModelOptions(
          nextOptions.length > 0
            ? nextOptions
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
