import { useMemo } from "react";

import { detectPlatform } from "../platform";
import { shouldUseDemoPreview } from "./appUiState";

export function useAppEnvironment() {
  const platform = useMemo(detectPlatform, []);
  const isDemoPreview = useMemo(shouldUseDemoPreview, []);

  return {
    isDemoPreview,
    platform,
  };
}
