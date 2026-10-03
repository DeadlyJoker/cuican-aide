import {
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import {
  pluginControlFail,
  pluginControlRecord,
  pluginControlVersion,
} from "./plugin-control-contract-support.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import { PLUGIN_UI_RECOVERY_VERSION } from "./plugin-ui-recovery-contract.ts";

export const DESKTOP_PROJECT_HISTORY_VERSION =
  "crewon.desktop-project-history.v1";
const SELECT_ACTION =
  "crewon.project-generation-selections.v1.selectConceptImage";
export type DesktopProjectHistoryPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
}>;
type Publications = Readonly<{
  publications: readonly DesktopProjectHistoryPublication[];
}>;
export type DesktopProjectHistoryConfiguration = Readonly<{
  version: typeof DESKTOP_PROJECT_HISTORY_VERSION;
  pluginUi?: Publications;
  generationReads?: Readonly<{ version: "crewon.project-generation-read.v1" }>;
  generationReadUi?: Publications;
  resultSelections?: Readonly<{
    version: "crewon.project-concept-selection.v1";
    adapter: "comfyui-krea2";
    identities: readonly Readonly<{
      pluginVersion: string;
      manifestDigest: string;
      implementationDigest: string;
    }>[];
  }>;
  selectionUi?: Publications;
  uiRecovery?: Readonly<{
    version: typeof PLUGIN_UI_RECOVERY_VERSION;
    publications: readonly (DesktopProjectHistoryPublication &
      Readonly<{ actions: readonly (typeof SELECT_ACTION)[] }>)[];
  }>;
}>;

/** Private host approval data only; neither a renderer capability nor paid execution authority. */
export function parseDesktopProjectHistoryConfiguration(
  input: unknown,
  options: Readonly<{
    publications: readonly Readonly<{
      pluginId: string;
      packageDigest: string;
    }>[];
  }>,
): DesktopProjectHistoryConfiguration {
  try {
    const fields = [
      "version",
      "pluginUi",
      "generationReads",
      "generationReadUi",
      "resultSelections",
      "selectionUi",
      "uiRecovery",
    ] as const;
    const value = pluginControlRecord(
      parsePluginUiJsonValue(input, { maxBytes: 64 * 1024 }),
      fields,
      { optional: fields.filter((field) => field !== "version") },
    );
    if (
      value.version !== DESKTOP_PROJECT_HISTORY_VERSION ||
      Object.keys(value).length === 1
    )
      invalid();
    const supplied = pluginControlRecord(options, ["publications"]);
    const approved = dense(supplied.publications, {
      minimum: 0,
      maximum: 32,
    }).map((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
      )
        invalid();
      const data = Object.getOwnPropertyDescriptors(entry);
      for (const key of ["pluginId", "packageDigest"] as const)
        if (!data[key]?.enumerable || !Object.hasOwn(data[key]!, "value"))
          invalid();
      return {
        pluginId: parsePluginControlPluginId(data.pluginId!.value),
        packageDigest: parsePluginControlPackageDigest(
          data.packageDigest!.value,
        ),
      };
    });
    const pluginUi = publications(value.pluginUi, approved);
    const generationReadUi = publications(value.generationReadUi, approved);
    const selectionUi = publications(value.selectionUi, approved);
    const generationReads =
      value.generationReads === undefined
        ? undefined
        : pluginControlRecord(value.generationReads, ["version"]);
    if (
      generationReads !== undefined &&
      generationReads.version !== "crewon.project-generation-read.v1"
    )
      invalid();
    const resultSelections = selections(value.resultSelections);
    if (
      ((generationReadUi !== undefined || resultSelections !== undefined) &&
        generationReads === undefined) ||
      (selectionUi !== undefined && resultSelections === undefined)
    )
      invalid();
    const uiRecovery = recovery(value.uiRecovery, selectionUi);
    return Object.freeze({
      version: DESKTOP_PROJECT_HISTORY_VERSION,
      ...(pluginUi === undefined ? {} : { pluginUi }),
      ...(generationReads === undefined
        ? {}
        : {
            generationReads: Object.freeze({
              version: "crewon.project-generation-read.v1" as const,
            }),
          }),
      ...(generationReadUi === undefined ? {} : { generationReadUi }),
      ...(resultSelections === undefined ? {} : { resultSelections }),
      ...(selectionUi === undefined ? {} : { selectionUi }),
      ...(uiRecovery === undefined ? {} : { uiRecovery }),
    });
  } catch {
    invalid();
  }
}

function publication(input: unknown): DesktopProjectHistoryPublication {
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
function publications(
  input: unknown,
  approved: readonly Readonly<{ pluginId: string; packageDigest: string }>[],
): Publications | undefined {
  if (input === undefined) return undefined;
  const value = pluginControlRecord(input, ["publications"]);
  const items = dense(value.publications, { minimum: 1, maximum: 32 }).map(
    publication,
  );
  if (
    new Set(items.map((item) => JSON.stringify(item))).size !== items.length ||
    items.some(
      (item) =>
        !approved.some(
          (source) =>
            source.pluginId === item.pluginId &&
            source.packageDigest === item.packageDigest,
        ),
    )
  )
    invalid();
  return Object.freeze({ publications: Object.freeze(items) });
}
function selections(
  input: unknown,
): DesktopProjectHistoryConfiguration["resultSelections"] {
  if (input === undefined) return undefined;
  const value = pluginControlRecord(input, [
    "version",
    "adapter",
    "identities",
  ]);
  if (
    value.version !== "crewon.project-concept-selection.v1" ||
    value.adapter !== "comfyui-krea2"
  )
    invalid();
  const identities = dense(value.identities, { minimum: 1, maximum: 32 }).map(
    (input) => {
      const identity = pluginControlRecord(input, [
        "pluginVersion",
        "manifestDigest",
        "implementationDigest",
      ]);
      if (
        typeof identity.pluginVersion !== "string" ||
        identity.pluginVersion.length > 32 ||
        !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(
          identity.pluginVersion,
        )
      )
        invalid();
      return Object.freeze({
        pluginVersion: pluginControlVersion(identity.pluginVersion),
        manifestDigest: parsePluginControlPackageDigest(
          identity.manifestDigest,
        ),
        implementationDigest: parsePluginControlPackageDigest(
          identity.implementationDigest,
        ),
      });
    },
  );
  if (
    new Set(identities.map((identity) => JSON.stringify(identity))).size !==
    identities.length
  )
    invalid();
  return Object.freeze({
    version: "crewon.project-concept-selection.v1",
    adapter: "comfyui-krea2",
    identities: Object.freeze(identities),
  });
}
function recovery(
  input: unknown,
  selections: Publications | undefined,
): DesktopProjectHistoryConfiguration["uiRecovery"] {
  if (input === undefined) return undefined;
  const value = pluginControlRecord(input, ["version", "publications"]);
  if (value.version !== PLUGIN_UI_RECOVERY_VERSION || selections === undefined)
    invalid();
  const items = dense(value.publications, { minimum: 1, maximum: 32 }).map(
    (input) => {
      const item = pluginControlRecord(input, [
        "pluginId",
        "packageDigest",
        "contributionId",
        "actions",
      ]);
      const source = publication({
        pluginId: item.pluginId,
        packageDigest: item.packageDigest,
        contributionId: item.contributionId,
      });
      const actions = dense(item.actions, { minimum: 1, maximum: 1 });
      if (
        actions[0] !== SELECT_ACTION ||
        !selections.publications.some(
          (approved) => JSON.stringify(approved) === JSON.stringify(source),
        )
      )
        invalid();
      return Object.freeze({
        ...source,
        actions: Object.freeze([SELECT_ACTION] as const),
      });
    },
  );
  if (new Set(items.map((item) => JSON.stringify(item))).size !== items.length)
    invalid();
  return Object.freeze({
    version: PLUGIN_UI_RECOVERY_VERSION,
    publications: Object.freeze(items),
  });
}
function dense(
  input: unknown,
  limits: Readonly<{ minimum: number; maximum: number }>,
): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < limits.minimum ||
    input.length > limits.maximum ||
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
  return pluginControlFail("desktop_project_history_configuration_invalid");
}
