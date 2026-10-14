import { ApplicationError } from "./application-error.ts";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
} from "./plugin-project-read-scope.ts";
import type { ProjectAssetApplicationDependencies } from "./project-asset-application-service.ts";
import type { CreativeProjectReadStore } from "./creative-project-store-port.ts";
import type { ProjectTextStore } from "./project-text-store-port.ts";
import type { ProjectAssetStore } from "./project-asset-store-port.ts";
import {
  isProjectAssetV2Action,
  isProjectAssetV2MutationAction,
} from "@crewon/contracts/project-assets-v2";

function binder<T>(port: object) {
  let value: object | null = port;
  for (
    let depth = 0;
    value && depth < 32;
    depth++, value = Object.getPrototypeOf(value)
  ) {
    const field = Object.getOwnPropertyDescriptor(value, "bindProjectReads");
    if (!field) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      denied();
    return field.value.bind(port) as (scope: PluginProjectReadScope) => T;
  }
  return undefined;
}

/** Capture the original manager's readers once; a read facade cannot lend its
 * own receipts or writers to the independent asset commit.
 */
export function captureAssetRunStoreView(
  raw: ProjectAssetApplicationDependencies,
  captured: ProjectAssetApplicationDependencies,
) {
  return captureAssetScopedStoreView(raw, captured, "run-mutation");
}

export function captureAssetUiReadStoreView(
  raw: ProjectAssetApplicationDependencies,
  captured: ProjectAssetApplicationDependencies,
) {
  return captureAssetScopedStoreView(raw, captured, "ui-read");
}

export function captureAssetRunReadStoreView(
  raw: ProjectAssetApplicationDependencies,
  captured: ProjectAssetApplicationDependencies,
) {
  return captureAssetScopedStoreView(raw, captured, "run-read");
}

function captureAssetScopedStoreView(
  raw: ProjectAssetApplicationDependencies,
  captured: ProjectAssetApplicationDependencies,
  purpose: "run-mutation" | "ui-read" | "run-read",
) {
  const projects = binder<CreativeProjectReadStore>(raw.projects);
  const texts = binder<ProjectTextStore>(raw.texts);
  const assets = binder<ProjectAssetStore>(raw.store);
  return async (
    scope: PluginProjectReadScope,
  ): Promise<ProjectAssetApplicationDependencies | null> => {
    const source = qualifyPluginProjectReadScope(scope);
    const q = source.assetRunMutationAuthority;
    if (source.purpose !== "read" || !("projectId" in source.request.input))
      denied();
    const projectId = source.request.input.projectId;
    if (purpose === "run-mutation") {
      if (
        !q ||
        source.request.action !== "crewon.project-asset-run-mutation-read.v1" ||
        projectId !== q.assetStageAdmission.projectId
      )
        denied();
    } else if (purpose === "run-read") {
      if (
        !source.assetRunReadAuthority ||
        source.request.action !== "crewon.project-asset-run-read.v1" ||
        source.assetRunReadAuthority.assetStageAdmission.projectId !== projectId
      )
        denied();
    } else if (
      !isProjectAssetV2Action(source.request.action) ||
      isProjectAssetV2MutationAction(source.request.action) ||
      source.request.action.endsWith(".adoptMediaReference")
    )
      denied();
    await source.assertCurrent();
    source.assertActive();
    const ordinary = await captured.projects.loadProject({
      owner: {
        tenantId: source.scope.tenantId,
        spaceId: source.scope.spaceId,
        principalId: source.scope.principalId,
      },
      projectId,
    });
    await source.assertCurrent();
    source.assertActive();
    if (ordinary !== null) return null;
    if (!projects || !texts || !assets) denied();
    const readOnlyDenied = async (): Promise<never> => {
      throw new ApplicationError(
        "authorization",
        "project_asset_ui_read_cannot_mutate",
      );
    };
    return {
      ...captured,
      projects: projects(scope),
      texts: texts(scope),
      store: Object.freeze({
        ...assets(scope),
        loadMutationReceipt:
          purpose === "run-mutation"
            ? captured.store.loadMutationReceipt
            : readOnlyDenied,
        commitMutation:
          purpose === "run-mutation"
            ? captured.store.commitMutation
            : readOnlyDenied,
      }),
    };
  };
}

function denied(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_asset_run_store_binding_unavailable",
  );
}
