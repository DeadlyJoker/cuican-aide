import { ApplicationError } from "./application-error.ts";
import { assertPluginTaskRunSnapshot } from "./plugin-task-run-storage-proof.ts";
import {
  projectAssetAuthorityFields as fields,
  projectAssetAuthorityCopy as copy,
} from "./project-asset-qualification-data.ts";
import { projectToolAuthorityContentDigest } from "./creative-project-run-commit-authority.ts";
import {
  parsePluginTaskAdmission,
  parseExtensionRunBinding,
  parsePluginProjectWorkspaceOwnerScope,
  validateCreativeProjectActor,
  type PluginTaskAdmission,
  type ExtensionRunBinding,
  type RunState,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ExtensionMutationReceipt } from "./extension-store-port.ts";

declare const observationBrand: unique symbol;
/** Host startup metadata only. This reference is neither a Tool lease nor a verified receipt. */
export type ProjectAssetRuntimeReadObservation = Readonly<{
  [observationBrand]: true;
}>;
export type ProjectAssetRuntimeReadObservationAuthority = Readonly<{
  version: "crewon.project-asset-runtime-read-observation.v1";
  actor: ActorContext;
  admission: PluginTaskAdmission;
  binding: ExtensionRunBinding;
  run: RunState;
  /** Pending locator derived from the actual admitted task. SQL verifies the real receipt before returning a body. */
  receipt: ExtensionMutationReceipt;
  purpose: "submit" | "observe";
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
type Source = Readonly<
  Omit<ProjectAssetRuntimeReadObservationAuthority, "version"> & {
    owner: ReturnType<typeof parsePluginProjectWorkspaceOwnerScope>;
  }
>;
const issued = new WeakMap<object, Source>();
const sha = { sha256: projectToolAuthorityContentDigest };
/** Only the original InstalledPluginRunContextReader issues after activation, current installed selection and actor PDP. */
export async function issueProjectAssetRuntimeReadObservation(
  input: ProjectAssetRuntimeReadObservationAuthority,
): Promise<ProjectAssetRuntimeReadObservation> {
  const v = fields(input, [
    "version",
    "actor",
    "admission",
    "binding",
    "run",
    "receipt",
    "purpose",
    "assertCurrent",
    "assertActive",
  ]);
  if (
    v.version !== "crewon.project-asset-runtime-read-observation.v1" ||
    !["submit", "observe"].includes(v.purpose as string) ||
    typeof v.assertCurrent !== "function" ||
    typeof v.assertActive !== "function"
  )
    denied();
  const actor = validateCreativeProjectActor(copy(v.actor)),
    admission = parsePluginTaskAdmission(copy(v.admission)),
    binding = parseExtensionRunBinding(copy(v.binding), sha),
    run = copy(v.run) as RunState;
  const receipt = fields(copy(v.receipt), [
    "actorId",
    "idempotencyKey",
    "requestDigest",
  ]) as ExtensionMutationReceipt;
  if (
    admission.action !== "project.execute" ||
    binding.source !== null ||
    admission.runId !== binding.runId ||
    admission.threadId !== binding.threadId ||
    admission.extensionBindingDigest !== binding.bindingDigest ||
    binding.tenantId !== actor.tenantId ||
    binding.spaceId !== actor.spaceId ||
    binding.actorId !== actor.actorId ||
    binding.pluginId !== admission.pluginId ||
    receipt.actorId !== actor.actorId ||
    receipt.idempotencyKey !== admission.idempotencyKey ||
    receipt.requestDigest !== admission.requestDigest ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (k) => actor[k] !== admission[k],
    )
  )
    denied();
  assertPluginTaskRunSnapshot(run, binding, run, denied);
  const active = v.assertActive.bind(input),
    current = v.assertCurrent.bind(input);
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
  ) as ProjectAssetRuntimeReadObservation;
  issued.set(
    ref,
    Object.freeze({
      actor,
      admission,
      binding,
      run,
      receipt: Object.freeze({ ...receipt }),
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
export function qualifyProjectAssetRuntimeReadObservation(
  ref: ProjectAssetRuntimeReadObservation,
): Source {
  const source =
    ref !== null && typeof ref === "object" ? issued.get(ref) : undefined;
  if (source === undefined) denied();
  source.assertActive();
  return source;
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_asset_runtime_read_observation_invalid",
  );
}
