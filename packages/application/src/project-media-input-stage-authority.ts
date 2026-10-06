import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
  type PluginSelection,
  type InstalledPluginPackage,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ProjectToolInstallationPin } from "./creative-project-run-commit-authority.ts";
import {
  projectAssetAuthorityDenied,
  projectAssetAuthorityFields,
  projectAssetInstallationEvidence,
} from "./project-asset-qualification-data.ts";

/** Host-only contract; its issuer must check independent publication and real Node declarations before issuing it. */
export type ProjectMediaInputStageCommitAuthority = Readonly<{
  version: "crewon.project-media-input-stage-commit.v1";
  actor: ActorContext;
  installation: ProjectToolInstallationPin;
  pin: PluginTaskAdmissionPin;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export function captureProjectMediaInputStageAuthority(
  input: unknown,
): ProjectMediaInputStageCommitAuthority {
  const v = projectAssetAuthorityFields(input, [
    "version",
    "actor",
    "installation",
    "pin",
    "selection",
    "package",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
  ]);
  if (
    v.version !== "crewon.project-media-input-stage-commit.v1" ||
    typeof v.assertCurrent !== "function" ||
    typeof v.assertTransactionCurrent !== "function" ||
    typeof v.assertActive !== "function"
  )
    projectAssetAuthorityDenied();
  const evidence = projectAssetInstallationEvidence(v),
    pin = parsePluginTaskAdmissionPin(v.pin);
  if (
    pin.action !== "project.execute" ||
    pin.contributionId !== "workbench" ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (key) => pin[key] !== evidence.actor[key],
    ) ||
    (
      Object.keys(evidence.installation) as (keyof ProjectToolInstallationPin)[]
    ).some((key) => pin[key] !== evidence.installation[key])
  )
    projectAssetAuthorityDenied();
  return Object.freeze({
    version: "crewon.project-media-input-stage-commit.v1",
    ...evidence,
    pin,
    assertCurrent: async () => {
      if (
        (await (v.assertCurrent as () => Promise<unknown>).call(input)) !==
        undefined
      )
        projectAssetAuthorityDenied();
    },
    assertTransactionCurrent: async () => {
      if (
        (await (v.assertTransactionCurrent as () => Promise<unknown>).call(
          input,
        )) !== undefined
      )
        projectAssetAuthorityDenied();
    },
    assertActive: () => {
      if ((v.assertActive as () => unknown).call(input) !== undefined)
        projectAssetAuthorityDenied();
    },
  });
}
export function assertProjectMediaInputStageActor(
  actor: ActorContext,
  q: ProjectMediaInputStageCommitAuthority,
): void {
  if (extensionCanonicalJson(actor) !== extensionCanonicalJson(q.actor))
    projectAssetAuthorityDenied();
  q.assertActive();
}
