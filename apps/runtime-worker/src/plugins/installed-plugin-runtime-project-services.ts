import type { PluginActivationCandidate } from "@crewon/plugin-host";
import type { InstalledPluginRuntimeResolverDependencies } from "./installed-plugin-runtime-resolver.ts";
import type { InstalledPluginRuntimePrepared } from "./installed-plugin-runtime-resident.ts";
import {
  createInstalledPluginProjectServices,
  type InstalledPluginProjectServices,
} from "./installed-plugin-project-services.ts";

/** Borrow only the resolver's genuine private snapshot and original service dependencies. */
export function createInstalledPluginRuntimeProjectServices(
  input: Readonly<{
    dependencies: Pick<
      InstalledPluginRuntimeResolverDependencies,
      | "contexts"
      | "projectTools"
      | "projectMediaInputs"
      | "projectFoundationTools"
      | "projectOutlineTools"
      | "authorizePackage"
    >;
    prepared: InstalledPluginRuntimePrepared;
    candidate(): PluginActivationCandidate | null;
    authorizeCurrent: Parameters<
      typeof createInstalledPluginProjectServices
    >[0]["authorizeCurrent"];
    assertActive(): void;
  }>,
): InstalledPluginProjectServices | null {
  const d = input.dependencies,
    p = input.prepared,
    c = d.contexts;
  return createInstalledPluginProjectServices({
    mediaInputDependencies: d.projectMediaInputs,
    mediaInputStage: c.verifiedProjectMediaInputStage(p.snapshot),
    foundationDependencies: d.projectFoundationTools,
    outlineDependencies: d.projectOutlineTools,
    foundationAdmission: c.verifiedProjectFoundation(p.snapshot),
    dependencies: d.projectTools,
    context: p.snapshot.context,
    assetStageAdmission: c.verifiedProjectAssetStage(p.snapshot),
    stageAdmission: c.verifiedProjectStage(p.snapshot),
    planAdmission: c.verifiedProjectTextPlan(p.snapshot),
    admission: p.admission,
    tools: p.proof.registration.manifest.tools,
    authorizeCurrent: input.authorizeCurrent,
    candidate: input.candidate,
    scope: p.scope,
    authorizePackage: d.authorizePackage,
    assertActive: input.assertActive,
  });
}
