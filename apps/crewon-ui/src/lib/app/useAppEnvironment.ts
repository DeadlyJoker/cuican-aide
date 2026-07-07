import { useMemo } from "react";

import { defaultServerUrl, detectPlatform } from "../platform";
import { shouldUseDemoPreview } from "./appUiState";

export function useAppEnvironment() {
  const platform = useMemo(detectPlatform, []);
  const serverUrl = useMemo(defaultServerUrl, []);
  const isDemoPreview = useMemo(shouldUseDemoPreview, []);

  return {
    isDemoPreview,
    platform,
    serverUrl,
  };
}
