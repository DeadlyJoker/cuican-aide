import { parseProjectOutlineEditRequest } from "@crewon/contracts/project-outline-edits";
import { parseProjectToolInstallationPin } from "./creative-project-run-commit-authority.ts";
import { captureProjectOutlineUiCommitTransaction } from "./project-outline-ui-commit-authority.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import {
  uiActor,
  uiEpoch,
  uiPackage,
  uiProfile,
  uiPublicLease,
  uiRecord,
  uiSelection,
} from "./plugin-ui-application-support.ts";
import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

export function projectOutlineEditActionContext(input: PluginUiActionContext) {
  const fields = uiRecord(input, [
      "actor",
      "scope",
      "selection",
      "package",
      "lease",
      "authorityEpoch",
      "action",
      "input",
    ]),
    actor = uiActor(fields.actor as PluginUiActionContext["actor"]),
    scope = uiProfile(fields.scope, actor),
    lease = uiPublicLease(fields.lease),
    selection = uiSelection(fields.selection, scope, lease.descriptor.pluginId),
    pkg = uiPackage(fields.package, scope, selection),
    request = parseProjectOutlineEditRequest({
      action: fields.action,
      input: fields.input,
    });
  if (
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    pkg.packageDigest !== lease.packageDigest ||
    pkg.version !== lease.descriptor.version ||
    pkg.publisherId !== lease.descriptor.publisherId
  )
    unavailable();
  const context = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch: uiEpoch(fields.authorityEpoch),
    action: request.action,
    input: request.input,
  }) as PluginUiActionContext;
  const installation = parseProjectToolInstallationPin({
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    profileId: scope.profileId,
    pluginId: lease.descriptor.pluginId,
    publisherId: lease.descriptor.publisherId,
    version: pkg.version,
    packageDigest: pkg.packageDigest,
    selectionRevision: selection.revision,
  });
  return Object.freeze({
    context,
    request,
    installation,
    fingerprint: JSON.stringify(context),
  });
}
type Registration = Readonly<{
  snapshot: ReturnType<typeof projectOutlineEditActionContext>;
  transactionCurrent(): Promise<void>;
}>;
const registrations = new WeakMap<object, Registration>();
/** Private issuer, deliberately absent from the package entrypoint, joined to the original invoke lifecycle. */
export function registerPluginProjectOutlineEditInvocation(
  context: PluginUiActionContext,
  transactionCurrent: () => Promise<void>,
): () => void {
  if (registrations.has(context) || typeof transactionCurrent !== "function")
    unavailable();
  const base = capturePluginUiInvocationCommitAuthority(context);
  if (base.transaction !== undefined) unavailable();
  const registration = Object.freeze({
    snapshot: projectOutlineEditActionContext(context),
    transactionCurrent,
  });
  registrations.set(context, registration);
  return () => {
    if (registrations.get(context) === registration)
      registrations.delete(context);
  };
}
export function capturePluginProjectOutlineEditInvocation(
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
      projectOutlineEditActionContext(context).fingerprint !==
        registration.snapshot.fingerprint
    )
      unavailable();
  };
  const assertCurrent = async () => {
    assertActive();
    await base.assertCurrent();
    assertActive();
  };
  const transactionCurrent = async () => {
    assertActive();
    if ((await registration.transactionCurrent()) !== undefined) unavailable();
    assertActive();
  };
  assertActive();
  const snapshot = registration.snapshot;
  const transaction = captureProjectOutlineUiCommitTransaction({
    version: "crewon.project-outline-plugin-commit.v2",
    actor: snapshot.context.actor,
    installation: snapshot.installation,
    actionId: snapshot.request.action,
    input: snapshot.request.input,
    selection: snapshot.context.selection,
    package: snapshot.context.package,
    assertCurrent: transactionCurrent,
  });
  return Object.freeze({
    snapshot,
    assertActive,
    assertCurrent,
    outlineUiTransaction: transaction,
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_outline_edit_invocation_unavailable",
  );
}
