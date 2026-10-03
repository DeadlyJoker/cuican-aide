import type {
  ProjectGenerationHostContext,
  ProjectGenerationQueryHostContext,
  ProjectGenerationSelectionHostContext,
} from "@crewon/plugin-sdk/ui";
import type { selectionService } from "./selection-submit.test-support.mjs";
export function coldRecoveryService(): ReturnType<typeof selectionService> & {
  contexts(): {
    generation: ProjectGenerationHostContext;
    query: ProjectGenerationQueryHostContext;
    selection: ProjectGenerationSelectionHostContext;
  };
  gatedReads: { assetId: string; signal: AbortSignal }[];
  gateSource(assetId: string): { resolve(): void; reject(): void };
  setGenerationIntent(value: ProjectGenerationHostContext["intent"]): void;
  setQueryIntent(value: ProjectGenerationQueryHostContext["intent"]): void;
};
