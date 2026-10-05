import {
  CreativeProjectApplicationService,
  ProjectTextApplicationService,
  type ProjectTextStore,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectStore,
} from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type {
  StandaloneControlApiConfig,
  StandaloneControlApiRuntime,
} from "./standalone-composition.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";
import {
  captureProjectTextPluginUiConfig,
  type ProjectTextPluginUiConfig,
} from "./project-text-plugin-ui-composition.ts";
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
  prepareProjectGenerationReadStore,
  type ProjectGenerationReadConfiguration,
  type ProjectGenerationReadStore,
} from "./project-generation-read-composition.ts";
import {
  captureProjectGenerationReadPluginUiConfig,
  type ProjectGenerationReadPluginUiConfig,
} from "./project-generation-read-plugin-ui-composition.ts";
import {
  captureProjectGenerationSelectionConfiguration,
  prepareProjectGenerationSelectionStore,
  type ProjectGenerationSelectionConfiguration,
  type ProjectGenerationSelectionStore,
  type ProjectGenerationSelectionStoreOwner,
} from "./project-generation-selection-composition.ts";

/** Explicit trusted host authority; local project management does not grant paid execution. */
export type CreativeProjectCompositionConfig = Readonly<{
  authorization: CreativeProjectAuthorizationPort;
  textArtifacts?: Readonly<{ version: "crewon.project-text.v1" }>;
  textUi?: ProjectTextPluginUiConfig;
  pluginUi?: CreativeProjectPluginUiConfig;
  pluginGenerations?: ProjectGenerationPluginConfiguration;
  pluginQueries?: ProjectQueryPluginConfiguration;
  generationReads?: ProjectGenerationReadConfiguration;
  generationReadUi?: ProjectGenerationReadPluginUiConfig;
  resultSelections?: ProjectGenerationSelectionConfiguration;
  selectionUi?: CreativeProjectPluginUiConfig;
}>;

export type PreparedCreativeProjects = {
  readonly service: CreativeProjectApplicationService;
  readonly textService?: ProjectTextApplicationService;
  readonly textUi?: ProjectTextPluginUiConfig;
  readonly pluginUi?: CreativeProjectPluginUiConfig;
  readonly generationReads?: ProjectGenerationReadConfiguration;
  readonly generationReadUi?: ProjectGenerationReadPluginUiConfig;
  readonly generationReadStore?: ProjectGenerationReadStore;
  readonly selectionUi?: CreativeProjectPluginUiConfig;
  readonly resultSelections?: ProjectGenerationSelectionConfiguration &
    Readonly<{
      store: ProjectGenerationSelectionStore;
      projects: Readonly<{
        store: CreativeProjectStore;
        authorization: CreativeProjectAuthorizationPort;
      }>;
    }>;
  readonly pluginGenerations?: ProjectGenerationPluginConfiguration &
    Readonly<{
      store: CreativeProjectStore;
      authorization: CreativeProjectAuthorizationPort;
    }>;
  readonly pluginQueries?: ProjectQueryPluginConfiguration &
    Readonly<{
      store: CreativeProjectStore;
      authorization: CreativeProjectAuthorizationPort;
    }>;
  /** Composition owns auxiliary resources; the creator still owns the parent Store. */
  failureCleanup?: Promise<void>;
};

type CreativeProjectStoreOwner = Readonly<{
  creativeProjectStore(): CreativeProjectStore & { migrate(): Promise<void> };
  projectTextStore?(): ProjectTextStore & { migrate(): Promise<void> };
  extensionStore?(): ProjectGenerationReadStore;
  projectConceptSelectionStore?: ProjectGenerationSelectionStoreOwner["projectConceptSelectionStore"];
}>;

/** Capture the borrowed method before asynchronous startup without changing the caller. */
export function captureCreativeProjectCompositionConfig(
  input: unknown,
): CreativeProjectCompositionConfig | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("creative_project_configuration_invalid");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).some(
      (key) =>
        key !== "authorization" &&
        key !== "textArtifacts" &&
        key !== "textUi" &&
        key !== "pluginUi" &&
        key !== "pluginGenerations" &&
        key !== "pluginQueries" &&
        key !== "generationReads" &&
        key !== "generationReadUi" &&
        key !== "resultSelections" &&
        key !== "selectionUi",
    ) ||
    !Object.hasOwn(fields, "authorization") ||
    !Object.hasOwn(fields.authorization!, "value")
  )
    throw new Error("creative_project_configuration_invalid");
  let textArtifacts: CreativeProjectCompositionConfig["textArtifacts"];
  const textField = fields.textArtifacts;
  if (textField !== undefined) {
    if (!Object.hasOwn(textField, "value") || !textField.enumerable)
      throw new Error("creative_project_configuration_invalid");
    const input = textField.value;
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    )
      throw new Error("project_text_configuration_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(input).length !== 1 ||
      !Object.hasOwn(descriptors, "version") ||
      !Object.hasOwn(descriptors.version!, "value") ||
      !descriptors.version!.enumerable ||
      descriptors.version!.value !== "crewon.project-text.v1"
    )
      throw new Error("project_text_configuration_invalid");
    textArtifacts = Object.freeze({ version: "crewon.project-text.v1" });
  }
  const textUiField = fields.textUi;
  if (
    textUiField !== undefined &&
    (!Object.hasOwn(textUiField, "value") || !textUiField.enumerable)
  )
    throw new Error("creative_project_configuration_invalid");
  const textUi = captureProjectTextPluginUiConfig(textUiField?.value);
  if (textUi !== undefined && textArtifacts === undefined)
    throw new Error("project_text_plugin_ui_store_required");
  const pluginUiField = fields.pluginUi;
  if (
    pluginUiField !== undefined &&
    (!Object.hasOwn(pluginUiField, "value") || !pluginUiField.enumerable)
  )
    throw new Error("creative_project_configuration_invalid");
  const pluginUi = captureCreativeProjectPluginUiConfig(pluginUiField?.value);
  const generationsField = fields.pluginGenerations;
  if (
    generationsField !== undefined &&
    (!Object.hasOwn(generationsField, "value") || !generationsField.enumerable)
  )
    throw new Error("creative_project_configuration_invalid");
  const pluginGenerations = captureProjectGenerationPluginConfiguration(
    generationsField?.value,
  );
  const queriesField = fields.pluginQueries;
  if (
    queriesField !== undefined &&
    (!Object.hasOwn(queriesField, "value") || !queriesField.enumerable)
  )
    throw new Error("creative_project_configuration_invalid");
  const pluginQueries = captureProjectQueryPluginConfiguration(
    queriesField?.value,
  );
  const readsField = fields.generationReads;
  if (
    readsField !== undefined &&
    (!Object.hasOwn(readsField, "value") || !readsField.enumerable)
  )
    throw new Error("creative_project_configuration_invalid");
  const generationReads = captureProjectGenerationReadConfiguration(
    readsField?.value,
  );
  if (pluginQueries !== undefined && generationReads === undefined)
    throw new Error("project_query_generation_reader_required");
  const readUiField = fields.generationReadUi;
  if (
    readUiField !== undefined &&
    (!Object.hasOwn(readUiField, "value") || !readUiField.enumerable)
  )
    throw new Error("creative_project_configuration_invalid");
  const generationReadUi = captureProjectGenerationReadPluginUiConfig(
    readUiField?.value,
  );
  if (generationReadUi !== undefined && generationReads === undefined)
    throw new Error("project_generation_read_ui_reader_required");
  for (const key of ["resultSelections", "selectionUi"] as const) {
    const field = fields[key];
    if (
      field !== undefined &&
      (!Object.hasOwn(field, "value") || !field.enumerable)
    )
      throw new Error("creative_project_configuration_invalid");
  }
  const resultSelections = captureProjectGenerationSelectionConfiguration(
    fields.resultSelections?.value,
  );
  const selectionUi = captureCreativeProjectPluginUiConfig(
    fields.selectionUi?.value,
  );
  if (resultSelections !== undefined && generationReads === undefined)
    throw new Error("project_generation_selection_reader_required");
  if (selectionUi !== undefined && resultSelections === undefined)
    throw new Error("project_generation_selection_ui_store_required");
  const port = fields.authorization!.value as
    | CreativeProjectAuthorizationPort
    | null
    | undefined;
  if (port === null || typeof port !== "object")
    throw new Error("creative_project_authorization_required");
  let target: object | null = port;
  for (let depth = 0; target !== null && depth < 32; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "authorize");
    if (descriptor !== undefined) {
      if (
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "function"
      )
        throw new Error("creative_project_authorization_required");
      return Object.freeze({
        authorization: Object.freeze({
          authorize: descriptor.value.bind(port),
        }),
        ...(textArtifacts === undefined ? {} : { textArtifacts }),
        ...(textUi === undefined ? {} : { textUi }),
        ...(pluginUi === undefined ? {} : { pluginUi }),
        ...(pluginGenerations === undefined ? {} : { pluginGenerations }),
        ...(pluginQueries === undefined ? {} : { pluginQueries }),
        ...(generationReads === undefined ? {} : { generationReads }),
        ...(generationReadUi === undefined ? {} : { generationReadUi }),
        ...(resultSelections === undefined ? {} : { resultSelections }),
        ...(selectionUi === undefined ? {} : { selectionUi }),
      });
    }
    target = Object.getPrototypeOf(target);
  }
  throw new Error("creative_project_authorization_required");
}

/** Local management has no verified personal paid execution authority. */
export function captureStandaloneCreativeProjectCompositionConfig(
  input: unknown,
): CreativeProjectCompositionConfig | undefined {
  const configuration = captureCreativeProjectCompositionConfig(input);
  if (configuration?.pluginGenerations !== undefined)
    throw new Error(
      "standalone_project_generation_execution_authority_required",
    );
  if (configuration?.pluginQueries !== undefined)
    throw new Error("standalone_project_query_execution_authority_required");
  return configuration;
}

/** Only an explicit opt-in touches the project adapter or its independent migration. */
export async function prepareCreativeProjects(
  owner: CreativeProjectStoreOwner,
  configuration: CreativeProjectCompositionConfig | undefined,
  options: Readonly<{ financialMode: "metered" | "unmetered" }> = {
    financialMode: "metered",
  },
): Promise<PreparedCreativeProjects | undefined> {
  if (configuration === undefined) return undefined;
  // Paid composition issues its own read/writer adapters after establishing the
  // actual source schemas; history-only composition never creates those schemas.
  const generationReadStore =
    configuration.generationReads !== undefined &&
    configuration.pluginGenerations === undefined
      ? await prepareProjectGenerationReadStore(owner)
      : undefined;
  const store = owner.creativeProjectStore();
  await store.migrate();
  let textService: ProjectTextApplicationService | undefined;
  if (configuration.textArtifacts !== undefined) {
    if (owner.projectTextStore === undefined)
      throw new Error("project_text_composition_required");
    const texts = owner.projectTextStore();
    await texts.migrate();
    textService = new ProjectTextApplicationService({
      store: texts,
      projects: store,
      authorization: configuration.authorization,
      clock: new SystemApplicationClock(),
      ids: new UuidV7ApplicationIdGenerator(),
      digester: new NodeSha256ContentDigester(),
    });
  }
  if (
    configuration.pluginGenerations !== undefined &&
    configuration.resultSelections !== undefined
  ) {
    if (
      !(owner instanceof SqliteRunStore) &&
      !(owner instanceof PostgresDomainStore)
    )
      throw new Error("project_generation_selection_composition_required");
    // A fresh paid composition must establish the real source schemas before
    // selection migration. The later core still enables its own writer adapter.
    await owner.pluginInstallationStore().migrate();
    const extensions = owner.extensionStore();
    await extensions.migrate();
    await extensions.migratePluginAdmissions();
    if (options.financialMode === "unmetered") {
      await extensions.migrateUnmeteredPluginAdmissions();
    } else {
      await extensions.migrateCredits();
    }
    await extensions.migrateProjectGenerations();
  }
  const selectionStore =
    configuration.resultSelections === undefined
      ? undefined
      : await prepareProjectGenerationSelectionStore(
          {
            projectConceptSelectionStore: (input) => {
              if (owner.projectConceptSelectionStore === undefined)
                throw new Error(
                  "project_generation_selection_composition_required",
                );
              return owner.projectConceptSelectionStore(input);
            },
          },
          configuration.resultSelections,
        );
  return {
    ...(textService === undefined ? {} : { textService }),
    ...(configuration.textUi === undefined
      ? {}
      : { textUi: configuration.textUi }),
    ...(configuration.selectionUi === undefined
      ? {}
      : { selectionUi: configuration.selectionUi }),
    ...(configuration.resultSelections === undefined ||
    selectionStore === undefined
      ? {}
      : {
          resultSelections: Object.freeze({
            ...configuration.resultSelections,
            store: selectionStore,
            projects: Object.freeze({
              store,
              authorization: configuration.authorization,
            }),
          }),
        }),
    ...(configuration.pluginQueries === undefined
      ? {}
      : {
          pluginQueries: Object.freeze({
            ...configuration.pluginQueries,
            store,
            authorization: configuration.authorization,
          }),
        }),
    ...(configuration.generationReadUi === undefined
      ? {}
      : { generationReadUi: configuration.generationReadUi }),
    ...(configuration.generationReads === undefined
      ? {}
      : { generationReads: configuration.generationReads }),
    ...(generationReadStore === undefined ? {} : { generationReadStore }),
    ...(configuration.pluginUi === undefined
      ? {}
      : { pluginUi: configuration.pluginUi }),
    ...(configuration.pluginGenerations === undefined
      ? {}
      : {
          pluginGenerations: Object.freeze({
            ...configuration.pluginGenerations,
            store,
            authorization: configuration.authorization,
          }),
        }),
    service: new CreativeProjectApplicationService({
      store,
      authorization: configuration.authorization,
      clock: new SystemApplicationClock(),
      ids: new UuidV7ApplicationIdGenerator(),
      digester: new NodeSha256ContentDigester(),
    }),
  };
}

/** Project startup owns the parent Store once; its prepared service borrows that lifetime. */
export async function composeStandaloneCreativeProjects(input: {
  config: StandaloneControlApiConfig & {
    creativeProjects: CreativeProjectCompositionConfig;
  };
  compose(prepared: {
    store: SqliteRunStore;
    config: StandaloneControlApiConfig;
    projects: PreparedCreativeProjects;
  }): StandaloneControlApiRuntime;
}): Promise<StandaloneControlApiRuntime> {
  const config = input.config;
  if (config.creativeProjects === undefined)
    throw new Error("creative_project_configuration_invalid");
  captureStandaloneCreativeProjectCompositionConfig(config.creativeProjects);
  const store = new SqliteRunStore(config.databasePath);
  let projects: PreparedCreativeProjects | undefined;
  try {
    projects = await prepareCreativeProjects(store, config.creativeProjects);
    if (projects === undefined)
      throw new Error("creative_project_configuration_invalid");
    return input.compose({
      store,
      config: {
        ...config,
        localStoragePaths: [
          config.databasePath,
          ...(config.localStoragePaths ?? []),
        ],
      },
      projects,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    for (const close of [
      () => projects?.failureCleanup ?? config.artifactStore.close(),
      () => store.close(),
    ]) {
      try {
        await close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "creative_project_startup_cleanup_failed",
      );
    throw error;
  }
}
