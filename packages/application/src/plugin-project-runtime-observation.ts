import {
  extensionCanonicalJson,
  parsePluginTaskAdmission,
  parseExtensionRunBinding,
  parseProjectStageRunAdmission,
  parsePluginProjectWorkspaceOwnerScope,
  validateCreativeProjectActor,
  type ProjectStageRunAdmission,
  type PluginTaskAdmission,
  type ExtensionRunBinding,
  type PluginProjectWorkspaceOwnerScope,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import { ApplicationError } from "./application-error.ts";
import {
  projectAssetAuthorityFields as fields,
  projectAssetAuthorityCopy as copy,
} from "./project-asset-qualification-data.ts";
import { projectToolAuthorityContentDigest } from "./creative-project-run-commit-authority.ts";
declare const observationBrand: unique symbol;
/** Only private runtime paired metadata; neither Tool scope nor an artifact/body read grant. */
export type PluginProjectRuntimeObservation = Readonly<{
  [observationBrand]: true;
}>;
export type PluginProjectRuntimeObservationAuthority = Readonly<{
  version: "crewon.plugin-project-runtime-observation.v1";
  actor: ActorContext;
  admission: PluginTaskAdmission;
  binding: ExtensionRunBinding;
  stage: ProjectStageRunAdmission;
  purpose: "submit" | "observe";
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
type Source = Readonly<
  Omit<PluginProjectRuntimeObservationAuthority, "version"> & {
    owner: PluginProjectWorkspaceOwnerScope;
  }
>;
const issued = new WeakMap<object, Source>();
const sha = { sha256: projectToolAuthorityContentDigest };
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_runtime_observation_invalid",
  );
}
/** Trusted backend only, after original activation/installation/actor PDP succeeds. */
export async function issuePluginProjectRuntimeObservation(
  input: PluginProjectRuntimeObservationAuthority,
): Promise<PluginProjectRuntimeObservation> {
  const v = fields(input, [
    "version",
    "actor",
    "admission",
    "binding",
    "stage",
    "purpose",
    "assertCurrent",
    "assertActive",
  ]);
  if (
    v.version !== "crewon.plugin-project-runtime-observation.v1" ||
    !["submit", "observe"].includes(v.purpose as string) ||
    typeof v.assertCurrent !== "function" ||
    typeof v.assertActive !== "function"
  )
    denied();
  const actor = validateCreativeProjectActor(copy(v.actor));
  const admission = parsePluginTaskAdmission(copy(v.admission));
  const binding = parseExtensionRunBinding(copy(v.binding), sha);
  const stage = parseProjectStageRunAdmission(copy(v.stage), sha);
  if (
    admission.action !== "project.execute" ||
    stage.stage.kind !== "discussion" ||
    binding.source !== null ||
    stage.runId !== binding.runId ||
    stage.threadId !== binding.threadId ||
    stage.extensionBindingDigest !== binding.bindingDigest ||
    admission.extensionBindingDigest !== binding.bindingDigest ||
    stage.pluginTaskAdmissionDigest !==
      sha.sha256(extensionCanonicalJson(admission)) ||
    stage.taskInputDigest !==
      sha.sha256(
        extensionCanonicalJson({
          stage: stage.stage,
          sources: stage.sources,
          userContentDigest: binding.inputDigest,
        }),
      ) ||
    stage.userContentDigest !== binding.inputDigest ||
    stage.requestDigest !== admission.requestDigest ||
    stage.idempotencyKey !== admission.idempotencyKey ||
    admission.runId !== binding.runId ||
    admission.threadId !== binding.threadId ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (k) => actor[k] !== admission[k] || actor[k] !== stage.actor[k],
    ) ||
    (
      [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
      ] as const
    ).some((k) => stage.installation[k] !== admission[k]) ||
    binding.tenantId !== actor.tenantId ||
    binding.spaceId !== actor.spaceId ||
    binding.actorId !== actor.actorId ||
    binding.pluginId !== admission.pluginId
  )
    denied();
  const active = v.assertActive.bind(input);
  const current = v.assertCurrent.bind(input);
  const assertActive = () => {
    if (active() !== undefined) denied();
  };
  const assertCurrent = async () => {
    assertActive();
    if ((await current()) !== undefined) denied();
    assertActive();
  };
  await assertCurrent();
  const ref = Object.freeze(
    Object.create(null),
  ) as PluginProjectRuntimeObservation;
  issued.set(
    ref,
    Object.freeze({
      actor,
      admission,
      binding,
      stage,
      purpose: v.purpose as "submit" | "observe",
      owner: parsePluginProjectWorkspaceOwnerScope({
        ...actor,
        profileId: admission.profileId,
        pluginId: admission.pluginId,
        publisherId: admission.publisherId,
      }),
      assertActive,
      assertCurrent,
    }),
  );
  return ref;
}
export function qualifyPluginProjectRuntimeObservation(
  ref: PluginProjectRuntimeObservation,
): Source {
  const source =
    ref !== null && typeof ref === "object" ? issued.get(ref) : undefined;
  if (source === undefined) denied();
  source.assertActive();
  return source;
}
