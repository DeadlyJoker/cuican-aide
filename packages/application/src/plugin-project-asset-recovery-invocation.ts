import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { projectAssetRecoveryContext } from "./plugin-project-asset-recovery-context.ts";
import {
  captureProjectAssetRecoveryCommitTransaction,
  type ProjectAssetRecoveryCommitTransactionAuthority,
} from "./project-asset-recovery-commit-authority.ts";

type Registration = Readonly<{
  snapshot: ReturnType<typeof projectAssetRecoveryContext>;
  current(): Promise<void>;
  transaction(): Promise<void>;
  active(): void;
}>;
const registrations = new WeakMap<object, Registration>();
/** Private real PluginUiApplicationService registration; absent from the public package entrypoint. */
export function registerPluginProjectAssetRecoveryInvocation(
  context: PluginUiActionContext,
  current: () => Promise<void>,
  transaction: () => Promise<void>,
  active: () => void,
): () => void {
  if (
    registrations.has(context) ||
    typeof current !== "function" ||
    typeof transaction !== "function" ||
    typeof active !== "function"
  )
    invalid();
  const base = capturePluginUiInvocationCommitAuthority(context);
  if (base.transaction !== undefined) invalid();
  const snapshot = projectAssetRecoveryContext(context);
  const registration: Registration = Object.freeze({
    snapshot,
    current,
    transaction,
    active,
  });
  registrations.set(context, registration);
  return () => {
    if (registrations.get(context) === registration)
      registrations.delete(context);
  };
}
export function capturePluginProjectAssetRecoveryInvocationCommitAuthority(
  context: PluginUiActionContext,
): Readonly<{
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
  recoveryTransaction: ProjectAssetRecoveryCommitTransactionAuthority;
}> {
  // Membership precedes getters or caller fields. Copies cannot acquire this capability.
  const registered =
    context !== null && typeof context === "object"
      ? registrations.get(context)
      : undefined;
  if (registered === undefined) unavailable();
  const base = capturePluginUiInvocationCommitAuthority(context);
  const active = () => {
    if (
      registrations.get(context) !== registered ||
      projectAssetRecoveryContext(context).fingerprint !==
        registered.snapshot.fingerprint
    )
      unavailable();
    base.assertActive();
    if (registered.active() !== undefined) invalid();
  };
  active();
  const transaction = async () => {
    active();
    if ((await registered.transaction()) !== undefined) invalid();
    active();
  };
  const snapshot = registered.snapshot;
  return Object.freeze({
    assertActive: active,
    assertCurrent: async () => {
      active();
      if ((await registered.current()) !== undefined) invalid();
      active();
    },
    assertTransactionCurrent: transaction,
    recoveryTransaction: captureProjectAssetRecoveryCommitTransaction({
      version: "crewon.project-asset-recovery-commit.v1",
      actor: snapshot.context.actor,
      installation: snapshot.installation,
      contributionId: snapshot.context.lease.contributionId,
      actionId: snapshot.request.action,
      input: snapshot.request.input,
      selection: snapshot.context.selection,
      package: snapshot.context.package,
      assertCurrent: transaction,
    }),
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_asset_recovery_invocation_unavailable",
  );
}
function invalid(): never {
  throw new ApplicationError(
    "internal",
    "plugin_project_asset_recovery_invocation_invalid",
  );
}
