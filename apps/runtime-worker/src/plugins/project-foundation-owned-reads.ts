import {
  assertProjectFoundationRunFoundation,
  extensionCanonicalJson,
  type ProjectFoundationRunAdmission,
} from "@crewon/domain";
import {
  foundationOwnerDigester as sha,
  foundationOwnerDenied as denied,
} from "./project-foundation-owner-support.ts";
import {
  ApplicationError,
  isProjectFoundationApplicationService,
  qualifyPluginProjectReadScope,
  ProjectFoundationApplicationService,
  type ActorContext,
  type PluginProjectReadScope,
} from "@crewon/application";
import {
  issuePluginProjectFoundationRunReadScope,
  type ProjectFoundationRunReadAuthority,
} from "@crewon/application/host-project-workspaces";
import type { ProjectFoundationToolsServiceOwnerDependencies } from "./project-foundation-tools-service-owner.ts";
/** Only the original owner supplies checked dispatch evidence and lifetime. */
export async function prepareFoundationToolOwnedReads(
  input: Readonly<{
    dependencies: ProjectFoundationToolsServiceOwnerDependencies;
    evidence: Omit<
      ProjectFoundationRunReadAuthority,
      "version" | "assertCurrent"
    >;
    assertCurrent(): Promise<void>;
    assertActive(): void;
  }>,
): Promise<
  Readonly<{
    service: ProjectFoundationApplicationService;
    scope?: PluginProjectReadScope;
  }>
> {
  const d = input.dependencies;
  if (d.projectOwnership === undefined) return { service: d.foundations };
  if (d.projectOwnership !== "plugin-project-v1" || d.readService === undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_project_foundation_read_binding_unavailable",
    );
  const scope = await issuePluginProjectFoundationRunReadScope({
    authority: {
      ...input.evidence,
      version: "crewon.project-foundation-run-read.v1",
      assertCurrent: input.assertCurrent,
    },
    assertActive: input.assertActive,
  });
  const service = d.readService(scope);
  if (!isProjectFoundationApplicationService(service))
    throw new ApplicationError(
      "authorization",
      "plugin_project_foundation_read_service_invalid",
    );
  return { service, scope };
}

/** Legacy identity is checked by the owner; scoped identity is checked by the original Store on every read. */
export async function qualifyFoundationToolRead(
  input: Readonly<{
    actor: ActorContext;
    service: ProjectFoundationApplicationService;
    scope: PluginProjectReadScope | undefined;
    foundation: ProjectFoundationRunAdmission;
    assertLegacyIdentity(): Promise<void>;
    assertActive(): void;
  }>,
) {
  if (input.scope === undefined) await input.assertLegacyIdentity();
  else {
    const source = qualifyPluginProjectReadScope(input.scope);
    if (
      source.foundationRunAuthority === undefined ||
      source.purpose !== "read" ||
      extensionCanonicalJson(
        source.foundationRunAuthority.foundationAdmission,
      ) !== extensionCanonicalJson(input.foundation)
    )
      denied();
  }
  const foundation =
    await ProjectFoundationApplicationService.prototype.getFoundation.call(
      input.service,
      input.actor,
      { projectId: input.foundation.projectId },
    );
  if (foundation === null) denied();
  assertProjectFoundationRunFoundation(input.foundation, foundation, sha);
  input.assertActive();
  return foundation;
}
