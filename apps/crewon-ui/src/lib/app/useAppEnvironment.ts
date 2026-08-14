import { useMemo } from "react";

import { detectPlatform, detectRuntimeSurface } from "../platform";

export function useAppEnvironment() {
  const platform = useMemo(detectPlatform, []);
  const runtimeSurface = useMemo(detectRuntimeSurface, []);

  return {
    platform,
    runtimeSurface,
  };
}
