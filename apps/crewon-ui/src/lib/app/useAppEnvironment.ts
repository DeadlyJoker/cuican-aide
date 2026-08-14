import { useMemo } from "react";

import { detectPlatform } from "../platform";

export function useAppEnvironment() {
  const platform = useMemo(detectPlatform, []);

  return {
    platform,
  };
}
