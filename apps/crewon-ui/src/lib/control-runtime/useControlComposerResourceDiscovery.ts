import { useEffect, useState } from "react";
import type { ControlApiClient } from "@crewon/control-client";
import {
  discoverControlComposerResources,
  type ControlComposerResourceDiscovery,
} from "./controlComposerResourceDiscovery";

export function useControlComposerResourceDiscovery(params: {
  client: ControlApiClient | null;
  connected: boolean;
}): ControlComposerResourceDiscovery | null {
  const [discovery, setDiscovery] =
    useState<ControlComposerResourceDiscovery | null>(null);
  useEffect(() => {
    if (!params.connected || params.client === null) {
      setDiscovery(null);
      return undefined;
    }
    let current = true;
    void discoverControlComposerResources(params.client).then(
      (next) => {
        if (current) setDiscovery(next);
      },
      () => {
        if (current) setDiscovery(null);
      },
    );
    return () => {
      current = false;
    };
  }, [params.client, params.connected]);
  return discovery;
}
