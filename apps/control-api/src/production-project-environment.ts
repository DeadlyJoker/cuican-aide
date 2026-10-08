import {
  captureProjectHistoricalQueryPluginConfiguration,
  type ProjectHistoricalQueryPluginConfiguration,
} from "./project-historical-query-plugin-configuration.ts";
import type {
  CreativeProjectAuthorizationPort,
  ProjectSourceUploadAuthorizationPort,
} from "@crewon/application";
import {
  captureProjectFoundationStartupConfiguration,
  type ProjectFoundationStartupConfiguration,
} from "./project-foundation-composition.ts";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  captureCreativeProjectCompositionConfig,
  type CreativeProjectCompositionConfig,
} from "./creative-project-composition.ts";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  captureProjectGenerationPluginConfiguration,
  type ProjectGenerationPluginConfiguration,
} from "./project-generation-plugin-configuration.ts";
import {
  captureProjectQueryPluginConfiguration,
  type ProjectQueryPluginConfiguration,
} from "./project-query-plugin-configuration.ts";
import {
  captureProjectGenerationReadConfiguration,
  type ProjectGenerationReadConfiguration,
} from "./project-generation-read-composition.ts";
import {
  captureProjectGenerationReadPluginUiConfig,
  type ProjectGenerationReadPluginUiConfig,
} from "./project-generation-read-plugin-ui-composition.ts";
import { captureProjectGenerationSelectionConfiguration } from "./project-generation-selection-composition.ts";
import {
  createComfyUiProjectGenerationImageResultVerifier,
  type ComfyUiResultIdentity,
} from "./comfyui-image-result-verifier.ts";
import {
  capturePluginUiRecoveryConfiguration,
  type PluginUiRecoveryConfiguration,
} from "./plugin-ui-recovery-composition.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";
import { readProductionProjectPrivateFile } from "./production-project-private-file.ts";

export const PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV =
  "CREWON_PROJECT_COMPOSITION_CONFIG_PATH";
export const PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA =
  "crewon.production-project-composition.v1";

export type ProductionProjectResultSelectionConfiguration = Readonly<{
  version: "crewon.project-concept-selection.v1";
  adapter: "comfyui-krea2";
  identities: readonly ComfyUiResultIdentity[];
}>;
/** Deployment data only. Authorization and provider endpoints are never accepted here. */
export type ProductionProjectStartupConfiguration = Readonly<{
  schemaVersion: typeof PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA;
  foundation?: ProjectFoundationStartupConfiguration;
  pluginUi?: CreativeProjectPluginUiConfig;
  pluginGenerations?: ProjectGenerationPluginConfiguration;
  pluginQueries?: ProjectQueryPluginConfiguration;
  historicalQueries?: ProjectHistoricalQueryPluginConfiguration;
  generationReads?: ProjectGenerationReadConfiguration;
  generationReadUi?: ProjectGenerationReadPluginUiConfig;
  resultSelections?: ProductionProjectResultSelectionConfiguration;
  selectionUi?: CreativeProjectPluginUiConfig;
  uiRecovery?: PluginUiRecoveryConfiguration;
}>;
const snapshots = new WeakSet<object>();
const allowedFields = [
  "schemaVersion",
  "foundation",
  "pluginUi",
  "pluginGenerations",
  "pluginQueries",
  "historicalQueries",
  "generationReads",
  "generationReadUi",
  "resultSelections",
  "selectionUi",
  "uiRecovery",
] as const;

export function parseProductionProjectStartupConfiguration(
  input: unknown,
): ProductionProjectStartupConfiguration {
  try {
    const detached = parsePluginUiJsonValue(input, { maxBytes: 64 * 1024 });
    if (
      detached === null ||
      typeof detached !== "object" ||
      Array.isArray(detached)
    )
      invalid();
    const value = pluginSecurityRecord(detached, Object.keys(detached));
    if (
      Object.keys(value).some(
        (key) => !(allowedFields as readonly string[]).includes(key),
      ) ||
      value.schemaVersion !== PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA
    )
      invalid();
    const foundation = captureProjectFoundationStartupConfiguration(
      value.foundation,
    );
    const pluginUi = captureCreativeProjectPluginUiConfig(value.pluginUi);
    const pluginGenerations = captureProjectGenerationPluginConfiguration(
      value.pluginGenerations,
    );
    const pluginQueries = captureProjectQueryPluginConfiguration(
      value.pluginQueries,
    );
    const historicalQueries = captureProjectHistoricalQueryPluginConfiguration(
      value.historicalQueries,
    );
    const generationReads = captureProjectGenerationReadConfiguration(
      value.generationReads,
    );
    const generationReadUi = captureProjectGenerationReadPluginUiConfig(
      value.generationReadUi,
    );
    const resultSelections = captureResultSelections(value.resultSelections);
    const selectionUi = captureCreativeProjectPluginUiConfig(value.selectionUi);
    const uiRecovery = capturePluginUiRecoveryConfiguration(value.uiRecovery);
    if (
      ((pluginQueries !== undefined || historicalQueries !== undefined) &&
        generationReads === undefined) ||
      (generationReadUi !== undefined && generationReads === undefined) ||
      (resultSelections !== undefined && generationReads === undefined) ||
      (selectionUi !== undefined && resultSelections === undefined)
    )
      invalid();
    const snapshot: ProductionProjectStartupConfiguration = Object.freeze({
      schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
      ...(foundation === undefined ? {} : { foundation }),
      ...(pluginUi === undefined ? {} : { pluginUi }),
      ...(pluginGenerations === undefined ? {} : { pluginGenerations }),
      ...(pluginQueries === undefined ? {} : { pluginQueries }),
      ...(historicalQueries === undefined ? {} : { historicalQueries }),
      ...(generationReads === undefined ? {} : { generationReads }),
      ...(generationReadUi === undefined ? {} : { generationReadUi }),
      ...(resultSelections === undefined ? {} : { resultSelections }),
      ...(selectionUi === undefined ? {} : { selectionUi }),
      ...(uiRecovery === undefined ? {} : { uiRecovery }),
    });
    assertRecoverySources(snapshot);
    snapshots.add(snapshot);
    return snapshot;
  } catch {
    invalid();
  }
}

/** Missing opt-in does not touch files, ports, providers or persistence. */
export async function loadProductionProjectEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  securityMode: "production" | "standalone",
): Promise<ProductionProjectStartupConfiguration | undefined> {
  const field = Object.getOwnPropertyDescriptor(
    environment,
    PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV,
  );
  if (field === undefined || ("value" in field && field.value === undefined))
    return undefined;
  if (!("value" in field) || securityMode !== "production") invalid();
  try {
    const text = await readProductionProjectPrivateFile(field.value);
    return parseProductionProjectStartupConfiguration(JSON.parse(text));
  } catch {
    invalid();
  }
}

/** The caller supplies the same real policy port used by the Production composition. */
export function composeProductionProjectStartup(
  snapshot: ProductionProjectStartupConfiguration | undefined,
  authorization: CreativeProjectAuthorizationPort,
  uploadAuthorization?: ProjectSourceUploadAuthorizationPort,
): Readonly<{
  creativeProjects?: CreativeProjectCompositionConfig;
  uiRecovery?: PluginUiRecoveryConfiguration;
}> {
  if (snapshot === undefined) return Object.freeze({});
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !snapshots.has(snapshot)
  )
    invalid();
  const {
    schemaVersion: _schemaVersion,
    uiRecovery,
    resultSelections,
    foundation,
    ...data
  } = snapshot;
  const selections =
    resultSelections === undefined
      ? undefined
      : captureProjectGenerationSelectionConfiguration({
          version: resultSelections.version,
          verifier: createComfyUiProjectGenerationImageResultVerifier({
            identities: resultSelections.identities,
          }),
        });
  if (foundation !== undefined && uploadAuthorization === undefined) invalid();
  const creativeProjects = captureCreativeProjectCompositionConfig({
    ...data,
    authorization,
    ...(foundation === undefined
      ? {}
      : {
          foundation: {
            ...foundation,
            uploads: {
              ...foundation.uploads,
              authorization: uploadAuthorization,
            },
          },
        }),
    ...(selections === undefined ? {} : { resultSelections: selections }),
  })!;
  return Object.freeze({
    creativeProjects,
    ...(uiRecovery === undefined ? {} : { uiRecovery }),
  });
}

function captureResultSelections(
  input: unknown,
): ProductionProjectResultSelectionConfiguration | undefined {
  if (input === undefined) return undefined;
  const value = pluginSecurityRecord(input, [
    "version",
    "adapter",
    "identities",
  ]);
  if (
    value.version !== "crewon.project-concept-selection.v1" ||
    value.adapter !== "comfyui-krea2"
  )
    invalid();
  // The existing adapter owns all identity validation; the JSON snapshot is already detached/frozen.
  const identities = value.identities as readonly ComfyUiResultIdentity[];
  createComfyUiProjectGenerationImageResultVerifier({ identities });
  return Object.freeze({
    version: "crewon.project-concept-selection.v1",
    adapter: "comfyui-krea2",
    identities,
  });
}

function assertRecoverySources(
  snapshot: ProductionProjectStartupConfiguration,
): void {
  for (const publication of snapshot.uiRecovery?.publications ?? []) {
    for (const action of publication.actions) {
      const sources =
        action === "crewon.project-generations.v1.generateConcept"
          ? snapshot.pluginGenerations?.publications.map((item) => item.source)
          : action ===
              "crewon.project-generation-queries.v1.queryConceptGeneration"
            ? snapshot.pluginQueries?.publications.map((item) => item.source)
            : snapshot.selectionUi?.publications;
      if (
        !sources?.some(
          (source) =>
            source.pluginId === publication.pluginId &&
            source.packageDigest === publication.packageDigest &&
            source.contributionId === publication.contributionId,
        )
      )
        invalid();
    }
  }
}

function invalid(): never {
  throw new Error("production_project_configuration_invalid");
}
