import { isProjectAssetUiMutationAction } from "@crewon/contracts/project-assets";
import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { projectAssetActionContext } from "./plugin-project-asset-action-context.ts";
import {
  captureProjectAssetUiCommitTransaction,
  type ProjectAssetUiCommitTransactionAuthority,
} from "./project-asset-ui-commit-authority.ts";

type Registration = Readonly<{
  snapshot: ReturnType<typeof projectAssetActionContext>;
  current(): Promise<void>;
  transaction(): Promise<void>;
  active(): void;
}>;
const registrations = new WeakMap<object, Registration>();
/** Private real PluginUiApplicationService registration; absent from the public package entrypoint. */
export function registerPluginProjectAssetInvocation(
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
  const snapshot = projectAssetActionContext(context);
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
export function capturePluginProjectAssetInvocationCommitAuthority(
  context: PluginUiActionContext,
): Readonly<{
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
  uiTransaction?: ProjectAssetUiCommitTransactionAuthority;
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
      projectAssetActionContext(context).fingerprint !==
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
      await base.assertCurrent();
      if ((await registered.current()) !== undefined) invalid();
      active();
    },
    assertTransactionCurrent: transaction,
    ...(isProjectAssetUiMutationAction(snapshot.request.action)
      ? {
          uiTransaction: captureProjectAssetUiCommitTransaction({
            version: "crewon.project-asset-plugin-commit.v1",
            actor: snapshot.context.actor,
            installation: snapshot.installation,
            contributionId: snapshot.context.lease.contributionId,
            actionId: snapshot.request.action,
            input: snapshot.request.input,
            selection: snapshot.context.selection,
            package: snapshot.context.package,
            assertCurrent: transaction,
          }),
        }
      : {}),
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_asset_invocation_unavailable",
  );
}
function invalid(): never {
  throw new ApplicationError(
    "internal",
    "plugin_project_asset_invocation_invalid",
  );
}
