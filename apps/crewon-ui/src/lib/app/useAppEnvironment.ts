import { useMemo } from "react";

import { defaultServerUrl, detectPlatform } from "../platform";
import { principalSessionFrontendEnabled } from "../app-server/principalSession";
import { shouldUseDemoPreview } from "./appUiState";

export function useAppEnvironment() {
  const platform = useMemo(detectPlatform, []);
  const serverUrl = useMemo(defaultServerUrl, []);
  const isDemoPreview = useMemo(shouldUseDemoPreview, []);
  const principalSessionEnabled = useMemo(principalSessionFrontendEnabled, []);

  return {
    isDemoPreview,
    platform,
    principalSessionEnabled,
    serverUrl,
  };
}
