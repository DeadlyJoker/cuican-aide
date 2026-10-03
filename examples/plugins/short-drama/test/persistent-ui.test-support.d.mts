import type {
  PluginUiProps,
  PluginUiServices,
  PluginUiTheme,
} from "@crewon/plugin-sdk/ui";
import type {
  PublicCreativeProject,
  PublicProjectBrief,
  PublicConceptAsset,
  PublicConceptRevision,
  PublicConceptGeneration,
  ConceptGenerationLocator,
} from "@crewon/plugin-sdk/contracts";

export function persistentProps(
  ready?: boolean,
  tokens?: PluginUiTheme["tokens"],
  mode?: PluginUiTheme["mode"],
): PluginUiProps;
export function deferred<T = unknown>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};
type Details = { project: PublicCreativeProject; brief: PublicProjectBrief };
type ConceptDetails = {
  project: PublicCreativeProject;
  asset: PublicConceptAsset;
  assetRevision: PublicConceptRevision;
};
type ConceptReadMethod =
  | "getConceptAsset"
  | "listConceptAssets"
  | "getConceptRevision"
  | "listConceptRevisions";
type ConceptRecord = {
  asset: PublicConceptAsset;
  revisions: readonly PublicConceptRevision[];
};
type Call = { action: string; input: unknown; signal: AbortSignal };
export function metadataService(options?: { pageSize?: number }): {
  services: PluginUiServices;
  calls: Call[];
  records: Map<
    string,
    {
      project: PublicCreativeProject;
      briefs: PublicProjectBrief[];
      assets: Map<string, ConceptRecord>;
    }
  >;
  create(title: string, briefText: string): Details;
  externalBrief(projectId: string, text: string): Details;
  createConcept(
    projectId: string,
    name: string,
    briefRevision: number,
    prompt: string,
  ): ConceptDetails;
  externalConceptRevision(
    projectId: string,
    assetId: string,
    briefRevision: number,
    prompt: string,
  ): ConceptDetails;
  refuse(value: boolean): void;
  setGeneration(
    locator: ConceptGenerationLocator,
    generation: PublicConceptGeneration | null,
  ): void;
  gateGenerationRead(gate: { promise: Promise<unknown> }): void;
  refuseGeneration(value: boolean): void;
  loseNextWrite(): void;
  gateList(gate: { promise: Promise<unknown> }): void;
  gateConceptRead(
    method: ConceptReadMethod,
    gate: { promise: Promise<unknown> },
  ): void;
  methodCalls(method: string): Call[];
};
