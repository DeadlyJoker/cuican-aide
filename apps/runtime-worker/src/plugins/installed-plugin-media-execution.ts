import { types } from "node:util";
import { MEDIA_GENERATION_ACTION } from "@crewon/application";
import type { PluginTaskAdmission } from "@crewon/domain";
import type { PluginHostService } from "@crewon/plugin-host";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import {
  SqliteExternalOperationStore,
  PostgresExternalOperationStore,
} from "@crewon/store";
import { ProjectMediaRunContext } from "../project-media-run-context.ts";
import { ProjectMediaExecutionBoundary } from "../project-media-execution-boundary.ts";
import {
  captureProjectMediaExecutionReview,
  MAX_PROJECT_MEDIA_EXECUTION_REVIEWS,
  mediaExecutionFail as fail,
  type ProjectMediaExecutionReview,
} from "../project-media-execution-review.ts";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunSnapshot,
} from "./installed-plugin-run-context.ts";
import { PluginExecutionIoOwner } from "./plugin-execution-io.ts";
import {
  CREWON_PROJECT_MEDIA_EXECUTION_SERVICE,
  CREWON_PROJECT_MEDIA_EXECUTION_API_VERSION,
  type PluginProjectMediaExecutionService,
} from "@crewon/contracts/project-media-execution";

export const PROJECT_MEDIA_EXECUTION_SERVICE =
  CREWON_PROJECT_MEDIA_EXECUTION_SERVICE;
export const PROJECT_MEDIA_EXECUTION_API_VERSION =
  CREWON_PROJECT_MEDIA_EXECUTION_API_VERSION;
/** Host composition only. The exact original native operation instance is explicitly opted in. */
export type InstalledPluginMediaExecutionDependencies = Readonly<{
  contexts: ProjectMediaRunContext;
  operations: SqliteExternalOperationStore | PostgresExternalOperationStore;
  reviews: readonly ProjectMediaExecutionReview[];
}>;
export function captureInstalledPluginMediaExecution(
  input: InstalledPluginMediaExecutionDependencies,
) {
  if (
    !(input.contexts instanceof ProjectMediaRunContext) ||
    !(
      input.operations instanceof SqliteExternalOperationStore ||
      input.operations instanceof PostgresExternalOperationStore
    ) ||
    [input.contexts, input.operations].some((v) => types.isProxy(v)) ||
    !Array.isArray(input.reviews) ||
    types.isProxy(input.reviews) ||
    !input.reviews.length ||
    input.reviews.length > MAX_PROJECT_MEDIA_EXECUTION_REVIEWS
  )
    fail("dependency_invalid");
  return Object.freeze({
    contexts: input.contexts,
    operations: input.operations,
    reviews: Object.freeze(
      input.reviews.map(captureProjectMediaExecutionReview),
    ),
  });
}
export function createInstalledPluginMediaBoundary(
  input: Readonly<{
    dependencies: InstalledPluginMediaExecutionDependencies | undefined;
    installed: InstalledPluginRunContext;
    snapshot: InstalledPluginRunSnapshot;
    admission: PluginTaskAdmission;
  }>,
): ProjectMediaExecutionBoundary | null {
  if (
    input.admission.pluginId !== "crewon.short-drama" ||
    input.admission.action !== MEDIA_GENERATION_ACTION
  )
    return null;
  if (!input.dependencies) fail("unavailable");
  return new ProjectMediaExecutionBoundary({
    installed: input.installed,
    snapshot: input.snapshot,
    media: input.dependencies.contexts,
    operations: input.dependencies.operations,
    reviews: input.dependencies.reviews,
  });
}
/** Setup receives a declared bridge, not input data or an execution grant. Calls need an active IO invocation. */
export function installedPluginMediaHostService(
  input: Readonly<{
    context: PluginToolRuntimeContext;
    io(): PluginExecutionIoOwner | null;
    assertActive(): void;
  }>,
): PluginHostService {
  let live = true;
  const value = Object.freeze({
    readInput: (request: Readonly<{ command: unknown }>) => {
      input.assertActive();
      if (!live) fail("unavailable");
      const io = input.io();
      if (!(io instanceof PluginExecutionIoOwner) || types.isProxy(io))
        fail("unavailable");
      return PluginExecutionIoOwner.prototype.readProjectMediaInput.call(
        io,
        request as Parameters<
          PluginExecutionIoOwner["readProjectMediaInput"]
        >[0],
      );
    },
    readOperation: (request: Readonly<{ command: unknown }>) => {
      input.assertActive();
      if (!live) fail("unavailable");
      const io = input.io();
      if (!(io instanceof PluginExecutionIoOwner) || types.isProxy(io))
        fail("unavailable");
      return PluginExecutionIoOwner.prototype.readProjectMediaOperation.call(
        io,
        request,
      );
    },
  } satisfies PluginProjectMediaExecutionService);
  return Object.freeze({
    service: PROJECT_MEDIA_EXECUTION_SERVICE,
    apiVersion: PROJECT_MEDIA_EXECUTION_API_VERSION,
    value,
    bindForPlugin: (identity, lifetime) => {
      input.assertActive();
      if (
        !live ||
        (["pluginId", "version", "packageDigest"] as const).some(
          (k) => identity[k] !== input.context.identity[k],
        )
      )
        fail("scope_invalid");
      lifetime.onDispose(async () => {
        live = false;
        await input.io()?.close();
      });
      return value;
    },
  });
}
