import {
  CreativeProjectApplicationService,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectStore,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
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
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  captureProjectGenerationPluginConfiguration,
  type ProjectGenerationPluginConfiguration,
} from "./project-generation-plugin-configuration.ts";
import {
  captureProjectGenerationReadConfiguration,
  prepareProjectGenerationReadStore,
  type ProjectGenerationReadConfiguration,
  type ProjectGenerationReadStore,
} from "./project-generation-read-composition.ts";

/** Explicit trusted host authority; local project management does not grant paid execution. */
export type CreativeProjectCompositionConfig = Readonly<{
  authorization: CreativeProjectAuthorizationPort;
  pluginUi?: CreativeProjectPluginUiConfig;
  pluginGenerations?: ProjectGenerationPluginConfiguration;
  generationReads?: ProjectGenerationReadConfiguration;
}>;

export type PreparedCreativeProjects = {
  readonly service: CreativeProjectApplicationService;
  readonly pluginUi?: CreativeProjectPluginUiConfig;
  readonly generationReads?: ProjectGenerationReadConfiguration;
  readonly generationReadStore?: ProjectGenerationReadStore;
  readonly pluginGenerations?: ProjectGenerationPluginConfiguration &
    Readonly<{
      store: CreativeProjectStore;
      authorization: CreativeProjectAuthorizationPort;
    }>;
  /** Composition owns auxiliary resources; the creator still owns the parent Store. */
  failureCleanup?: Promise<void>;
};

type CreativeProjectStoreOwner = Readonly<{
  creativeProjectStore(): CreativeProjectStore & { migrate(): Promise<void> };
  extensionStore?(): ProjectGenerationReadStore;
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
        key !== "pluginUi" &&
        key !== "pluginGenerations" &&
        key !== "generationReads",
    ) ||
    !Object.hasOwn(fields, "authorization") ||
    !Object.hasOwn(fields.authorization!, "value")
  )
    throw new Error("creative_project_configuration_invalid");
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
  const readsField = fields.generationReads;
  if (
    readsField !== undefined &&
    (!Object.hasOwn(readsField, "value") || !readsField.enumerable)
  )
    throw new Error("creative_project_configuration_invalid");
  const generationReads = captureProjectGenerationReadConfiguration(
    readsField?.value,
  );
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
        ...(pluginUi === undefined ? {} : { pluginUi }),
        ...(pluginGenerations === undefined ? {} : { pluginGenerations }),
        ...(generationReads === undefined ? {} : { generationReads }),
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
  return configuration;
}

/** Only an explicit opt-in touches the project adapter or its independent migration. */
export async function prepareCreativeProjects(
  owner: CreativeProjectStoreOwner,
  configuration: CreativeProjectCompositionConfig | undefined,
): Promise<PreparedCreativeProjects | undefined> {
  if (configuration === undefined) return undefined;
  // The paid composition performs its own explicit writer migration later.
  const generationReadStore =
    configuration.generationReads !== undefined &&
    configuration.pluginGenerations === undefined
      ? await prepareProjectGenerationReadStore(owner)
      : undefined;
  const store = owner.creativeProjectStore();
  await store.migrate();
  return {
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
