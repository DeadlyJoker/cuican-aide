import { types } from "node:util";
import {
  captureProjectMediaInputAuthorization,
  materialPreparationFields,
  projectMediaInputBound,
  type ExtensionStore,
  type ProjectMediaInputAuthorizationPort,
} from "@crewon/application";
import {
  SqliteRunStore,
  PostgresDomainStore,
  SqliteExtensionStore,
  PostgresExtensionStore,
  type SqliteExternalOperationStore,
  type PostgresExternalOperationStore,
} from "@crewon/store";
import { ProjectMediaMaterialPreparer } from "../project-media-material-preparer.ts";
import {
  ProjectMediaRunContext,
  type ProjectMediaRunAuthorizationPort,
} from "../project-media-run-context.ts";
import {
  captureProjectMediaExecutionReview,
  type ProjectMediaExecutionReview,
} from "../project-media-execution-review.ts";
import type { InstalledPluginRunContext } from "./installed-plugin-run-context.ts";
import type { InstalledPluginMediaExecutionDependencies } from "./installed-plugin-media-execution.ts";

type Parent = SqliteRunStore | PostgresDomainStore;
/** Trusted host factory, invoked with the actual composition's parent. Never a plugin or serialized UI field. */
export type InstalledPluginProjectMediaConfig = Readonly<{
  version: "crewon.project-media-worker.v1";
  createMaterials(
    input: Readonly<{ store: Parent; signal: AbortSignal }>,
  ): Promise<
    Readonly<{
      materials: ProjectMediaMaterialPreparer;
      /** Joins only factory-owned resources; the parent Store remains borrowed. */
      close(): Promise<void>;
    }>
  >;
  metadataAuthorization: ProjectMediaInputAuthorizationPort;
  authorization: ProjectMediaRunAuthorizationPort;
  reviews: readonly ProjectMediaExecutionReview[];
}>;
const captured = new WeakMap<object, InstalledPluginProjectMediaConfig>();
export function captureInstalledPluginProjectMediaConfig(
  input: InstalledPluginProjectMediaConfig,
): InstalledPluginProjectMediaConfig {
  const previous = captured.get(input);
  if (previous) return previous;
  const fields = materialPreparationFields(input, [
    "version",
    "createMaterials",
    "metadataAuthorization",
    "authorization",
    "reviews",
  ]);
  if (
    fields.version !== "crewon.project-media-worker.v1" ||
    !Array.isArray(fields.reviews) ||
    types.isProxy(fields.reviews) ||
    !fields.reviews.length ||
    fields.reviews.length > 32
  )
    fail("configuration_invalid");
  const value = Object.freeze({
    version: "crewon.project-media-worker.v1" as const,
    createMaterials: projectMediaInputBound<
      InstalledPluginProjectMediaConfig["createMaterials"]
    >(input, "createMaterials"),
    metadataAuthorization: captureProjectMediaInputAuthorization(
      input.metadataAuthorization,
    ),
    authorization: Object.freeze({
      authorize: projectMediaInputBound<
        ProjectMediaRunAuthorizationPort["authorize"]
      >(input.authorization, "authorize"),
      assertActive: projectMediaInputBound<
        ProjectMediaRunAuthorizationPort["assertActive"]
      >(input.authorization, "assertActive"),
    }),
    reviews: Object.freeze(
      fields.reviews.map(captureProjectMediaExecutionReview),
    ),
  });
  captured.set(input, value);
  captured.set(value, value);
  return value;
}
/** An opaque startup receipt. A copied value cannot substitute for the actual native preparation. */
export type PreparedInstalledPluginProjectMedia = Readonly<{
  version: "crewon.prepared-project-media-worker.v1";
  close(): Promise<void>;
}>;
type Prepared = Readonly<{
  store: Parent;
  extensions: SqliteExtensionStore | PostgresExtensionStore;
  operations: SqliteExternalOperationStore | PostgresExternalOperationStore;
  config: InstalledPluginProjectMediaConfig;
  materials: ProjectMediaMaterialPreparer;
  assertOpen(): void;
}>;
const preparedOwners = new WeakMap<
  PreparedInstalledPluginProjectMedia,
  Prepared
>();
export async function prepareInstalledPluginProjectMedia(
  input: Readonly<{
    store: Parent;
    extensions: ExtensionStore;
    config: InstalledPluginProjectMediaConfig;
    signal: AbortSignal;
  }>,
): Promise<PreparedInstalledPluginProjectMedia> {
  const config = captureInstalledPluginProjectMediaConfig(input.config),
    { store, extensions, signal } = input;
  if (
    types.isProxy(store) ||
    types.isProxy(extensions) ||
    !(
      (store instanceof SqliteRunStore &&
        extensions instanceof SqliteExtensionStore) ||
      (store instanceof PostgresDomainStore &&
        extensions instanceof PostgresExtensionStore)
    )
  )
    fail("dependency_invalid");
  signal.throwIfAborted();
  // The Control-side media input/source schemas must already exist. Missing or corrupt history fails closed.
  await extensions.migrateProjectMediaGenerations();
  signal.throwIfAborted();
  const operations = store.externalOperationStore();
  await operations.migrate();
  signal.throwIfAborted();
  await operations.migrateProjectMediaOperations();
  signal.throwIfAborted();
  const owner = await config.createMaterials({ store, signal });
  let close: (() => Promise<void>) | undefined;
  try {
    close = projectMediaInputBound<() => Promise<void>>(owner, "close");
    const fields = materialPreparationFields(owner, ["materials", "close"]);
    if (
      !(fields.materials instanceof ProjectMediaMaterialPreparer) ||
      types.isProxy(fields.materials)
    )
      fail("materials_invalid");
    signal.throwIfAborted();
    let closed = false,
      closing: Promise<void> | null = null;
    const release = close;
    const receipt = Object.freeze({
      version: "crewon.prepared-project-media-worker.v1" as const,
      close: () => {
        closed = true;
        if (!closing) {
          closing = Promise.resolve().then(release);
          void closing.catch(() => {
            closing = null;
          });
        }
        return closing;
      },
    });
    preparedOwners.set(
      receipt,
      Object.freeze({
        store,
        extensions,
        operations,
        config,
        materials: fields.materials,
        assertOpen: () => {
          if (closed) fail("closed");
        },
      }),
    );
    return receipt;
  } catch (error) {
    try {
      await close?.();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "installed_plugin_media_startup_cleanup_failed",
      );
    }
    throw error;
  }
}
export function preparedInstalledPluginMediaOwner(
  input: Readonly<{
    prepared: PreparedInstalledPluginProjectMedia | undefined;
    store: Parent;
    extensions: ExtensionStore;
    config: InstalledPluginProjectMediaConfig;
  }>,
): Prepared {
  const owner = input.prepared && preparedOwners.get(input.prepared);
  if (
    !owner ||
    owner.store !== input.store ||
    owner.extensions !== input.extensions ||
    owner.config !== captureInstalledPluginProjectMediaConfig(input.config)
  )
    fail("preparation_required");
  owner.assertOpen();
  return owner;
}
export function composeInstalledPluginProjectMedia(
  input: Readonly<{
    prepared: Prepared;
    installed: InstalledPluginRunContext;
  }>,
): InstalledPluginMediaExecutionDependencies {
  const p = input.prepared;
  p.assertOpen();
  return Object.freeze({
    contexts: new ProjectMediaRunContext({
      installed: input.installed,
      extensions: p.extensions,
      materials: p.materials,
      metadataAuthorization: p.config.metadataAuthorization,
      authorization: p.config.authorization,
    }),
    operations: p.operations,
    reviews: p.config.reviews,
  });
}
function fail(code: string): never {
  throw new Error(`installed_plugin_media_${code}`);
}
