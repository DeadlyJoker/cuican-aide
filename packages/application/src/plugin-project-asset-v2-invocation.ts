import {
  isProjectAssetRecoveryV2Action,
  parseProjectAssetRecoveryV2Request,
} from "@crewon/contracts/project-asset-recovery-v2";
import {
  parseProjectAssetV2Request,
  isProjectAssetV2MutationAction,
} from "@crewon/contracts/project-assets-v2";
import { projectAssetActionContextUsing } from "./plugin-project-asset-action-context.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { captureProjectAssetUiCommitTransaction } from "./project-asset-ui-commit-authority.ts";
import { projectMediaResultAssertVoid } from "./project-media-result-record.ts";
import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

export const projectAssetV2ActionContext = (context: PluginUiActionContext) =>
  projectAssetActionContextUsing(context, (request) =>
    isProjectAssetRecoveryV2Action(context.action)
      ? parseProjectAssetRecoveryV2Request(request)
      : parseProjectAssetV2Request(request),
  );
type Registration = Readonly<{
  snapshot: ReturnType<typeof projectAssetV2ActionContext>;
  transaction(): Promise<void>;
}>;
const registrations = new WeakMap<object, Registration>();
/** Private original PluginUiApplicationService registration; never exported at the package entrypoint. */
export function registerPluginProjectAssetV2Invocation(
  context: PluginUiActionContext,
  transaction: () => Promise<void>,
): () => void {
  if (registrations.has(context) || typeof transaction !== "function")
    unavailable();
  capturePluginUiInvocationCommitAuthority(context);
  const registration = Object.freeze({
    snapshot: projectAssetV2ActionContext(context),
    transaction,
  });
  registrations.set(context, registration);
  return () => {
    if (registrations.get(context) === registration)
      registrations.delete(context);
  };
}
export function capturePluginProjectAssetV2Invocation(
  context: PluginUiActionContext,
) {
  const registration =
    context !== null && typeof context === "object"
      ? registrations.get(context)
      : undefined;
  if (!registration) unavailable();
  const base = capturePluginUiInvocationCommitAuthority(context);
  const assertActive = () => {
    base.assertActive();
    if (
      registrations.get(context) !== registration ||
      projectAssetV2ActionContext(context).fingerprint !==
        registration.snapshot.fingerprint
    )
      unavailable();
  };
  const assertTransactionCurrent = async () => {
    assertActive();
    projectMediaResultAssertVoid(await registration.transaction());
    assertActive();
  };
  assertActive();
  const snapshot = registration.snapshot;
  return Object.freeze({
    snapshot,
    assertActive,
    assertCurrent: async () => {
      assertActive();
      await base.assertCurrent();
      assertActive();
    },
    assertTransactionCurrent,
    ...(isProjectAssetV2MutationAction(snapshot.request.action)
      ? {
          uiTransaction: captureProjectAssetUiCommitTransaction({
            version: "crewon.project-asset-plugin-commit.v2",
            actor: snapshot.context.actor,
            installation: snapshot.installation,
            contributionId: snapshot.context.lease.contributionId,
            actionId: snapshot.request.action,
            input: snapshot.request.input,
            selection: snapshot.context.selection,
            package: snapshot.context.package,
            assertCurrent: assertTransactionCurrent,
          }),
        }
      : {}),
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_asset_v2_invocation_unavailable",
  );
}
