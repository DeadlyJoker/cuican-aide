import {
  type ActorContext,
  type CreativeProjectCommitAuthority,
  type CreativeProjectMutationKind,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import type { QualifiedPluginInstallation } from "./plugin-installation-pin-store-support.ts";

const mutationActions: Readonly<Record<CreativeProjectMutationKind, string>> =
  Object.freeze({
    "create-project": "crewon.creative-projects.v1.createProject",
    "rename-project": "crewon.creative-projects.v1.renameProject",
    "set-project-state": "crewon.creative-projects.v1.setProjectState",
    "append-brief": "crewon.creative-projects.v1.appendBrief",
    "create-concept": "crewon.creative-projects.v1.createConcept",
    "append-concept": "crewon.creative-projects.v1.appendConceptRevision",
  });

/** The captured Host pin may qualify this exact metadata actor/action; it never supplies a payer. */
export function creativeProjectPluginCommitQualification(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: CreativeProjectMutationKind,
):
  | (QualifiedPluginInstallation & Readonly<{ pin: PluginTaskAdmissionPin }>)
  | undefined {
  if (authority?.transaction === undefined) return undefined;
  const pin = parsePluginTaskAdmissionPin(authority.transaction.pin);
  if (
    authority.transaction.version !==
      "crewon.creative-project-plugin-commit.v1" ||
    pin.tenantId !== actor.tenantId ||
    pin.spaceId !== actor.spaceId ||
    pin.principalId !== actor.principalId ||
    pin.actorId !== actor.actorId ||
    pin.action !== mutationActions[kind]
  )
    throw new Error("creative_project_plugin_commit_pin_mismatch");
  return Object.freeze({
    pin,
    selection: parsePluginSelection(authority.transaction.selection),
    package: parseInstalledPluginPackage(authority.transaction.package),
  });
}

/** Essential pin fields alone do not preserve the captured original audit/installation snapshot. */
export function assertCreativeProjectPluginCommitSelection(
  expected: QualifiedPluginInstallation,
  actual: QualifiedPluginInstallation,
): void {
  if (
    extensionCanonicalJson(expected.selection) !==
      extensionCanonicalJson(actual.selection) ||
    extensionCanonicalJson(expected.package) !==
      extensionCanonicalJson(actual.package)
  )
    throw new Error("creative_project_plugin_commit_selection_mismatch");
}
