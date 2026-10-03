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

/** Explicit trusted host authority; local project management does not grant paid execution. */
export type CreativeProjectCompositionConfig = Readonly<{
  authorization: CreativeProjectAuthorizationPort;
}>;

export type PreparedCreativeProjects = {
  readonly service: CreativeProjectApplicationService;
  /** Composition owns auxiliary resources; the creator still owns the parent Store. */
  failureCleanup?: Promise<void>;
};

type CreativeProjectStoreOwner = Readonly<{
  creativeProjectStore(): CreativeProjectStore & { migrate(): Promise<void> };
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
    Reflect.ownKeys(input).length !== 1 ||
    !Object.hasOwn(fields, "authorization") ||
    !Object.hasOwn(fields.authorization!, "value")
  )
    throw new Error("creative_project_configuration_invalid");
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
      });
    }
    target = Object.getPrototypeOf(target);
  }
  throw new Error("creative_project_authorization_required");
}

/** Only an explicit opt-in touches the project adapter or its independent migration. */
export async function prepareCreativeProjects(
  owner: CreativeProjectStoreOwner,
  configuration: CreativeProjectCompositionConfig | undefined,
): Promise<PreparedCreativeProjects | undefined> {
  if (configuration === undefined) return undefined;
  const store = owner.creativeProjectStore();
  await store.migrate();
  return {
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
