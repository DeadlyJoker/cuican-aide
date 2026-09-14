import { createContext } from "react";
import type { ControlApiClient } from "@crewon/control-client";

export const ArtifactClientContext = createContext<Pick<
  ControlApiClient,
  "downloadArtifact"
> | null>(null);
