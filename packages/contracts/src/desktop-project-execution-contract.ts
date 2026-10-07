import {
  parseDesktopProjectMediaResultsConfiguration,
  type DesktopProjectMediaResultsConfiguration,
} from "./desktop-project-media-results.ts";
import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import {
  pluginControlFail,
  pluginControlRecord,
} from "./plugin-control-contract-support.ts";
import {
  DESKTOP_PROJECT_HISTORY_VERSION,
  parseDesktopProjectHistoryConfiguration,
  type DesktopProjectHistoryConfiguration,
  type DesktopProjectHistoryPublication,
} from "./desktop-project-history-contract.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import { PLUGIN_UI_RECOVERY_VERSION } from "./plugin-ui-recovery-contract.ts";
import {
  parseDesktopProjectHistoricalQueriesConfiguration,
  type DesktopProjectHistoricalQueriesConfiguration,
} from "./desktop-project-historical-query-contract.ts";
import {
  parseDesktopProjectMediaInputsConfiguration,
  type DesktopProjectMediaInputsConfiguration,
} from "./desktop-project-media-inputs.ts";

export const DESKTOP_PROJECT_EXECUTION_VERSION =
  "crewon.desktop-project-execution.v1";
const GENERATE = "crewon.project-generations.v1.generateConcept";
const QUERY = "crewon.project-generation-queries.v1.queryConceptGeneration";
const SELECT = "crewon.project-generation-selections.v1.selectConceptImage";
export type DesktopProjectExecutionRecoveryAction =
  | typeof GENERATE
  | typeof QUERY
  | typeof SELECT;
export type DesktopProjectExecutionPublication = Readonly<{
  source: DesktopProjectHistoryPublication;
  target: DesktopProjectHistoryPublication & Readonly<{ action: string }>;
}>;
type Mappings = Readonly<{
  publications: readonly DesktopProjectExecutionPublication[];
}>;
export type DesktopProjectExecutionConfiguration = Omit<
  DesktopProjectHistoryConfiguration,
  "version" | "uiRecovery"
> &
  Readonly<{
    version: typeof DESKTOP_PROJECT_EXECUTION_VERSION;
    pluginGenerations?: Mappings;
    pluginQueries?: Mappings;
    historicalQueries?: DesktopProjectHistoricalQueriesConfiguration;
    mediaInputs?: DesktopProjectMediaInputsConfiguration;
    mediaResults?: DesktopProjectMediaResultsConfiguration;
    /** Independent media execution opt-in; metadata and text plans never imply this grant. */
    mediaGenerations?: Readonly<{
      version: "crewon.desktop-project-media-generations.v1";
      publications: readonly DesktopProjectHistoryPublication[];
    }>;
    mediaInputStages?: Readonly<{
      version: "crewon.project-media-input-stages.v1";
      publications: readonly DesktopProjectHistoryPublication[];
    }>;
    mediaInputUi?: Readonly<{
      publications: readonly DesktopProjectHistoryPublication[];
    }>;
    uiRecovery?: Readonly<{
      version: typeof PLUGIN_UI_RECOVERY_VERSION;
      publications: readonly (DesktopProjectHistoryPublication &
        Readonly<{
          actions: readonly DesktopProjectExecutionRecoveryAction[];
        }>)[];
    }>;
  }>;

/** Private deployment data only. Mappings and recovery declarations issue no task authority. */
export function parseDesktopProjectExecutionConfiguration(
  input: unknown,
  options: Readonly<{
    publications: readonly Readonly<{
      pluginId: string;
      packageDigest: string;
    }>[];
  }>,
): DesktopProjectExecutionConfiguration {
  try {
    const metadataFields = [
      "pluginUi",
      "textArtifacts",
      "textUi",
      "textRecovery",
      "assetArtifacts",
      "assetUi",
      "assetRecovery",
      "assetStages",
      "conversations",
      "textPlans",
      "planningDrafts",
      "generationReads",
      "generationReadUi",
      "resultSelections",
      "selectionUi",
    ] as const;
    const optional = [
      ...metadataFields,
      "pluginGenerations",
      "pluginQueries",
      "historicalQueries",
      "mediaInputs",
      "mediaGenerations",
      "mediaResults",
      "mediaInputUi",
      "mediaInputStages",
      "uiRecovery",
    ];
    const value = pluginControlRecord(
      parsePluginUiJsonValue(input, { maxBytes: 64 * 1024 }),
      ["version", ...optional],
      { optional },
    );
    if (
      value.version !== DESKTOP_PROJECT_EXECUTION_VERSION ||
      Object.keys(value).length === 1
    )
      invalid();
    const approved = captureApproved(options);
    const metadata = Object.fromEntries(
      metadataFields
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, value[key]]),
    );
    const history =
      Object.keys(metadata).length === 0
        ? undefined
        : parseDesktopProjectHistoryConfiguration(
            { version: DESKTOP_PROJECT_HISTORY_VERSION, ...metadata },
            { publications: approved },
          );
    const { version: _historyVersion, ...data } = history ?? {
      version: DESKTOP_PROJECT_HISTORY_VERSION,
    };
    const pluginGenerations = mappings(value.pluginGenerations, approved);
    const mediaInputs =
      value.mediaInputs === undefined
        ? undefined
        : parseDesktopProjectMediaInputsConfiguration(value.mediaInputs, {
            publications: approved,
          });
    if (mediaInputs !== undefined && data.assetArtifacts === undefined)
      invalid();
    const mediaInputUi =
      value.mediaInputUi === undefined
        ? undefined
        : parseDesktopProjectHistoryConfiguration(
            {
              version: DESKTOP_PROJECT_HISTORY_VERSION,
              pluginUi: value.mediaInputUi,
            },
            { publications: approved },
          ).pluginUi;
    if (
      mediaInputUi !== undefined &&
      (mediaInputs === undefined ||
        mediaInputUi.publications.some(
          (p) =>
            !mediaInputs.reviews.some(
              (r) =>
                r.targetIdentity.pluginId === p.pluginId &&
                r.targetIdentity.packageDigest === p.packageDigest,
            ),
        ))
    )
      invalid();
    const mediaInputStages = stagePublications(
      value.mediaInputStages,
      approved,
    );
    if (
      mediaInputStages !== undefined &&
      (mediaInputs === undefined ||
        !mediaInputs.purposes.includes("write") ||
        mediaInputStages.publications.some(
          (p) =>
            !data.conversations?.publications.some(
              (c) =>
                c.pluginId === p.pluginId &&
                c.packageDigest === p.packageDigest &&
                c.contributionId === p.contributionId,
            ) ||
            !mediaInputs.reviews.some(
              (r) =>
                r.targetIdentity.pluginId === p.pluginId &&
                r.targetIdentity.packageDigest === p.packageDigest,
            ),
        ))
    )
      invalid();
    const mediaGenerations = generationPublications(
      value.mediaGenerations,
      approved,
    );
    if (
      mediaGenerations !== undefined &&
      (mediaInputs === undefined ||
        mediaGenerations.publications.some(
          (p) =>
            p.pluginId !== "crewon.short-drama" ||
            p.contributionId !== "workbench" ||
            !data.conversations?.publications.some(
              (c) =>
                c.pluginId === p.pluginId &&
                c.packageDigest === p.packageDigest &&
                c.contributionId === p.contributionId,
            ) ||
            !mediaInputs.reviews.some(
              (r) =>
                r.targetIdentity.pluginId === p.pluginId &&
                r.targetIdentity.packageDigest === p.packageDigest,
            ),
        ))
    )
      invalid();
    const mediaResults =
      value.mediaResults === undefined
        ? undefined
        : parseDesktopProjectMediaResultsConfiguration(
            value.mediaResults,
            approved,
          );
    if (
      mediaResults !== undefined &&
      (mediaInputs === undefined ||
        mediaResults.publications.some(
          (p) =>
            !mediaInputs.reviews.some(
              (r) =>
                r.targetIdentity.pluginId === p.pluginId &&
                r.targetIdentity.packageDigest === p.packageDigest,
            ) ||
            (mediaResults.purposes.includes("publish") &&
              !mediaGenerations?.publications.some(
                (g) =>
                  g.pluginId === p.pluginId &&
                  g.packageDigest === p.packageDigest &&
                  g.contributionId === p.contributionId,
              )),
        ))
    )
      invalid();
    const pluginQueries = mappings(value.pluginQueries, approved);
    if (pluginQueries !== undefined && data.generationReads === undefined)
      invalid();
    const historicalQueries =
      value.historicalQueries === undefined
        ? undefined
        : parseDesktopProjectHistoricalQueriesConfiguration(
            value.historicalQueries,
            { publications: approved },
          );
    if (
      historicalQueries !== undefined &&
      (data.generationReads === undefined ||
        historicalQueries.publications.some((publication) =>
          [data.pluginUi, data.generationReadUi].some(
            (available) =>
              !available?.publications.some(
                (entry) =>
                  entry.pluginId === publication.source.pluginId &&
                  entry.packageDigest === publication.source.packageDigest &&
                  entry.contributionId === publication.source.contributionId,
              ),
          ),
        ))
    )
      invalid();
    const uiRecovery = recovery(value.uiRecovery, {
      metadata: data.pluginUi?.publications,
      generation: pluginGenerations?.publications.map((item) => item.source),
      query: pluginQueries?.publications.map((item) => item.source),
      selection: data.selectionUi?.publications,
    });
    return Object.freeze({
      version: DESKTOP_PROJECT_EXECUTION_VERSION,
      ...data,
      ...(pluginGenerations === undefined ? {} : { pluginGenerations }),
      ...(pluginQueries === undefined ? {} : { pluginQueries }),
      ...(historicalQueries === undefined ? {} : { historicalQueries }),
      ...(mediaInputs === undefined ? {} : { mediaInputs }),
      ...(mediaGenerations === undefined ? {} : { mediaGenerations }),
      ...(mediaResults === undefined ? {} : { mediaResults }),
      ...(mediaInputUi === undefined ? {} : { mediaInputUi }),
      ...(mediaInputStages === undefined ? {} : { mediaInputStages }),
      ...(uiRecovery === undefined ? {} : { uiRecovery }),
    });
  } catch {
    invalid();
  }
}

function captureApproved(input: unknown) {
  const value = pluginControlRecord(input, ["publications"]);
  return dense(value.publications, 0, 32).map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
    )
      invalid();
    const fields = Object.getOwnPropertyDescriptors(entry);
    for (const key of ["pluginId", "packageDigest"] as const)
      if (!fields[key]?.enumerable || !Object.hasOwn(fields[key]!, "value"))
        invalid();
    return Object.freeze({
      pluginId: parsePluginControlPluginId(fields.pluginId!.value),
      packageDigest: parsePluginControlPackageDigest(
        fields.packageDigest!.value,
      ),
    });
  });
}
function source(input: unknown): DesktopProjectHistoryPublication {
  const value = pluginControlRecord(input, [
    "pluginId",
    "packageDigest",
    "contributionId",
  ]);
  return Object.freeze({
    pluginId: parsePluginControlPluginId(value.pluginId),
    packageDigest: parsePluginControlPackageDigest(value.packageDigest),
    contributionId: parsePluginControlPluginId(value.contributionId),
  });
}
function mappings(
  input: unknown,
  approved: readonly Readonly<{ pluginId: string; packageDigest: string }>[],
): Mappings | undefined {
  if (input === undefined) return undefined;
  const value = pluginControlRecord(input, ["publications"]);
  const items = dense(value.publications, 1, 32).map((entry) => {
    const item = pluginControlRecord(entry, ["source", "target"]);
    const captured = source(item.source);
    if (
      !approved.some(
        (grant) =>
          grant.pluginId === captured.pluginId &&
          grant.packageDigest === captured.packageDigest,
      )
    )
      invalid();
    const target = pluginControlRecord(item.target, [
      "pluginId",
      "packageDigest",
      "contributionId",
      "action",
    ]);
    return Object.freeze({
      source: captured,
      target: Object.freeze({
        ...source({
          pluginId: target.pluginId,
          packageDigest: target.packageDigest,
          contributionId: target.contributionId,
        }),
        action: parsePluginControlPluginId(target.action),
      }),
    });
  });
  if (
    new Set(items.map((item) => JSON.stringify(item.source))).size !==
    items.length
  )
    invalid();
  return Object.freeze({ publications: Object.freeze(items) });
}
function recovery(
  input: unknown,
  grants: Readonly<{
    metadata: readonly DesktopProjectHistoryPublication[] | undefined;
    generation: readonly DesktopProjectHistoryPublication[] | undefined;
    query: readonly DesktopProjectHistoryPublication[] | undefined;
    selection: readonly DesktopProjectHistoryPublication[] | undefined;
  }>,
): DesktopProjectExecutionConfiguration["uiRecovery"] {
  if (input === undefined) return undefined;
  const value = pluginControlRecord(input, ["version", "publications"]);
  if (value.version !== PLUGIN_UI_RECOVERY_VERSION) invalid();
  const items = dense(value.publications, 1, 32).map((entry) => {
    const item = pluginControlRecord(entry, [
      "pluginId",
      "packageDigest",
      "contributionId",
      "actions",
    ]);
    const captured = source({
      pluginId: item.pluginId,
      packageDigest: item.packageDigest,
      contributionId: item.contributionId,
    });
    const actions = dense(item.actions, 0, 3).map(
      (action): DesktopProjectExecutionRecoveryAction => {
        const sources =
          action === GENERATE
            ? grants.generation
            : action === QUERY
              ? grants.query
              : action === SELECT
                ? grants.selection
                : undefined;
        if (
          !sources?.some(
            (grant) => JSON.stringify(grant) === JSON.stringify(captured),
          )
        )
          invalid();
        return action as DesktopProjectExecutionRecoveryAction;
      },
    );
    if (
      actions.length === 0 &&
      !grants.metadata?.some(
        (grant) => JSON.stringify(grant) === JSON.stringify(captured),
      )
    )
      invalid();
    if (new Set(actions).size !== actions.length) invalid();
    return Object.freeze({ ...captured, actions: Object.freeze(actions) });
  });
  if (
    new Set(items.map(({ actions: _actions, ...item }) => JSON.stringify(item)))
      .size !== items.length
  )
    invalid();
  return Object.freeze({
    version: PLUGIN_UI_RECOVERY_VERSION,
    publications: Object.freeze(items),
  });
}
function dense(
  input: unknown,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < minimum ||
    input.length > maximum ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const value = Object.getOwnPropertyDescriptor(input, String(index));
    if (!value?.enumerable || !Object.hasOwn(value, "value")) invalid();
    return value.value;
  });
}
function invalid(): never {
  return pluginControlFail("desktop_project_execution_configuration_invalid");
}

function stagePublications(
  input: unknown,
  approved: readonly Readonly<{ pluginId: string; packageDigest: string }>[],
): DesktopProjectExecutionConfiguration["mediaInputStages"] {
  if (input === undefined) return undefined;
  const value = pluginControlRecord(input, ["version", "publications"]);
  if (value.version !== "crewon.project-media-input-stages.v1") invalid();
  const publication = parseDesktopProjectHistoryConfiguration(
    {
      version: DESKTOP_PROJECT_HISTORY_VERSION,
      pluginUi: { publications: value.publications },
    },
    { publications: approved },
  ).pluginUi!;
  return Object.freeze({
    version: "crewon.project-media-input-stages.v1",
    publications: publication.publications,
  });
}

function generationPublications(
  input: unknown,
  approved: readonly Readonly<{ pluginId: string; packageDigest: string }>[],
): DesktopProjectExecutionConfiguration["mediaGenerations"] {
  if (input === undefined) return undefined;
  const value = pluginControlRecord(input, ["version", "publications"]);
  if (value.version !== "crewon.desktop-project-media-generations.v1")
    invalid();
  const publication = parseDesktopProjectHistoryConfiguration(
    {
      version: DESKTOP_PROJECT_HISTORY_VERSION,
      pluginUi: { publications: value.publications },
    },
    { publications: approved },
  ).pluginUi!;
  return Object.freeze({
    version: "crewon.desktop-project-media-generations.v1",
    publications: publication.publications,
  });
}
