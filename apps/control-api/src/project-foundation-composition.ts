import {
  ProjectFoundationApplicationService,
  ProjectSourceUploadApplicationService,
  ProjectSourceUploadFoundationAdapter,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectStore,
  type ProjectFoundationStore,
  type ProjectSourceUploadAuthorizationPort,
  type ProjectSourceUploadStore,
} from "@crewon/application";
import { ProjectSourceUploadPreparationAdapter } from "@crewon/media-runtime";
import { v7 as uuidv7 } from "uuid";
import {
  captureProjectFoundationPluginUiConfig,
  type ProjectFoundationPluginUiConfig,
} from "./project-foundation-plugin-ui-composition.ts";
import {
  captureProjectSourceUploadPluginUiConfig,
  type ProjectSourceUploadPluginUiConfig,
} from "./project-source-upload-plugin-ui-composition.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";

export type ProjectFoundationCompositionConfig = Readonly<{
  version: "crewon.project-foundation.v1";
  pluginUi?: ProjectFoundationPluginUiConfig;
  uploads: Readonly<{
    version: "crewon.project-source-uploads.v1";
    pluginUi?: ProjectSourceUploadPluginUiConfig;
    authorization: ProjectSourceUploadAuthorizationPort;
  }>;
}>;
/** JSON deployment opt-in contains publications only; it cannot supply a policy or preparation pointer. */
export type ProjectFoundationStartupConfiguration = Readonly<{
  version: "crewon.project-foundation.v1";
  pluginUi?: ProjectFoundationPluginUiConfig;
  uploads: Readonly<{
    version: "crewon.project-source-uploads.v1";
    pluginUi?: ProjectSourceUploadPluginUiConfig;
  }>;
}>;
export type PreparedProjectFoundation = Readonly<{
  service: ProjectFoundationApplicationService;
  uploads: ProjectSourceUploadApplicationService;
  pluginUi?: ProjectFoundationPluginUiConfig;
  uploadUi?: ProjectSourceUploadPluginUiConfig;
}>;
export type ProjectFoundationStoreOwner = Readonly<{
  projectFoundationStore?(): ProjectFoundationStore & {
    migrate(): Promise<void>;
  };
  projectSourceUploadStore?(): ProjectSourceUploadStore & {
    migrate(): Promise<void>;
  };
}>;

export function captureProjectFoundationStartupConfiguration(
  input: unknown,
): ProjectFoundationStartupConfiguration | undefined {
  if (input === undefined) return undefined;
  const value = foundationConfiguration(input);
  const uploads = uploadConfiguration(value.uploads, ["version"]);
  if (uploads.version !== "crewon.project-source-uploads.v1") invalid();
  return Object.freeze({
    version: "crewon.project-foundation.v1",
    ...(value.pluginUi === undefined
      ? {}
      : { pluginUi: captureProjectFoundationPluginUiConfig(value.pluginUi)! }),
    uploads: Object.freeze({
      version: "crewon.project-source-uploads.v1",
      ...(uploads.pluginUi === undefined
        ? {}
        : {
            pluginUi: captureProjectSourceUploadPluginUiConfig(
              uploads.pluginUi,
            )!,
          }),
    }),
  });
}

/** Capture the original independent upload PDP before awaited migration, including synchronous withdrawal. */
export function captureProjectFoundationCompositionConfig(
  input: unknown,
): ProjectFoundationCompositionConfig | undefined {
  if (input === undefined) return undefined;
  const value = foundationConfiguration(input);
  const uploads = uploadConfiguration(value.uploads, [
    "version",
    "authorization",
  ]);
  if (uploads.version !== "crewon.project-source-uploads.v1") invalid();
  const port = uploads.authorization;
  const authorization: ProjectSourceUploadAuthorizationPort = Object.freeze({
    authorize: captureMethod(port, "authorize"),
    assertActive: captureMethod(port, "assertActive"),
  });
  return Object.freeze({
    version: "crewon.project-foundation.v1",
    ...(value.pluginUi === undefined
      ? {}
      : { pluginUi: captureProjectFoundationPluginUiConfig(value.pluginUi)! }),
    uploads: Object.freeze({
      version: "crewon.project-source-uploads.v1",
      ...(uploads.pluginUi === undefined
        ? {}
        : {
            pluginUi: captureProjectSourceUploadPluginUiConfig(
              uploads.pluginUi,
            )!,
          }),
      authorization,
    }),
  });
}

/** Borrow the original parent Store and lifetime. Only explicit configuration migrates these schemas. */
export async function prepareProjectFoundation(
  owner: ProjectFoundationStoreOwner,
  input: Readonly<{
    configuration: ProjectFoundationCompositionConfig | undefined;
    projects: CreativeProjectStore;
    authorization: CreativeProjectAuthorizationPort;
  }>,
): Promise<PreparedProjectFoundation | undefined> {
  const configuration = captureProjectFoundationCompositionConfig(
    input.configuration,
  );
  if (configuration === undefined) return undefined;
  if (
    owner.projectFoundationStore === undefined ||
    owner.projectSourceUploadStore === undefined
  )
    throw new Error("project_foundation_composition_required");
  // No legacy sourceAdmission override: the database must verify a genuine durable upload association.
  const store = owner.projectFoundationStore();
  const uploadStore = owner.projectSourceUploadStore();
  await uploadStore.migrate();
  await store.migrate();
  const parser = new ProjectSourceUploadPreparationAdapter();
  const clock = new SystemApplicationClock();
  const ids = new UuidV7ApplicationIdGenerator();
  const digester = new NodeSha256ContentDigester();
  const uploads = new ProjectSourceUploadApplicationService({
    store: uploadStore,
    authorization: configuration.uploads.authorization,
    bytes: parser,
    parser,
    clock,
    digester,
    ids: { nextUploadId: () => uuidv7(), nextClaimId: () => uuidv7() },
    preparationClaimTtlMs: 60_000,
  });
  const service = new ProjectFoundationApplicationService({
    projects: input.projects,
    store,
    sourcePreparation: new ProjectSourceUploadFoundationAdapter(uploads),
    authorization: input.authorization,
    clock,
    ids,
    digester,
  });
  return Object.freeze({
    service,
    uploads,
    ...(configuration.pluginUi === undefined
      ? {}
      : { pluginUi: configuration.pluginUi }),
    ...(configuration.uploads.pluginUi === undefined
      ? {}
      : { uploadUi: configuration.uploads.pluginUi }),
  });
}

function uploadConfiguration(input: unknown, required: readonly string[]) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid();
  return pluginSecurityRecord(input, [
    ...required,
    ...(Reflect.ownKeys(input).includes("pluginUi") ? ["pluginUi"] : []),
  ]);
}

function foundationConfiguration(input: unknown) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid();
  const fields = Reflect.ownKeys(input);
  const value = pluginSecurityRecord(input, [
    "version",
    "uploads",
    ...(fields.includes("pluginUi") ? ["pluginUi"] : []),
  ]);
  if (value.version !== "crewon.project-foundation.v1") invalid();
  return value;
}
function captureMethod<
  Method extends keyof ProjectSourceUploadAuthorizationPort,
>(input: unknown, name: Method): ProjectSourceUploadAuthorizationPort[Method] {
  if (input === null || typeof input !== "object") invalid();
  let target: object | null = input;
  for (let depth = 0; target !== null && depth < 32; depth++) {
    const own = Object.getOwnPropertyDescriptor(target, name);
    if (own !== undefined) {
      if (!Object.hasOwn(own, "value") || typeof own.value !== "function")
        invalid();
      return Function.prototype.bind.call(
        own.value,
        input,
      ) as ProjectSourceUploadAuthorizationPort[Method];
    }
    target = Object.getPrototypeOf(target);
  }
  return invalid();
}
function invalid(): never {
  throw new Error("project_foundation_configuration_invalid");
}
