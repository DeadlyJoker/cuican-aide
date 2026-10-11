import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  validateCreativeProjectActor,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type PluginQueryTaskAdmission,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { PluginTaskCommitAuthorityPort } from "./extension-plugin-task-support.ts";
import type { CommitExtensionTurnOptions } from "./extension-store-port.ts";

declare const preparedBrand: unique symbol;
/** Negative Host fence only. It never replaces installation, funding or admission checks. */
export type PreparedPluginTaskCommitAuthority = Readonly<{
  [preparedBrand]: true;
}>;
type Captured = Readonly<{
  actor: ActorContext;
  pin: PluginTaskAdmissionPin;
  assertActive(): void;
}>;
const issued = new WeakMap<object, Captured>();

/** Application-private issuer; intentionally absent from the package entrypoint. */
export function pluginTaskCommitOptions(
  authority: PluginTaskCommitAuthorityPort | null,
  actorInput: ActorContext,
  pinInput: PluginTaskAdmissionPin | null,
  options: CommitExtensionTurnOptions | undefined,
): CommitExtensionTurnOptions | undefined {
  if (authority?.assertActive === undefined) return options;
  if (pinInput === null) invalid();
  const actor = validateCreativeProjectActor(actorInput),
    pin = parsePluginTaskAdmissionPin(pinInput);
  if (
    ["tenantId", "spaceId", "principalId", "actorId"].some(
      (key) =>
        actor[key as keyof ActorContext] !==
        pin[key as keyof PluginTaskAdmissionPin],
    )
  )
    invalid();
  const active = authority.assertActive.bind(authority);
  const assertActive = () => {
    if (active(Object.freeze({ actor, pin })) !== undefined) invalid();
  };
  assertActive();
  const prepared = Object.freeze(
    Object.create(null),
  ) as PreparedPluginTaskCommitAuthority;
  issued.set(prepared, Object.freeze({ actor, pin, assertActive }));
  return Object.freeze({ ...options, pluginTaskCommitAuthority: prepared });
}

/** Used by the original Store before accepting an opaque option; copies cannot supply a fence. */
export function isPreparedPluginTaskCommitAuthority(
  input: unknown,
): input is PreparedPluginTaskCommitAuthority {
  return input !== null && typeof input === "object" && issued.has(input);
}

/** Synchronous final consumption on the original connection immediately before COMMIT. */
export function assertPluginTaskCommitActive(
  prepared: PreparedPluginTaskCommitAuthority | undefined,
  binding: ExtensionRunBinding,
  admission: PluginTaskAdmission | PluginQueryTaskAdmission | undefined,
): void {
  if (prepared === undefined) return;
  const current = isPreparedPluginTaskCommitAuthority(prepared)
    ? issued.get(prepared)
    : undefined;
  if (
    !current ||
    !admission ||
    admission.runId !== binding.runId ||
    admission.threadId !== binding.threadId ||
    admission.extensionBindingDigest !== binding.bindingDigest ||
    binding.actorId !== current.actor.actorId ||
    binding.tenantId !== current.actor.tenantId ||
    binding.spaceId !== current.actor.spaceId ||
    binding.pluginId !== current.pin.pluginId ||
    Object.keys(current.pin).some(
      (key) =>
        current.pin[key as keyof PluginTaskAdmissionPin] !==
        admission[key as keyof PluginTaskAdmissionPin],
    ) ||
    extensionCanonicalJson(current.actor) !==
      extensionCanonicalJson({
        tenantId: admission.tenantId,
        spaceId: admission.spaceId,
        principalId: admission.principalId,
        actorId: admission.actorId,
      })
  )
    invalid();
  current.assertActive();
}
function invalid(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_task_commit_authority_invalid",
  );
}
